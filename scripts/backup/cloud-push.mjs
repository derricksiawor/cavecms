// cloud-push.mjs — upload a freshly-built local archive to a cloud destination,
// write a cleartext sidecar (so the restore UI can list + badge without
// downloading), apply remote retention, and write back any rotated refresh
// token + resolved folder id. Invoked by cavecms-backup.sh as the final step
// when CAVECMS_BACKUP_DESTINATION != local. Zero-dep (node builtins + the
// sibling cloud/* modules).
//
// Usage: node cloud-push.mjs <archivePath>
//
// Env:
//   CAVECMS_BACKUP_CLOUD_CREDS_FILE  (required) mode-600 JSON:
//       { provider, clientId, refreshToken, folderId?, passphrase? }
//   CAVECMS_BACKUP_CLOUD_CREDS_OUT   (optional) writeback target for
//       { refreshToken, folderId } after a rotation / folder creation
//   CAVECMS_BACKUP_STATUS_PATH       (optional) status file for progress
//   CAVECMS_CLOUD_STEP / CAVECMS_CLOUD_TOTAL  status step numbers (default 6/6)
//   CAVECMS_BACKUP_REMOTE_RETENTION  keep newest N remote archives (default 7)
//   CAVECMS_BACKUP_KEEP_LOCAL        '0' to delete the local archive on success
//   PHASE_STARTED_AT                 ISO timestamp for the status startedAt

import { readFileSync, writeFileSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDestination, sha256FileStream } from './cloud/destination.mjs'
import { encryptFile } from './cloud/passphraseCipher.mjs'

