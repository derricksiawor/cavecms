import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { rateLimit } from '@/lib/auth/rateLimit'
import { signPagePreviewJwt } from '@/lib/auth/jwt'

// POST /api/cms/pages/[id]/preview-token — mint a 15-minute preview JWT.
// Per spec §4.7. Verified by lib/cms/verifyPreviewToken.ts (PR-2) when
// the operator hits /{slug}?preview=:token or /?preview=:token.
//
// Two-axis rate limit (spec): 10 mints/min per (page-id, user) AND
// 30 mints/min total per user. The first axis stops a single page
// spam-burning; the second stops blanket churn across many pages.
// Both buckets consume on each check; either overflow → 429.
//
// CSRF-protected even though this is a state-bearing READ — every
// issuance must come from a fresh CMS session.

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

const limitPerPagePerUser = rateLimit('preview-token:page-user', {
  limit: 10,
  windowSec: 60,
})
const limitPerUserTotal = rateLimit('preview-token:user', {
  limit: 30,
  windowSec: 60,
})

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'pages', 'read')
  checkCmsMutationRate(ctx)

  // Two-axis rate limit. Check the per-(page, user) bucket FIRST so
  // a user spamming many pages still consumes their per-user quota
  // even when the per-(page, user) bucket would have rejected first.
  // Either bucket overflow → 429 rate_limited.
  const perPageKey = `${ctx.userId}:${id}`
  const perUserKey = String(ctx.userId)
  const perPageOk = limitPerPagePerUser(perPageKey)
  const perUserOk = limitPerUserTotal(perUserKey)
  if (!perPageOk || !perUserOk) {
    throw new HttpError(429, 'rate_limited')
  }

  // Page lookup. Snake_case raw row — codebase convention for raw
  // db.execute reads. Soft-deleted pages CANNOT mint tokens (a token
  // for a trashed page can't render anywhere); the deleted_at filter
  // catches that. Unpublished pages CAN — that's the whole point of
  // preview.
  const [rows] = (await db.execute(sql`
    SELECT id, slug, is_home, preview_epoch
    FROM pages
    WHERE id = ${id} AND deleted_at IS NULL
  `)) as unknown as [
    Array<{
      id: number
      slug: string
      is_home: number
      preview_epoch: number
    }>,
  ]
  const p = rows[0]
  if (!p) throw new HttpError(404, 'not_found')

  const { token, exp } = await signPagePreviewJwt(String(ctx.userId), {
    id: p.id,
    epoch: p.preview_epoch,
  })

  // The FE composes the preview URL itself — it already knows the
  // canonical `url_path` from the editor's loaded page row. Returning
  // the bare token (rather than a pre-composed URL) keeps this route
  // ignorant of url_path semantics; if the home row vs non-home URL
  // shape changes again, only the FE needs to update.
  return new Response(
    JSON.stringify({
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
