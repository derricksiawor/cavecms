import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, requireScope, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { getClientId, isProviderConfigured } from '@/lib/backups/cloud/clients'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import { encryptSecret, AAD_BACKUP_PENDING_DEVICE_CODE } from '@/lib/security/secretCipher'
import { requestDeviceCode } from '@/lib/backups/cloud/oauthClient'

// POST /api/admin/backups/destinations/connect — start the OAuth device flow
// for a cloud backup destination. Returns the user_code + verification URL and
// stashes the encrypted device_code in backups_state for the poll route.

export const dynamic = 'force-dynamic'

const Body = z.object({ provider: z.enum(['gdrive', 'onedrive']) }).strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'write')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))

  if (!isProviderConfigured(body.provider)) {
    throw new HttpError(503, 'provider_unconfigured')
  }

  let device
  try {
    device = await requestDeviceCode({
      provider: body.provider,
      clientId: getClientId(body.provider),
    })
  } catch {
    throw new HttpError(502, 'provider_unreachable')
  }

  const expiresAt = new Date(Date.now() + device.expiresIn * 1000).toISOString()
  const pendingKey = body.provider === 'gdrive' ? 'gdrivePending' : 'onedrivePending'

  await updateSettingValue(
    'backups_state',
    (cur) => ({
      ...cur,
      [pendingKey]: {
        deviceCode: encryptSecret(device.deviceCode, AAD_BACKUP_PENDING_DEVICE_CODE),
        userCode: device.userCode,
        verificationUrl: device.verificationUrl,
        expiresAt,
        intervalSec: device.intervalSec,
      },
    }),
    ctx.userId,
  )

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'backup_dest_connect_start',
      resourceType: 'backups',
      resourceId: body.provider,
      diff: {},
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'backup_dest_connect_audit_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return new Response(
    JSON.stringify({
      userCode: device.userCode,
      verificationUrl: device.verificationUrl,
      expiresAt,
      intervalSec: device.intervalSec,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  )
})
