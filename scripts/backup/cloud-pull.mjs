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

import { readFileSync, writeFileSync, unlinkSync, renameSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDestination } from './cloud/destination.mjs'
import { decryptFile } from './cloud/passphraseCipher.mjs'

const PROVIDER_LABEL = { gdrive: 'Google Drive', onedrive: 'OneDrive' }

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

function sha256FileStream(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('error', reject)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
  })
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
    refreshToken: creds.refreshToken,
    folderId: creds.folderId,
  })
  await dest.ensureFolder()

  status(`Finding your backup in ${label}…`)
  const entries = await dest.list()
  const blob = entries.find((e) => e.remoteId === remoteId)
  if (!blob) throw new Error('cloud-pull: remote archive not found')
  const sidecarEntry = entries.find((e) => e.name === `${blob.name}.meta.json`)
  if (!sidecarEntry) throw new Error('cloud-pull: sidecar metadata not found')

  // Download the (tiny) sidecar first to learn the expected sha256 + enc meta.
  const sidecarPath = join(downloadDir, `.sidecar.${process.pid}.json`)
  await dest.download(sidecarEntry.remoteId, sidecarPath, () => {})
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  try {
    unlinkSync(sidecarPath)
  } catch {
    /* ignore */
  }

  // Download the archive blob with progress.
  const blobPath = join(downloadDir, blob.name)
  await dest.download(remoteId, blobPath, (seen, total) => {
    const pct = total ? Math.min(100, Math.floor((seen / total) * 100)) : 0
    status(`Downloading from ${label}… ${pct}%`)
  })

  // Verify integrity BEFORE handing anything to the (destructive) restore.
  status(`Checking the download…`)
  const sha = await sha256FileStream(blobPath)
  if (sidecar.sha256 && sha !== sidecar.sha256) {
    try {
      unlinkSync(blobPath)
    } catch {
      /* ignore */
    }
    throw new Error('cloud-pull: checksum mismatch — the downloaded backup is corrupt')
  }

  // Decrypt if the blob was passphrase-encrypted.
  let archivePath = blobPath
  if (sidecar.encrypted) {
    if (!creds.passphrase) throw new Error('cloud-pull: this backup is encrypted — a passphrase is required')
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
    try {
      unlinkSync(blobPath)
    } catch {
      /* ignore */
    }
    archivePath = plainPath
  }

  // Hand the resolved path back to the bash orchestrator.
  if (env.CAVECMS_RESTORE_PULL_OUT) {
    writeFileSync(env.CAVECMS_RESTORE_PULL_OUT, archivePath, { mode: 0o600 })
  }
  // Wipe the plaintext creds file (passphrase + token).
  try {
    unlinkSync(credsFile)
  } catch {
    /* ignore */
  }
  return { archivePath, encrypted: sidecar.encrypted === true }
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
