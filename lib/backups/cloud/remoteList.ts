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

// Resolve the provider's backup folder once and persist its id on the
// connection, so every later backup/list uses the SAME folder. Called right
// after a successful connect — this is what prevents duplicate "CaveCMS
// Backups" folders forming when the post-backup reconcile is delayed/failed.
// Best-effort; gdrive only (OneDrive's AppFolder is a fixed special folder).
export async function resolveAndPersistFolder(provider: CloudProvider): Promise<void> {
  if (provider !== 'gdrive') return
  const cfg = await getSetting('backups')
  const conn = cfg[provider]
  if (!conn?.connected || !conn.refreshToken || conn.folderId) return
  const refreshToken = decryptSecret(conn.refreshToken, refreshAad(provider))
  let rotated: string | null = null
  const dest = createDestination({
    provider,
    clientId: getClientId(provider),
    clientSecret: getClientSecret(provider),
    refreshToken,
    folderId: undefined,
    onRotate: (rt) => {
      rotated = rt
    },
  })
  const folderId = await dest.ensureFolder()
  await updateSettingValue(
    'backups',
    (cur) => ({
      ...cur,
      [provider]: {
        ...cur[provider],
        folderId,
        ...(rotated ? { refreshToken: encryptSecret(rotated, refreshAad(provider)) } : {}),
      },
    }),
    null,
  )
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

  const rows: RemoteBackupRow[] = []

  // FAST PATH: backups whose display metadata is stamped on the blob itself (the
  // gdrive `appProperties` returned inline by list()) need NO extra round-trip —
  // build the row straight from `blob.meta`. This is what makes "Show backups"
  // sub-second: a single list() call covers the whole folder.
  const needSidecar: typeof blobs = []
  for (const blob of blobs) {
    if (blob.meta) {
      const compat = compatFor({
        version: blob.meta.version ?? '0.0.0',
        migratorEncoding: blob.meta.migratorEncoding ?? 'unknown',
      })
      rows.push({
        remoteId: blob.remoteId,
        name: blob.name,
        sizeBytes: blob.sizeBytes,
        createdAt: blob.meta.createdAt ?? blob.createdAt,
        version: blob.meta.version ?? '0.0.0',
        encrypted: blob.meta.encrypted === true,
        includeEnv: blob.meta.includeEnv === true,
        compatible: compat.compatible,
        compatNote: compat.note,
      })
    } else {
      needSidecar.push(blob)
    }
  }

  // SLOW PATH (older gdrive backups predating the inline metadata, AND every
  // OneDrive backup — Graph has no app-private property we can read back from a
  // children listing): fall back to the cleartext sidecar (.meta.json). The
  // access token is already cached by ensureFolder()+list(), so these downloads
  // run CONCURRENTLY (bounded) — one round-trip deep instead of N sequential.
  const withSidecar = needSidecar
    .map((blob) => ({ blob, sidecar: byName.get(`${blob.name}.meta.json`) }))
    .filter((x): x is { blob: (typeof blobs)[number]; sidecar: (typeof entries)[number] } =>
      Boolean(x.sidecar),
    ) // drop orphan blobs with no metadata

  const scratch = mkdtempSync(join(tmpdir(), 'cavecms-remote-list-'))
  const SIDECAR_CONCURRENCY = 8
  try {
    for (let i = 0; i < withSidecar.length; i += SIDECAR_CONCURRENCY) {
      const batch = withSidecar.slice(i, i + SIDECAR_CONCURRENCY)
      const batchRows = await Promise.all(
        batch.map(async ({ blob, sidecar }): Promise<RemoteBackupRow | null> => {
          const p = join(scratch, `${blob.remoteId}.json`)
          try {
            await dest.download(sidecar.remoteId, p, () => {})
            const sc = JSON.parse(readFileSync(p, 'utf8'))
            const compat = compatFor({
              version: sc.version ?? '0.0.0',
              migratorEncoding: sc.migratorEncoding ?? 'unknown',
            })
            return {
              remoteId: blob.remoteId,
              name: blob.name,
              sizeBytes: blob.sizeBytes,
              createdAt: sc.createdAt ?? blob.createdAt,
              version: sc.version ?? '0.0.0',
              encrypted: sc.encrypted === true,
              includeEnv: sc.includeEnv === true,
              compatible: compat.compatible,
              compatNote: compat.note,
            }
          } catch {
            // Unreadable sidecar — skip this row rather than fail the whole list.
            return null
          }
        }),
      )
      for (const r of batchRows) if (r) rows.push(r)
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
