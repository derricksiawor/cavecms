// cloud-pull.mjs — download a remote backup blob into the restore staging dir,
// verify its sha256 against the cleartext sidecar BEFORE any mutation, decrypt
// it if it was passphrase-encrypted, and write the resolved plaintext archive
// path to CAVECMS_RESTORE_PULL_OUT for cavecms-restore.sh to pick up. Invoked
// as restore "step 0" when CAVECMS_RESTORE_SOURCE=cloud. Zero-dep.
//
// Usage: node cloud-pull.mjs
//
// Env:
//   CAVECMS_RESTORE_PROVIDER          gdrive | onedrive
//   CAVECMS_RESTORE_REMOTE_ID         the blob's remote id
//   CAVECMS_BACKUP_CLOUD_CREDS_FILE   mode-600 JSON { provider, clientId, refreshToken, folderId?, passphrase? }
//   CAVECMS_RESTORE_DOWNLOAD_DIR      where to write the downloaded archive
//   CAVECMS_RESTORE_PULL_OUT          file to write the resolved archive path to
//   CAVECMS_RESTORE_STATUS_PATH       restore status file (download progress)
//   PHASE_STARTED_AT                  ISO timestamp for status startedAt

import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDestination, sha256FileStream } from './cloud/destination.mjs'
import { decryptFile } from './cloud/passphraseCipher.mjs'

const PROVIDER_LABEL = { gdrive: 'Google Drive', onedrive: 'OneDrive' }
// Archive blob name shape — the downloaded filename is constrained to this so a
// compromised cloud account can't supply a traversal path as the blob "name".
const ARCHIVE_RE = /^cavecms-backup-[A-Za-z0-9._-]+\.(tar\.gz|tar\.gz\.enc|tar\.gz\.age)$/
const SHA256_RE = /^[0-9a-f]{64}$/

function safeUnlink(p) {
  if (!p) return
  try {
    unlinkSync(p)
  } catch {
    /* ignore */
  }
}

function nowIso() {
  return new Date().toISOString()
}

function makeStatusWriter(statusPath, started) {
  if (!statusPath) return () => {}
  return (stepLabel) => {
    const tmp = `${statusPath}.tmp.${process.pid}`
    const body = JSON.stringify({
      state: 'validating',
      step: 1,
      totalSteps: 7,
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
      /* best-effort */
    }
  }
}

export async function pullFromCloud({ env = process.env, createDest = createDestination }) {
  const provider = env.CAVECMS_RESTORE_PROVIDER
  const remoteId = env.CAVECMS_RESTORE_REMOTE_ID
  const credsFile = env.CAVECMS_BACKUP_CLOUD_CREDS_FILE
  const downloadDir = env.CAVECMS_RESTORE_DOWNLOAD_DIR
  if (!provider || !remoteId) throw new Error('cloud-pull: provider + remote id required')
  if (!credsFile) throw new Error('cloud-pull: CAVECMS_BACKUP_CLOUD_CREDS_FILE required')
  if (!downloadDir) throw new Error('cloud-pull: CAVECMS_RESTORE_DOWNLOAD_DIR required')

  const creds = JSON.parse(readFileSync(credsFile, 'utf8'))
  const label = PROVIDER_LABEL[provider] || 'the cloud'
  const status = makeStatusWriter(
    env.CAVECMS_RESTORE_STATUS_PATH || '',
    env.PHASE_STARTED_AT || new Date(0).toISOString(),
  )

  const dest = createDest({
    provider,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
    folderId: creds.folderId,
  })

  let blobPath = null
  try {
    await dest.ensureFolder()

    status(`Finding your backup in ${label}…`)
    const entries = await dest.list()
    const blob = entries.find((e) => e.remoteId === remoteId)
    if (!blob) throw new Error('cloud-pull: remote archive not found')
    // Constrain the filename to the archive shape + strip any directory
    // component — a compromised cloud account must not be able to write the
    // downloaded blob outside the staging dir via a traversal "name".
    const safeName = basename(blob.name)
    if (!ARCHIVE_RE.test(safeName)) {
      throw new Error('cloud-pull: unexpected remote archive name')
    }
    const sidecarEntry = entries.find((e) => e.name === `${blob.name}.meta.json`)
    if (!sidecarEntry) throw new Error('cloud-pull: sidecar metadata not found')

    // Download the (tiny) sidecar first to learn the expected sha256 + enc meta.
    const sidecarPath = join(downloadDir, `.sidecar.${process.pid}.json`)
    await dest.download(sidecarEntry.remoteId, sidecarPath, () => {})
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    safeUnlink(sidecarPath)

    // Fail CLOSED on a missing/malformed checksum — the sidecar is
    // attacker-influenceable if the cloud account is compromised, so an absent
    // sha256 must be a hard error, not a skipped integrity check.
    if (!SHA256_RE.test(String(sidecar.sha256 || ''))) {
      throw new Error('cloud-pull: backup metadata is missing its integrity checksum')
    }

    // Download the archive blob with progress.
    blobPath = join(downloadDir, safeName)
    await dest.download(remoteId, blobPath, (seen, total) => {
      const pct = total ? Math.min(100, Math.floor((seen / total) * 100)) : 0
      status(`Downloading from ${label}… ${pct}%`)
    })

    // Verify integrity BEFORE handing anything to the (destructive) restore.
    status(`Checking the download…`)
    const sha = await sha256FileStream(blobPath)
    if (sha !== sidecar.sha256) {
      safeUnlink(blobPath)
      throw new Error('cloud-pull: checksum mismatch — the downloaded backup is corrupt')
    }

    // Decrypt if the blob was passphrase-encrypted.
    let archivePath = blobPath
    if (sidecar.encrypted) {
      if (!creds.passphrase) {
        throw new Error('cloud-pull: this backup is encrypted — a passphrase is required')
      }
      if (!sidecar.enc || sidecar.enc.scheme !== 'aesgcm-scrypt') {
        throw new Error('cloud-pull: unknown encryption scheme')
      }
      status(`Decrypting your backup…`)
      const plainPath = blobPath.replace(/\.enc$/, '')
      await decryptFile({
        srcPath: blobPath,
        destPath: plainPath,
        passphrase: creds.passphrase,
        saltB64: sidecar.enc.saltB64,
        ivB64: sidecar.enc.ivB64,
        tagB64: sidecar.enc.tagB64,
      })
      safeUnlink(blobPath)
      archivePath = plainPath
    }

    // Hand the resolved path back to the bash orchestrator.
    if (env.CAVECMS_RESTORE_PULL_OUT) {
      writeFileSync(env.CAVECMS_RESTORE_PULL_OUT, archivePath, { mode: 0o600 })
    }
    return { archivePath, encrypted: sidecar.encrypted === true }
  } finally {
    // Always wipe the plaintext creds file (passphrase + token) — success or throw.
    safeUnlink(credsFile)
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  pullFromCloud({}).catch((err) => {
    process.stderr.write(
      `cloud-pull failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  })
}
