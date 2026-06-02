import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSetting } from '@/lib/cms/getSettings'
import { updateSettingValue } from '@/lib/cms/writeSetting'
import {
  decryptSecret,
  encryptSecret,
  AAD_BACKUP_GDRIVE_REFRESH,
  AAD_BACKUP_ONEDRIVE_REFRESH,
} from '@/lib/security/secretCipher'
import { getClientId, getClientSecret, type CloudProvider } from '@/lib/backups/cloud/clients'
import { createDestination } from '@/lib/backups/cloud/destClient'
import { installVersion } from '@/lib/backups/cloud/version'

export interface RemoteBackupRow {
  remoteId: string
  name: string
  sizeBytes: number
  createdAt: string | null
  version: string
  encrypted: boolean
  includeEnv: boolean
  compatible: boolean
  compatNote: string | null
}

const ARCHIVE_RE = /^cavecms-backup-.+\.(tar\.gz|tar\.gz\.enc|tar\.gz\.age)$/

function refreshAad(p: CloudProvider): string {
  return p === 'gdrive' ? AAD_BACKUP_GDRIVE_REFRESH : AAD_BACKUP_ONEDRIVE_REFRESH
}

// Parse "1.2.3" → [1,2,3]; missing parts → 0. Pre-release tags ignored.
function semver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '')
  if (!m) return [0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
function gte(a: string, b: string): boolean {
  const [a0, a1, a2] = semver(a)
  const [b0, b1, b2] = semver(b)
  if (a0 !== b0) return a0 > b0
  if (a1 !== b1) return a1 > b1
  return a2 >= b2
}

// Lightweight compat verdict for the badge. The authoritative gate still runs
// at restore time (backup-lib compat in cavecms-restore.sh). Mirrors its rules:
// refuse a backup newer than this install, or one without the drizzle-hash
// migrator encoding.
function compatFor(sidecar: {
  version: string
  migratorEncoding: string
}): { compatible: boolean; note: string | null } {
  if (sidecar.migratorEncoding !== 'drizzle-hash') {
    return { compatible: false, note: 'Made by an older, incompatible version.' }
  }
  if (!gte(installVersion(), sidecar.version)) {
    return { compatible: false, note: `Made by a newer version (${sidecar.version}). Update first.` }
  }
  return { compatible: true, note: null }
}

// List the remote backups for a connected provider, reading the cleartext
// sidecars for metadata + a compat badge. Persists any rotated refresh token.
export async function listRemoteBackups(provider: CloudProvider): Promise<RemoteBackupRow[]> {
  const cfg = await getSetting('backups')
  const conn = cfg[provider]
  if (!conn?.connected || !conn.refreshToken) {
    throw new Error('not_connected')
  }
  const refreshToken = decryptSecret(conn.refreshToken, refreshAad(provider))

  let rotated: string | null = null
  const dest = createDestination({
    provider,
    clientId: getClientId(provider),
    clientSecret: getClientSecret(provider),
    refreshToken,
    folderId: conn.folderId,
    onRotate: (rt) => {
      rotated = rt
    },
  })
  await dest.ensureFolder()
  const entries = await dest.list()
  const byName = new Map(entries.map((e) => [e.name, e]))
  const blobs = entries.filter((e) => ARCHIVE_RE.test(e.name))

  const scratch = mkdtempSync(join(tmpdir(), 'cavecms-remote-list-'))
  const rows: RemoteBackupRow[] = []
  try {
    for (const blob of blobs) {
      const sidecarEntry = byName.get(`${blob.name}.meta.json`)
      if (!sidecarEntry) continue // orphan blob without metadata — skip
      const p = join(scratch, `${blob.remoteId}.json`)
      try {
        await dest.download(sidecarEntry.remoteId, p, () => {})
        const sc = JSON.parse(readFileSync(p, 'utf8'))
        const compat = compatFor({
          version: sc.version ?? '0.0.0',
          migratorEncoding: sc.migratorEncoding ?? 'unknown',
        })
        rows.push({
          remoteId: blob.remoteId,
          name: blob.name,
          sizeBytes: blob.sizeBytes,
          createdAt: sc.createdAt ?? blob.createdAt,
          version: sc.version ?? '0.0.0',
          encrypted: sc.encrypted === true,
          includeEnv: sc.includeEnv === true,
          compatible: compat.compatible,
          compatNote: compat.note,
        })
      } catch {
        // Unreadable sidecar — skip this row rather than fail the whole list.
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (rotated) {
    await updateSettingValue(
      'backups',
      (cur) => ({
        ...cur,
        [provider]: { ...cur[provider], refreshToken: encryptSecret(rotated!, refreshAad(provider)) },
      }),
      null,
    )
  }

  // Newest first.
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return rows
}
