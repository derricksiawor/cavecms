import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { hashPassword } from '@/lib/auth/scrypt'
import { invalidateUser } from '@/lib/auth/userCache'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'

// Admin sets ANOTHER user's password directly. Per product decision this is a
// PERMANENT password (must_rotate_password stays FALSE) — the target signs in
// with it as-is, no forced rotation. Setting it bumps tokens_valid_after so
// the target's existing sessions die immediately (a password change should
// always evict live sessions).
//
// Guards mirror the sibling user-management routes: admin role + CSRF +
// per-user mutation rate limit + fresh step-up reauth. Self-target is refused
// (an admin changes their OWN password under Settings, with current-password
// verification — this endpoint deliberately does not ask for the target's
// current password because the admin may not know it).

const IdParam = z.coerce.number().int().positive().max(2 ** 31 - 1)

// 12-char floor matches the user-CREATE schema and the rotation endpoint.
const Body = z.object({ password: z.string().min(12).max(200) }).strict()

export const PUT = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    // A programmatic Bearer token must never set a human's password — this is
    // a human-operator action behind the admin UI.
    if (ctx.viaApiToken) throw new HttpError(403, 'forbidden')
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)

    const { id } = await params
    const targetId = IdParam.parse(id)
    if (targetId === ctx.userId) {
      throw new HttpError(409, 'cannot_modify_self')
    }

    const body = Body.parse(await readJsonBody(req))
    const meta = auditMetaFromRequest(req)
    const hash = await hashPassword(body.password)

    // -2s buffer matches the JWT clockTolerance + login/rotate flow so a
    // freshly-issued token for the target (if they log in immediately after)
    // is not caught by the tokens_valid_after revocation check.
    const tva = new Date(Date.now() - 2000)

    const [result] = (await db.execute(sql`
      UPDATE users
      SET password_hash = ${hash},
          must_rotate_password = FALSE,
          password_changed_at = now(3),
          tokens_valid_after = ${tva}
      WHERE id = ${targetId}
    `)) as unknown as [{ affectedRows: number }]

    if (!result || result.affectedRows === 0) {
      throw new HttpError(404, 'not_found')
    }

    invalidateUser(targetId)

    // Audit row carries NO password / hash — action label only.
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'update',
      resourceType: 'user',
      resourceId: String(targetId),
      diff: { action: 'admin_set_password' } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  },
)
