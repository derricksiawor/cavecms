import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
import { derivePublicHealthzUrl } from '@/lib/updates/publicHealthz'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { resolveBackupDir, isValidArchiveBasename } from '@/lib/backups/store'

// POST /api/admin/backups/restore — restore from an EXISTING local backup.
// Returns 202; the page polls /api/admin/backups/status?kind=restore.

export const dynamic = 'force-dynamic'

const Body = z
  .object({ file: z.string().min(1).max(200), restoreEnv: z.boolean().optional() })
  .strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'delete')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  const body = Body.parse(await readJsonBody(req))

  if (!isValidArchiveBasename(body.file)) throw new HttpError(400, 'invalid_file')
  const archivePath = join(resolveBackupDir(), body.file)
  if (!existsSync(archivePath)) throw new HttpError(404, 'not_found')

  if (isSharedOpInProgress()) {
    return new Response(JSON.stringify({ error: 'operation_in_progress' }), { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
  const r = readRestoreStatus()
  if (r && (r.state === 'validating' || r.state === 'restoring' || r.state === 'restarting') && !isRestoreStale(r)) {
    return new Response(JSON.stringify({ error: 'restore_in_progress' }), { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
  const b = readBackupStatus()
  if (b && b.state === 'running' && !isBackupStale(b)) {
    return new Response(JSON.stringify({ error: 'backup_in_progress' }), { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }

  writeRestoreStatus({
    state: 'validating',
    step: 0,
    totalSteps: RESTORE_TOTAL_STEPS,
    stepLabel: 'Checking the archive',
    error: undefined,
    log: undefined,
  })

  const env: Record<string, string> = {
    CAVECMS_RESTORE_STATUS_PATH: getRestoreStatusPath(),
    CAVECMS_RESTORE_ARCHIVE: archivePath,
  }
  if (body.restoreEnv) env.CAVECMS_RESTORE_ENV = '1'
  // cPanel: the restore's step-7 health verify can't reach the app over the
  // 127.0.0.1 loopback (private socket), so it would time out and roll back a
  // GOOD restore. Hand it the public healthz URL, derived from the operator's
  // CONFIGURED site URL (not the request host). No-op off cPanel.
  const publicHealthz = derivePublicHealthzUrl(await getSiteOrigin())
  if (publicHealthz) env.CAVECMS_PUBLIC_HEALTHZ_URL = publicHealthz

  let pid: number | null = null
  try {
    pid = spawnBackupEngine({ script: 'cavecms-restore.sh', env })
  } catch (err) {
    writeRestoreStatus({ state: 'failed', error: 'engine_unavailable' })
    throw err
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'restore',
      resourceType: 'backups',
      resourceId: body.file.slice(0, 60),
      diff: { restoreEnv: body.restoreEnv === true },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'restore_audit_insert_failed', err: err instanceof Error ? err.message : String(err) }))
  }

  return new Response(JSON.stringify({ accepted: true, pid }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
