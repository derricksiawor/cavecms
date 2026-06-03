import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { requireFreshReauth } from '@/lib/auth/reauth'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { generateApiToken, clearTokenTouch } from '@/lib/auth/apiToken'

interface UpdateResult {
  affectedRows: number
}

// Rotate a token's secret in place — issues a fresh `cave_…` secret while
// keeping the row's id, name, role, scopes, and expiry. The OLD secret stops
// working the instant this commits (the hash no longer matches). Admin-only
// + CSRF + step-up reauth, same gate as minting/revoking. Targets ACTIVE
// tokens only (revoked rows return 404 — rotation does not revive a revoked
// credential; mint a new one instead). The new plaintext is returned EXACTLY
// ONCE in this response. last_used_at resets so the freshly-rotated secret
// starts a clean usage history.
export const POST = withError<{ params: Promise<{ id: string }> }>(
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
    const { token, hash, prefix } = generateApiToken()

    // Rotate + audit in ONE transaction (same-TX audit invariant — see
    // db/schema/audit.ts and the sibling create/revoke routes).
    await db.transaction(async (tx) => {
      const [res] = (await tx.execute(sql`
        UPDATE api_tokens
        SET token_hash = ${hash},
            token_prefix = ${prefix},
            last_used_at = NULL
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW(3))
      `)) as unknown as [UpdateResult]
      if (!res.affectedRows) throw new HttpError(404, 'not_found')
      // Audit row never stores the token or its hash.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'api_token_rotate',
        resourceType: 'api_token',
        resourceId: String(id),
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
    })
    // last_used_at was reset to NULL above; drop the stale throttle entry so
    // the rotated token's next use re-writes last_used_at promptly.
    clearTokenTouch(id)

    // `token` is shown to the operator once and never again.
    return new Response(JSON.stringify({ id, token, prefix }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  },
)
