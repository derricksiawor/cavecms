import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  readRestoreStatus,
  writeRestoreStatus,
  isRestoreStale,
  getRestoreStatusPath,
} from '@/lib/backups/statusFile'
import { RESTORE_TOTAL_STEPS } from '@/lib/backups/constants'
import { spawnBackupEngine } from '@/lib/backups/spawnEngine'
import { resolveBackupDir } from '@/lib/backups/store'

// POST /api/admin/backups/upload-restore (multipart) — upload an archive +
// restore from it (disaster recovery onto a fresh box). The uploaded file is
// streamed to `<backupDir>/.incoming/`, validated (manifest + checksum +
// zip-slip) BEFORE any mutation, then handed to the restore orchestrator.

export const dynamic = 'force-dynamic'

const MAX_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB ceiling

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const r = readRestoreStatus()
  if (r && (r.state === 'validating' || r.state === 'restoring' || r.state === 'restarting') && !isRestoreStale(r)) {
    return new Response(JSON.stringify({ error: 'restore_in_progress' }), { status: 409, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  }

  const form = await req.formData()
  const file = form.get('archive')
  if (!(file instanceof File)) throw new HttpError(400, 'no_file')
  if (file.size > MAX_BYTES) throw new HttpError(413, 'too_large')

  const incoming = join(resolveBackupDir(), '.incoming')
  mkdirSync(incoming, { recursive: true })
  const ext = file.name.endsWith('.age') ? 'tar.gz.age' : 'tar.gz'
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/[-]/g, '').replace('T', '-').slice(0, 16)
  const dest = join(incoming, `upload-${stamp}-${process.pid}.${ext}`)

  // Stream to disk (no full-buffer in memory).
  await pipeline(Readable.fromWeb(file.stream() as never), createWriteStream(dest, { mode: 0o600 }))

  // Validate BEFORE any mutation. Plaintext archives only — an .age upload
  // can't be validated without an identity, so refuse it here (the operator
  // should restore an encrypted archive from the box where the identity lives,
  // via the CLI).
  if (ext.endsWith('.age')) {
    rmSync(dest, { force: true })
    throw new HttpError(400, 'encrypted_upload_unsupported')
  }
  const validator = join(process.cwd(), 'scripts', 'backup', 'backup-lib.mjs')
  let ok = false
  try {
    execFileSync('node', [validator, 'validate', dest], { stdio: 'ignore' })
    ok = true
  } catch {
    ok = false
  }
  if (!ok) {
    rmSync(dest, { force: true })
    throw new HttpError(400, 'invalid_archive')
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
      env: { CAVECMS_RESTORE_STATUS_PATH: getRestoreStatusPath(), CAVECMS_RESTORE_ARCHIVE: dest },
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
