import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  decryptSecret,
  AAD_BACKUP_GDRIVE_REFRESH,
  AAD_BACKUP_ONEDRIVE_REFRESH,
} from '@/lib/security/secretCipher'
import { revokeToken } from '@/lib/backups/cloud/oauthClient'
import { clearAccessTokenCache } from '@/lib/backups/cloud/destClient'

// POST /api/admin/backups/destinations/disconnect — revoke the provider token
// (best-effort) and wipe the stored connection. If the active destination was
// the disconnected provider, fall back to local.

export const dynamic = 'force-dynamic'

const Body = z.object({ provider: z.enum(['gdrive', 'onedrive']) }).strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'write')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))
  const provider: 'gdrive' | 'onedrive' = body.provider

  const cfg = await getSetting('backups')
  const conn = cfg[provider]
  const aad = provider === 'gdrive' ? AAD_BACKUP_GDRIVE_REFRESH : AAD_BACKUP_ONEDRIVE_REFRESH

  // Best-effort revoke at the provider (Google has a revoke endpoint; MS no-op).
  if (conn?.refreshToken) {
    try {
      const plaintext = decryptSecret(conn.refreshToken, aad)
      await revokeToken({ provider, token: plaintext })
    } catch {
      // ignore — local wipe is the real disconnect
    }
  }

  const next = await updateSettingValue(
    'backups',
    (cur) => {
      const out = { ...cur, [provider]: { connected: false } }
      // If the active destination pointed at the disconnected provider, fall back to local.
      if (out.destination === provider) out.destination = 'local'
      return out
    },
    ctx.userId,
  )

  // Drop any cached access token for this provider so a later re-connect (which
  // may be a DIFFERENT account) can't be served the old account's token until it
  // expires.
  clearAccessTokenCache(provider)

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'backup_dest_disconnected',
      resourceType: 'backups',
      resourceId: provider,
      diff: {},
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'backup_dest_disconnected_audit_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return new Response(JSON.stringify({ ok: true, destination: next.destination }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
