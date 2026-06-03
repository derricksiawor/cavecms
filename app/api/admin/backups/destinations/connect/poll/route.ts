import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { getClientId, getClientSecret, clientFingerprint } from '@/lib/backups/cloud/clients'
import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  encryptSecret,
  decryptSecret,
  AAD_BACKUP_PENDING_DEVICE_CODE,
  AAD_BACKUP_GDRIVE_REFRESH,
  AAD_BACKUP_ONEDRIVE_REFRESH,
} from '@/lib/security/secretCipher'
import { pollDeviceToken, fetchAccountEmail } from '@/lib/backups/cloud/oauthClient'

// POST /api/admin/backups/destinations/connect/poll — poll the provider token
// endpoint for a pending device flow. On success, store the encrypted refresh
// token + account email in the `backups` setting and clear the pending block.

export const dynamic = 'force-dynamic'

const Body = z.object({ provider: z.enum(['gdrive', 'onedrive']) }).strict()

type Provider = 'gdrive' | 'onedrive'

function refreshAad(provider: Provider) {
  return provider === 'gdrive' ? AAD_BACKUP_GDRIVE_REFRESH : AAD_BACKUP_ONEDRIVE_REFRESH
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))
  const provider: Provider = body.provider

  const pendingKey = provider === 'gdrive' ? 'gdrivePending' : 'onedrivePending'
  const state = await getSetting('backups_state')
  const pending = state[pendingKey]

  if (!pending || Date.parse(pending.expiresAt) < Date.now()) {
    return json({ status: 'expired' })
  }

  let deviceCode: string
  try {
    deviceCode = decryptSecret(pending.deviceCode, AAD_BACKUP_PENDING_DEVICE_CODE)
  } catch {
    // Tampered/undecryptable pending block — treat as expired, clear it.
    await clearPending(provider, ctx.userId)
    return json({ status: 'expired' })
  }

  let result
  try {
    result = await pollDeviceToken({
      provider,
      clientId: getClientId(provider),
      clientSecret: getClientSecret(provider),
      deviceCode,
    })
  } catch {
    throw new HttpError(502, 'provider_unreachable')
  }

  if (result.status !== 'success') {
    // pending / slow_down / denied / expired — forward as-is.
    if (result.status === 'denied' || result.status === 'expired') {
      await clearPending(provider, ctx.userId)
    }
    return json({ status: result.status, intervalSec: pending.intervalSec })
  }

  // Success: fetch the account email (best-effort) and persist the connection.
  let accountEmail: string | null = null
  try {
    accountEmail = await fetchAccountEmail({ provider, accessToken: result.accessToken })
  } catch {
    accountEmail = null
  }

  if (!result.refreshToken) {
    // No refresh token (consent without offline_access) — cannot proceed.
    await clearPending(provider, ctx.userId)
    throw new HttpError(400, 'no_refresh_token')
  }

  const encRefresh = encryptSecret(result.refreshToken, refreshAad(provider))

  await updateSettingValue(
    'backups',
    (cur) => ({
      ...cur,
      [provider]: {
        connected: true,
        accountEmail: accountEmail ?? undefined,
        folderId: cur[provider]?.folderId,
        refreshToken: encRefresh,
        clientFingerprint: clientFingerprint(provider),
      },
    }),
    ctx.userId,
  )
  // Fresh connection (possibly a different account than before) → drop any
  // access token cached for this provider so the new refresh token is used.
  const { clearAccessTokenCache } = await import('@/lib/backups/cloud/destClient')
  clearAccessTokenCache(provider)
  await clearPending(provider, ctx.userId)

  // Create + persist the cloud folder NOW (best-effort) so every backup/list
  // uses the same folder — prevents duplicate folders forming if a later
  // post-backup reconcile is delayed or fails.
  try {
    const { resolveAndPersistFolder } = await import('@/lib/backups/cloud/remoteList')
    await resolveAndPersistFolder(provider)
  } catch {
    /* lazily resolved on first backup if this fails */
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'backup_dest_connected',
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
        msg: 'backup_dest_connected_audit_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return json({ status: 'success', accountEmail })
})

async function clearPending(provider: Provider, userId: number) {
  const pendingKey = provider === 'gdrive' ? 'gdrivePending' : 'onedrivePending'
  await updateSettingValue(
    'backups_state',
    (cur) => {
      const next = { ...cur }
      delete next[pendingKey]
      return next
    },
    userId,
  )
}

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
