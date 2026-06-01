import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  readBackupStatus,
  writeBackupStatus,
  isBackupStale,
  getBackupStatusPath,
  readRestoreStatus,
  isRestoreStale,
  isSharedOpInProgress,
} from '@/lib/backups/statusFile'
import { BACKUP_TOTAL_STEPS } from '@/lib/backups/constants'
import { spawnBackupEngine } from '@/lib/backups/spawnEngine'
import {
  prepareBackupCloudEnv,
  discardCloudCreds,
  PassphraseRequiredError,
  CloudDestinationUnavailableError,
} from '@/lib/backups/cloud/credsFile'

// POST /api/admin/backups/create — kick off a detached backup. Returns 202.
// The Settings page polls /api/admin/backups/status?kind=backup.

export const dynamic = 'force-dynamic'

const Body = z.object({ includeEnv: z.boolean().optional() }).strict()

function activeError(): Response | null {
  // Cross-subsystem gate: refuse if ANY update / backup / restore holds the
  // shared op lock (the bash O_EXCL acquire is authoritative; this is the fast
  // 409 pre-check).
  if (isSharedOpInProgress()) return conflict('operation_in_progress')
  const b = readBackupStatus()
  if (b && b.state === 'running' && !isBackupStale(b)) return conflict('backup_in_progress')
  const r = readRestoreStatus()
  if (r && (r.state === 'validating' || r.state === 'restoring' || r.state === 'restarting') && !isRestoreStale(r))
    return conflict('restore_in_progress')
  return null
}
function conflict(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 409,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))

  const active = activeError()
  if (active) return active

  // Resolve the cloud destination (decrypts the refresh token + passphrase into
  // a mode-600 creds file). Returns null for a plain local backup. Throws if
  // "include secrets" is requested for a cloud destination with no passphrase.
  let cloudEnv: Record<string, string> | null = null
  try {
    cloudEnv = await prepareBackupCloudEnv(body.includeEnv === true)
  } catch (err) {
    if (err instanceof PassphraseRequiredError) {
      return new Response(JSON.stringify({ error: 'passphrase_required_for_secrets' }), {
        status: 400,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    if (err instanceof CloudDestinationUnavailableError) {
      return new Response(JSON.stringify({ error: 'destination_not_connected' }), {
        status: 400,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    throw err
  }

  // Seed status so the modal shows progress immediately.
  writeBackupStatus({
    state: 'running',
    step: 0,
    totalSteps: cloudEnv ? BACKUP_TOTAL_STEPS + 1 : BACKUP_TOTAL_STEPS,
    stepLabel: 'Getting ready',
    error: undefined,
    log: undefined,
  })

  const env: Record<string, string> = { CAVECMS_BACKUP_STATUS_PATH: getBackupStatusPath() }
  if (body.includeEnv) env.CAVECMS_BACKUP_INCLUDE_ENV = '1'
  if (cloudEnv) Object.assign(env, cloudEnv)

  let pid: number | null = null
  try {
    pid = spawnBackupEngine({ script: 'cavecms-backup.sh', env })
  } catch (err) {
    // Engine never started → wipe the plaintext creds file its trap would have.
    if (cloudEnv) discardCloudCreds()
    writeBackupStatus({ state: 'failed', error: 'engine_unavailable' })
    throw err
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'backup',
      resourceType: 'backups',
      resourceId: 'pending',
      diff: { includeEnv: body.includeEnv === true },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'backup_audit_insert_failed', err: err instanceof Error ? err.message : String(err) }))
  }

  return new Response(JSON.stringify({ accepted: true, pid }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
