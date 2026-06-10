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
import { derivePublicHealthzUrl } from '@/lib/updates/publicHealthz'
import { resolveBackupDir } from '@/lib/backups/store'

// POST /api/admin/backups/upload-restore (raw body) — upload an archive +
// restore from it (disaster recovery onto a fresh box). The archive arrives as
// the RAW request body (content-type application/gzip), NOT multipart:
// `req.formData()` materialises every file part IN MEMORY before handing it
// over, so a multi-GB archive ballooned the Node worker — and on shared hosts
// (cPanel/CloudLinux LVE memory caps) the kernel killed the worker mid-upload,
// which the operator saw as the upload silently stopping partway. Raw body →
// `req.body` web stream → disk is constant-memory end to end.
//
// Validation here is deliberately thin + streaming-safe:
//   - gzip magic bytes (0x1f 0x8b) on the first chunk — rejects .age uploads,
//     renamed junk, and anything that isn't a gzip archive before a byte of it
//     is interpreted (the friendly "encrypted .age" hint comes from sniffing
//     the age header bytes).
//   - hard byte cap while streaming (a lying Content-Length can't fill disk).
// The restore orchestrator does the FULL validation (manifest + checksum +
// zip-slip + inner-tar symlink check + compat gate) at its step 1, BEFORE any
// mutation — running that synchronously on the request path would block the
// event loop on GB payloads. The orchestrator deletes the uploaded archive on
// its terminal state (CAVECMS_RESTORE_CLEANUP_ARCHIVE).

export const dynamic = 'force-dynamic'

const MAX_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB ceiling

// Binary age archives open with this ASCII header; armored ones with
// "-----BEGIN AGE". Sniffed only to give the operator the SPECIFIC
// "encrypted archives can't be uploaded" message instead of a generic one.
const AGE_BINARY_HEADER = Buffer.from('age-encryption.org/')
const AGE_ARMOR_HEADER = Buffer.from('-----BEGIN AGE')

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

  if (!req.body) throw new HttpError(400, 'no_file')
  // Early reject on the advertised size; the streaming cap below is the
  // authoritative enforcement (chunked uploads can lie here).
  const advertised = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(advertised) && advertised > MAX_BYTES) throw new HttpError(413, 'too_large')

  const incoming = join(resolveBackupDir(), '.incoming')
  mkdirSync(incoming, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.TZ-]/g, '').slice(0, 14)
  const dest = join(incoming, `upload-${stamp}-${process.pid}.tar.gz`)

  // Stream to disk with (a) a gzip magic-byte gate on the leading bytes and
  // (b) a hard byte cap — both destroy the stream + clean up on violation, so
  // a non-archive or a lying/streaming upload never lands on disk in full.
  let written = 0
  let headerChecked = false
  let headerBuf = Buffer.alloc(0)
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length
      if (written > MAX_BYTES) {
        cb(new Error('too_large'))
        return
      }
      if (!headerChecked) {
        headerBuf = Buffer.concat([headerBuf, chunk])
        if (headerBuf.length < 2) {
          cb() // hold until we can see the magic bytes
          return
        }
        headerChecked = true
        if (headerBuf[0] !== 0x1f || headerBuf[1] !== 0x8b) {
          const isAge =
            headerBuf.subarray(0, AGE_BINARY_HEADER.length).equals(AGE_BINARY_HEADER) ||
            headerBuf.subarray(0, AGE_ARMOR_HEADER.length).equals(AGE_ARMOR_HEADER)
          cb(new Error(isAge ? 'encrypted_upload_unsupported' : 'not_gzip'))
          return
        }
        cb(null, headerBuf)
        return
      }
      cb(null, chunk)
    },
    flush(cb) {
      // Sub-2-byte upload — never passed the header gate.
      if (!headerChecked) {
        cb(new Error('not_gzip'))
        return
      }
      cb()
    },
  })
  try {
    await pipeline(Readable.fromWeb(req.body as never), cap, createWriteStream(dest, { mode: 0o600 }))
  } catch (err) {
    rmSync(dest, { force: true })
    if (err instanceof Error && err.message === 'too_large') throw new HttpError(413, 'too_large')
    if (err instanceof Error && err.message === 'encrypted_upload_unsupported') {
      throw new HttpError(400, 'encrypted_upload_unsupported')
    }
    if (err instanceof Error && err.message === 'not_gzip') throw new HttpError(400, 'not_gzip')
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
  const restoreEnv: Record<string, string> = {
    CAVECMS_RESTORE_STATUS_PATH: getRestoreStatusPath(),
    CAVECMS_RESTORE_ARCHIVE: dest,
    // Tell the orchestrator to delete this uploaded archive on its terminal
    // state (it's a one-shot upload, not a kept backup).
    CAVECMS_RESTORE_CLEANUP_ARCHIVE: '1',
  }
  // cPanel: route the step-7 verify at the public healthz URL so it can't
  // time out on the dead loopback and roll back a good restore. No-op off cPanel.
  const publicHealthz = derivePublicHealthzUrl(req)
  if (publicHealthz) restoreEnv.CAVECMS_PUBLIC_HEALTHZ_URL = publicHealthz
  try {
    pid = spawnBackupEngine({
      script: 'cavecms-restore.sh',
      env: restoreEnv,
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
