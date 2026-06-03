import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, requireScope, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  readRestoreStatus,
  writeRestoreStatus,
  isRestoreStale,
  getRestoreStatusPath,
  isSharedOpInProgress,
} from '@/lib/backups/statusFile'
import { RESTORE_TOTAL_STEPS } from '@/lib/backups/constants'
import { spawnBackupEngine } from '@/lib/backups/spawnEngine'
import { resolveBackupDir } from '@/lib/backups/store'

// POST /api/admin/backups/upload-restore (multipart) — upload an archive +
// restore from it (disaster recovery onto a fresh box). The uploaded file is
// streamed to `<backupDir>/.incoming/` with a hard byte cap, then handed to the
// restore orchestrator. The orchestrator does the FULL validation (manifest +
// checksum + zip-slip + inner-tar symlink check + compat gate) at its step 1,
// BEFORE any mutation — so we do NOT run a synchronous validator on the request
// path (that would block the event loop + buffer GB payloads). The orchestrator
// deletes the uploaded archive on its terminal state (CAVECMS_RESTORE_CLEANUP_ARCHIVE).

export const dynamic = 'force-dynamic'

const MAX_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB ceiling

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'backups', 'delete')
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  if (isSharedOpInProgress()) {
    return new Response(JSON.stringify({ error: 'operation_in_progress' }), { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }
  const r = readRestoreStatus()
  if (r && (r.state === 'validating' || r.state === 'restoring' || r.state === 'restarting') && !isRestoreStale(r)) {
    return new Response(JSON.stringify({ error: 'restore_in_progress' }), { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }

  const form = await req.formData()
  const file = form.get('archive')
  if (!(file instanceof File)) throw new HttpError(400, 'no_file')
  // .age uploads can't be validated/decrypted without an identity — restore an
  // encrypted archive from the box that holds the key, via the CLI.
  if (file.name.endsWith('.age')) throw new HttpError(400, 'encrypted_upload_unsupported')
  // Trust the advertised size as an early reject, but ALSO enforce the cap on
  // the bytes actually streamed (chunked uploads can lie about file.size).
  if (typeof file.size === 'number' && file.size > MAX_BYTES) throw new HttpError(413, 'too_large')

  const incoming = join(resolveBackupDir(), '.incoming')
  mkdirSync(incoming, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.TZ-]/g, '').slice(0, 14)
  const dest = join(incoming, `upload-${stamp}-${process.pid}.tar.gz`)

  // Stream to disk with a hard byte cap (destroys the stream + cleans up on
  // overflow) so a lying/streaming upload can't fill the disk.
  let written = 0
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length
      if (written > MAX_BYTES) {
        cb(new Error('too_large'))
        return
      }
      cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(file.stream() as never), cap, createWriteStream(dest, { mode: 0o600 }))
  } catch (err) {
    rmSync(dest, { force: true })
    if (err instanceof Error && err.message === 'too_large') throw new HttpError(413, 'too_large')
    throw new HttpError(400, 'upload_failed')
  }

  writeRestoreStatus({
    state: 'validating',
    step: 0,
    totalSteps: RESTORE_TOTAL_STEPS,
    stepLabel: 'Checking the archive',
    error: undefined,
    log: undefined,
  })

  let pid: number | null = null
  try {
    pid = spawnBackupEngine({
      script: 'cavecms-restore.sh',
      env: {
        CAVECMS_RESTORE_STATUS_PATH: getRestoreStatusPath(),
        CAVECMS_RESTORE_ARCHIVE: dest,
        // Tell the orchestrator to delete this uploaded archive on its terminal
        // state (it's a one-shot upload, not a kept backup).
        CAVECMS_RESTORE_CLEANUP_ARCHIVE: '1',
      },
    })
  } catch (err) {
    writeRestoreStatus({ state: 'failed', error: 'engine_unavailable' })
    rmSync(dest, { force: true })
    throw err
  }

  const meta = auditMetaFromRequest(req)
  try {
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'restore',
      resourceType: 'backups',
      resourceId: 'uploaded',
      diff: { uploaded: true },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'upload_restore_audit_failed', err: err instanceof Error ? err.message : String(err) }))
  }

  return new Response(JSON.stringify({ accepted: true, pid }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
