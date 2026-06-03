import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, requireScope, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  readRestoreStatus,
  writeRestoreStatus,
  isRestoreStale,
  getRestoreStatusPath,
  readBackupStatus,
  isBackupStale,
  isSharedOpInProgress,
} from '@/lib/backups/statusFile'
import { RESTORE_TOTAL_STEPS } from '@/lib/backups/constants'
import { spawnBackupEngine } from '@/lib/backups/spawnEngine'
import { prepareRestoreCloudCreds, discardCloudCreds } from '@/lib/backups/cloud/credsFile'

// POST /api/admin/backups/restore-from-cloud — download a remote backup and
// restore from it. cloud-pull (restore step 0) verifies sha256 + decrypts
// before any mutation; the rest of the restore (validate → … → verify, with
// rollback) is unchanged. Returns 202; page polls status?kind=restore.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    provider: z.enum(['gdrive', 'onedrive']),
    remoteId: z.string().min(1).max(400),
    restoreEnv: z.boolean().optional(),
  })
  .strict()

function conflict(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 409,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'delete')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))

  if (isSharedOpInProgress()) return conflict('operation_in_progress')
  const r = readRestoreStatus()
  if (r && (r.state === 'validating' || r.state === 'restoring' || r.state === 'restarting') && !isRestoreStale(r)) {
    return conflict('restore_in_progress')
  }
  const b = readBackupStatus()
  if (b && b.state === 'running' && !isBackupStale(b)) return conflict('backup_in_progress')

  // Write the mode-600 creds file (decrypted refresh token + passphrase).
  let credsFile: string
  try {
    credsFile = await prepareRestoreCloudCreds(body.provider)
  } catch (err) {
    if (err instanceof Error && err.message === 'not_connected') {
      throw new HttpError(400, 'not_connected')
    }
    throw err
  }

  writeRestoreStatus({
    state: 'validating',
    step: 0,
    totalSteps: RESTORE_TOTAL_STEPS,
    stepLabel: 'Finding your backup in the cloud',
    error: undefined,
    log: undefined,
  })

  const env: Record<string, string> = {
    CAVECMS_RESTORE_STATUS_PATH: getRestoreStatusPath(),
    CAVECMS_RESTORE_SOURCE: 'cloud',
    CAVECMS_RESTORE_PROVIDER: body.provider,
    CAVECMS_RESTORE_REMOTE_ID: body.remoteId,
    CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile,
  }
  if (body.restoreEnv) env.CAVECMS_RESTORE_ENV = '1'

  let pid: number | null = null
  try {
    pid = spawnBackupEngine({ script: 'cavecms-restore.sh', env })
  } catch (err) {
    // Engine never started → wipe the plaintext creds file its trap would have.
    discardCloudCreds()
    writeRestoreStatus({ state: 'failed', error: 'engine_unavailable' })
    throw err
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'restore',
      resourceType: 'backups',
      resourceId: `cloud:${body.provider}`,
      diff: { source: 'cloud', restoreEnv: body.restoreEnv === true },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'restore_cloud_audit_insert_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  return new Response(JSON.stringify({ accepted: true, pid }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