function safeUnlink(p) {
  if (!p) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

const PROVIDER_LABEL = { gdrive: 'Google Drive', onedrive: 'OneDrive' }

function nowIso() {
  return new Date().toISOString()
}

function makeStatusWriter(statusPath, step, total, started) {
  if (!statusPath) return () => {}
  return (stepLabel) => {
    const tmp = `${statusPath}.tmp.${process.pid}`
    const body = JSON.stringify({
      state: 'running',
      step,
      totalSteps: total,
      startedAt: started,
      updatedAt: nowIso(),
      stepLabel,
      error: '',
      log: '',
    })
    try {
      writeFileSync(tmp, body, { mode: 0o600 })
      renameSync(tmp, statusPath)
    } catch {
      /* best-effort progress */
    }
  }
}

function readManifestFromArchive(archivePath) {
  // The cloud archive is a plain tar.gz at this point (passphrase encryption is
  // applied by THIS script, not bash). Extract just manifest.json to stdout.
  const out = execFileSync('tar', ['-xzO', '-f', archivePath, 'manifest.json'], {
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(out.toString('utf8'))
}

function archiveBlobsOnly(entries) {
  return entries.filter(
    (e) => /^cavecms-backup-.+\.(tar\.gz|tar\.gz\.enc|tar\.gz\.age)$/.test(e.name),
  )
}

// Core, testable. Dependency-inject the destination factory so tests don't need
// real cloud credentials.
export async function pushToCloud({ archivePath, env = process.env, createDest = createDestination }) {
  if (!archivePath) throw new Error('cloud-push: missing <archivePath>')
  const credsFile = env.CAVECMS_BACKUP_CLOUD_CREDS_FILE
  if (!credsFile) throw new Error('cloud-push: CAVECMS_BACKUP_CLOUD_CREDS_FILE required')

  const creds = JSON.parse(readFileSync(credsFile, 'utf8'))
  const { provider, clientId, clientSecret, refreshToken, passphrase } = creds
  const label = PROVIDER_LABEL[provider] || 'the cloud'
  const keepLocal = env.CAVECMS_BACKUP_KEEP_LOCAL !== '0'
  const retention = Math.max(1, Number(env.CAVECMS_BACKUP_REMOTE_RETENTION || 7))
  const status = makeStatusWriter(
    env.CAVECMS_BACKUP_STATUS_PATH || '',
    Number(env.CAVECMS_CLOUD_STEP || 6),
    Number(env.CAVECMS_CLOUD_TOTAL || 6),
    env.PHASE_STARTED_AT || new Date(0).toISOString(),
  )

  const base = basename(archivePath)
  let encTmp = null
  let sidecarTmp = null
  try {
    status(`Preparing upload to ${label}…`)
    const manifest = readManifestFromArchive(archivePath)

    let blobPath = archivePath
    let remoteName = base
    let enc = null
    if (passphrase) {
      status(`Encrypting backup before upload to ${label}…`)
      encTmp = join(dirname(archivePath), `.${base}.enc.${process.pid}`)
      const meta = await encryptFile({ srcPath: archivePath, destPath: encTmp, passphrase })
      enc = { scheme: 'aesgcm-scrypt', ...meta }
      blobPath = encTmp
      remoteName = `${base}.enc`
    }

    const blobSha = await sha256FileStream(blobPath)
    const blobSize = statSync(blobPath).size

    let rotatedRefresh = null
    const dest = createDest({
      provider,
      clientId,
      clientSecret,
      refreshToken,
      folderId: creds.folderId,
      onRotate: (rt) => {
        rotatedRefresh = rt
      },
    })

    // App-private metadata stamped on the archive so the restore UI's list()
    // reads it back in ONE call (no per-backup sidecar download). gdrive only —
    // createDestination drops `opts` for OneDrive, which can't store it; the
    // sidecar (written below) remains the source of truth for restore + the
    // OneDrive / older-backup list fallback. All-string values, all tiny.
    const appProperties = {
      cavecmsVersion: String(manifest.cavecms?.version ?? '0.0.0'),
      cavecmsCreatedAt: String(manifest.createdAt ?? ''),
      cavecmsEncrypted: enc !== null ? '1' : '0',
      cavecmsIncludeEnv: manifest.env?.included === true ? '1' : '0',
      cavecmsMigratorEncoding: String(manifest.database?.migratorEncoding ?? 'unknown'),
    }

    await dest.ensureFolder()
    await dest.upload(
      blobPath,
      remoteName,
      (sent, total) => {
        const pct = total ? Math.min(100, Math.floor((sent / total) * 100)) : 0
        status(`Uploading to ${label}… ${pct}%`)
      },
      { appProperties },
    )

    // Cleartext sidecar for cheap listing + compat badges.
    const sidecar = {
      kind: 'cavecms-backup-sidecar',
      formatVersion: 1,
      archive: remoteName,
      sha256: blobSha,
      sizeBytes: blobSize,
      createdAt: manifest.createdAt,
      version: manifest.cavecms?.version ?? '0.0.0',
      commit: manifest.cavecms?.commit ?? '',
      migrationCount: manifest.database?.migrationCount ?? 0,
      schemaFingerprint: manifest.database?.schemaFingerprint ?? '',
      migratorEncoding: manifest.database?.migratorEncoding ?? 'unknown',
      includeEnv: manifest.env?.included === true,
      encrypted: enc !== null,
      enc,
    }
    sidecarTmp = join(dirname(archivePath), `.${remoteName}.meta.${process.pid}.json`)
    writeFileSync(sidecarTmp, JSON.stringify(sidecar, null, 2), { mode: 0o600 })
    await dest.upload(sidecarTmp, `${remoteName}.meta.json`, () => {})

    // Remote retention: keep newest N archive blobs (+ delete their sidecars).
    status(`Tidying up ${label}…`)
    try {
      const entries = await dest.list()
      const blobs = archiveBlobsOnly(entries).sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)),
      )
      const byName = new Map(entries.map((e) => [e.name, e]))
      for (const old of blobs.slice(retention)) {
        try {
          await dest.delete(old.remoteId)
        } catch {
          /* best-effort */
        }
        const meta = byName.get(`${old.name}.meta.json`)
        if (meta) {
          try {
            await dest.delete(meta.remoteId)
          } catch {
            /* best-effort */
          }
        }
      }
    } catch {
      /* retention is best-effort */
    }

    // Writeback rotated refresh token + resolved folder id for the app to persist.
    const out = env.CAVECMS_BACKUP_CLOUD_CREDS_OUT
    if (out) {
      const payload = { provider }
      if (rotatedRefresh) payload.refreshToken = rotatedRefresh
      const fid = dest.getFolderId()
      if (fid && fid !== creds.folderId) payload.folderId = fid
      if (payload.refreshToken || payload.folderId) {
        try {
          writeFileSync(out, JSON.stringify(payload), { mode: 0o600 })
        } catch {
          /* best-effort */
        }
      }
    }

    // Drop the local copy ONLY on a successful upload, and only if opted out.
    if (!keepLocal) safeUnlink(archivePath)

    status(`Uploaded to ${label}.`)
    return { remoteName, sha256: blobSha, sizeBytes: blobSize, encrypted: enc !== null }
  } finally {
    // Always clean temp blobs + the plaintext creds file — success or throw.
    safeUnlink(encTmp)
    safeUnlink(sidecarTmp)
    safeUnlink(credsFile)
  }
}

// Direct-invocation guard: only run from argv when executed as a script, not
// when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  pushToCloud({ archivePath: process.argv[2] }).catch((err) => {
    process.stderr.write(
      `cloud-push failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  })
}
