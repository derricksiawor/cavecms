import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'

interface UpdateResult {
  affectedRows: number
}

// Revoke a token (soft — keeps name + prefix + audit trail visible).
// Admin-only + CSRF + step-up reauth, same gate as minting. Idempotent:
// re-revoking an already-revoked token returns 404 (affectedRows 0).
export const DELETE = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    await requireFreshReauth(ctx.jti)

    const { id: idStr } = await params
    if (!/^[1-9][0-9]{0,9}$/.test(idStr)) {
      throw new HttpError(400, 'invalid_id')
    }
    const id = Number(idStr)
    const meta = auditMetaFromRequest(req)

    // Revoke + audit in ONE transaction (same-TX audit invariant — see
    // db/schema/audit.ts and the symmetric create route). The affectedRows=0
    // → 404 throw inside the TX rolls back cleanly (nothing changed) and
    // withError surfaces it as 404.
    await db.transaction(async (tx) => {
      const [res] = (await tx.execute(sql`
        UPDATE api_tokens
        SET revoked_at = NOW(3)
        WHERE id = ${id} AND revoked_at IS NULL
      `)) as unknown as [UpdateResult]
      if (!res.affectedRows) throw new HttpError(404, 'not_found')
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'api_token_revoke',
        resourceType: 'api_token',
        resourceId: String(id),
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
    })

    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    })
  },
)
