import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInstallStateDir } from '@/lib/backups/statusPath'
import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  decryptSecret,
  encryptSecret,
  AAD_BACKUP_GDRIVE_REFRESH,
  AAD_BACKUP_ONEDRIVE_REFRESH,
  AAD_BACKUP_PASSPHRASE,
} from '@/lib/security/secretCipher'
import { getClientId, type CloudProvider } from '@/lib/backups/cloud/clients'

// The plaintext refresh token + passphrase are handed to the spawned engine via
// a mode-600 file in the install state dir (never argv / never the env-var
// allowlist). The engine writes any rotated refresh token / resolved folder id
// back to the OUT file, which the app re-encrypts + persists after completion.

export class PassphraseRequiredError extends Error {
  constructor() {
    super('passphrase_required_for_secrets')
    this.name = 'PassphraseRequiredError'
  }
}

function credsDir(): string {
  return getInstallStateDir() ?? tmpdir()
}
function credsInPath(): string {
  return join(credsDir(), '.cavecms-cloud-creds-in.json')
}
function credsOutPath(): string {
  return join(credsDir(), '.cavecms-cloud-creds-out.json')
}
function refreshAad(provider: CloudProvider): string {
  return provider === 'gdrive' ? AAD_BACKUP_GDRIVE_REFRESH : AAD_BACKUP_ONEDRIVE_REFRESH
}

// Build the env additions for a cloud-destined backup, writing the mode-600
// creds file as a side effect. Returns null when the active destination is
// local or not connected (→ a plain local backup). Throws
// PassphraseRequiredError if `includeEnv` is requested for a cloud destination
// without a passphrase configured.
export async function prepareBackupCloudEnv(
  includeEnv: boolean,
): Promise<Record<string, string> | null> {
  const cfg = await getSetting('backups')
  const dest = cfg.destination
  if (dest === 'local') return null
  const conn = cfg[dest]
  if (!conn?.connected || !conn.refreshToken) return null // misconfig → local

  if (includeEnv && !cfg.encryption.passphraseEnabled) {
    throw new PassphraseRequiredError()
  }

  const creds: {
    provider: CloudProvider
    clientId: string
    refreshToken: string
    folderId?: string
    passphrase?: string
  } = {
    provider: dest,
    clientId: getClientId(dest),
    refreshToken: decryptSecret(conn.refreshToken, refreshAad(dest)),
    folderId: conn.folderId,
  }
  if (cfg.encryption.passphraseEnabled && cfg.encryption.passphrase) {
    creds.passphrase = decryptSecret(cfg.encryption.passphrase, AAD_BACKUP_PASSPHRASE)
  }

  const inPath = credsInPath()
  const outPath = credsOutPath()
  writeFileSync(inPath, JSON.stringify(creds), { mode: 0o600 })
  // Clear any stale out file from a prior run so reconcile can't read garbage.
  try {
    if (existsSync(outPath)) unlinkSync(outPath)
  } catch {
    /* ignore */
  }

  return {
    CAVECMS_BACKUP_DESTINATION: dest,
    CAVECMS_BACKUP_CLOUD_CREDS_FILE: inPath,
    CAVECMS_BACKUP_CLOUD_CREDS_OUT: outPath,
    CAVECMS_BACKUP_REMOTE_RETENTION: String(cfg.remoteRetention),
    CAVECMS_BACKUP_KEEP_LOCAL: cfg.keepLocalCopy ? '1' : '0',
  }
}

// After a backup completes, persist any rotated refresh token + resolved folder
// id the engine wrote. Best-effort + idempotent — safe to call on every
// terminal poll.
export async function reconcileBackupCloudCredsOut(): Promise<void> {
  const outPath = credsOutPath()
  if (!existsSync(outPath)) return
  let payload: { provider?: CloudProvider; refreshToken?: string; folderId?: string }
  try {
    payload = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch {
    try {
      unlinkSync(outPath)
    } catch {
      /* ignore */
    }
    return
  }
  const provider = payload.provider
  if (provider !== 'gdrive' && provider !== 'onedrive') {
    try {
      unlinkSync(outPath)
    } catch {
      /* ignore */
    }
    return
  }
  await updateSettingValue(
    'backups',
    (cur) => {
      const conn = { ...cur[provider] }
      if (payload.refreshToken) {
        conn.refreshToken = encryptSecret(payload.refreshToken, refreshAad(provider))
      }
      if (payload.folderId) conn.folderId = payload.folderId
      return { ...cur, [provider]: conn }
    },
    null,
  )
  try {
    unlinkSync(outPath)
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(credsInPath())) unlinkSync(credsInPath())
  } catch {
    /* ignore */
  }
}
