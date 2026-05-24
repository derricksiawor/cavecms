import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { rateLimit } from '@/lib/auth/rateLimit'
import { safeRevalidate } from '@/lib/cache/revalidate'
import { tag } from '@/lib/cache/tags'

// "I confirm the new login path loads." Marks the
// security_login_path_pending row as confirmed; getResolvedLoginPath
// then stops auto-reverting.
//
// Auth model: requires the admin session AND CSRF — same gate as
// PATCH /api/admin/settings. NO password reauth required (the
// operator already reauthed when saving the path); this endpoint is
// the second click of a two-step UI flow and the auto-revert window
// is only 10 min, so demanding a fresh password here would create
// friction with no security benefit (the operator already proved
// they hold the session + reauth cookie 5 min ago).
//
// Defence in depth: revalidates the 'settings' tag so the middleware
// security-config cache picks up the confirmed state quickly (the
// pending-clear flow happens in getResolvedLoginPath which is
// already cached via getSetting's 'settings' tag).

interface PendingRow {
  new_path: string
  expires_at: Date | string
  confirmed_at: Date | string | null
  created_by: number | null
}

// Tight per-user rate limit. The shared cmsMutation bucket is too
// generous (300/min) for an endpoint that has only one valid use
// (one confirm per save), and an attacker who has a stolen session
// could time the response branches (already-confirmed vs not-yet)
// to learn whether a change is in flight right now.
const limitConfirm = rateLimit('login-path-confirm:user', { limit: 5, windowSec: 60 })

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  if (!limitConfirm(String(ctx.userId))) {
    throw new HttpError(429, 'too_many_requests')
  }

  const [rows] = (await db.execute(sql`
    SELECT new_path, expires_at, confirmed_at, created_by
    FROM security_login_path_pending
    WHERE id = 1
  `)) as unknown as [PendingRow[]]
  const row = rows[0]
  if (!row) throw new HttpError(404, 'no_pending_change')

  // Same-user check: the operator who SAVED the pending change must
  // be the one who confirms it. Prevents a second admin (or a
  // hijacked session of a different admin) from confirming a path
  // change they didn't initiate. NULL created_by (legacy rows from
  // pre-migration data) falls through to require strict equality
  // failure — operator must roll back or re-save.
  if (row.created_by !== ctx.userId) {
    throw new HttpError(403, 'not_pending_owner')
  }

  // Already confirmed → idempotent OK so a double-click doesn't 4xx.
  if (row.confirmed_at) {
    return new Response(JSON.stringify({ ok: true, alreadyConfirmed: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const exp =
    typeof row.expires_at === 'string'
      ? new Date(row.expires_at).getTime()
      : row.expires_at.getTime()
  if (exp < Date.now()) {
    // Already expired — the auto-revert path in getResolvedLoginPath
    // will clear this row on next read. Surface 410 (Gone) so the
    // operator knows their confirmation came too late.
    throw new HttpError(410, 'confirmation_expired')
  }

  await db.execute(sql`
    UPDATE security_login_path_pending
    SET confirmed_at = NOW(3)
    WHERE id = 1 AND confirmed_at IS NULL
  `)

  // Await safeRevalidate BEFORE constructing the response so the bust
  // lands inside the request context (Next 15 invariant). queueMicrotask
  // would defer it past the response construction with no guarantee
  // the work runs in-context. <1ms cost; removes a fragility.
  await safeRevalidate([tag.settings]).catch(() => undefined)

  return new Response(JSON.stringify({ ok: true, confirmedPath: row.new_path }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
