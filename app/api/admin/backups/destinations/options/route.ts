import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import { encryptSecret, AAD_BACKUP_PASSPHRASE } from '@/lib/security/secretCipher'

// POST /api/admin/backups/destinations/options — save the backup destination +
// retention + keep-local + passphrase. A cloud destination can only be selected
// if it is connected. The passphrase is stored encrypted-at-rest; an empty
// passphrase with passphraseEnabled keeps the existing one.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    destination: z.enum(['local', 'gdrive', 'onedrive']),
    remoteRetention: z.number().int().min(1).max(100),
    keepLocalCopy: z.boolean(),
    passphraseEnabled: z.boolean(),
    passphrase: z.string().max(400).optional(),
  })
  .strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))

  const cfg = await getSetting('backups')

  // A cloud destination must be connected to be selected.
  if (body.destination !== 'local' && !cfg[body.destination].connected) {
    throw new HttpError(400, 'destination_not_connected')
  }

  const next = await updateSettingValue(
    'backups',
    (cur) => {
      const encryption = { ...cur.encryption }
      if (!body.passphraseEnabled) {
        encryption.passphraseEnabled = false
        delete encryption.passphrase
      } else {
        encryption.passphraseEnabled = true
        if (body.passphrase && body.passphrase.length > 0) {
          encryption.passphrase = encryptSecret(body.passphrase, AAD_BACKUP_PASSPHRASE)
        }
        // else: keep the existing encrypted passphrase unchanged.
      }
      return {
        ...cur,
        destination: body.destination,
        remoteRetention: body.remoteRetention,
        keepLocalCopy: body.keepLocalCopy,
        encryption,
      }
    },
    ctx.userId,
  )

  // Guard: passphrase must actually exist if enabled (else a later cloud DR
  // backup would refuse). Surfaced as a 400 so the UI can prompt for one.
  if (next.encryption.passphraseEnabled && !next.encryption.passphrase) {
    // Roll back the enable so state stays consistent.
    await updateSettingValue(
      'backups',
      (cur) => ({ ...cur, encryption: { ...cur.encryption, passphraseEnabled: false } }),
      ctx.userId,
    )
    throw new HttpError(400, 'passphrase_required')
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'backup_dest_options',
      resourceType: 'backups',
      resourceId: body.destination,
      diff: { remoteRetention: body.remoteRetention, keepLocalCopy: body.keepLocalCopy },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'backup_dest_options_audit_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return new Response(
    JSON.stringify({
      ok: true,
      destination: next.destination,
      remoteRetention: next.remoteRetention,
      keepLocalCopy: next.keepLocalCopy,
      passphraseEnabled: next.encryption.passphraseEnabled,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  )
})
