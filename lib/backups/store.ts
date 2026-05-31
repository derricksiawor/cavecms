// Backup-store helpers shared by the admin backups routes + the Settings page.
// Locating + listing + safe-naming live here so the route handlers stay thin.

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

// cavecms-backup-<YYYYMMDD>-<HHMMSS>-<commit7-40>.tar.gz[.age]
export const ARCHIVE_BASENAME_RE =
  /^cavecms-backup-\d{8}-\d{6}-[0-9a-f]{7,40}\.tar\.gz(?:\.age)?$/

export function isValidArchiveBasename(name: string): boolean {
  // No path separators, matches the canonical shape.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return ARCHIVE_BASENAME_RE.test(name)
}

/** Resolve the backup output dir from env, with a writable per-install fallback. */
export function resolveBackupDir(): string {
  const fromEnv = process.env.CAVECMS_BACKUP_DIR
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv)
  const stateDir = process.env.CAVECMS_STATE_DIR
  if (stateDir) return resolve(stateDir, '..', 'backups')
  try {
    const cwd = process.cwd()
    if (cwd && cwd !== '/') return resolve(cwd, 'backups')
  } catch {
    /* fall through */
  }
  return resolve(tmpdir(), 'cavecms-backups')
}

export interface BackupEntry {
  file: string
  sizeBytes: number
  createdAtMs: number
  encrypted: boolean
  version: string | null
  includeEnv: boolean | null
}

// Read each archive's manifest at most once per (file, mtime, size) — cached
// across requests so a settings-page render doesn't re-spawn tar for unchanged
// archives.
interface ManifestMeta {
  version: string | null
  includeEnv: boolean | null
}
const manifestCache = new Map<string, ManifestMeta>()

// Cap how many manifests we read per list call (bounded synchronous tar spawns
// on the request path / SSR render). Retention keeps ~5, but a bumped
// CAVECMS_BACKUP_KEEP or a stalled prune could leave more; older archives list
// without version/includeEnv rather than blocking the event loop on N tar forks.
const MAX_MANIFEST_READS = 12

function readManifestMeta(dir: string, file: string, mtimeMs: number, size: number): ManifestMeta {
  const key = `${file}:${Math.round(mtimeMs)}:${size}`
  const cached = manifestCache.get(key)
  if (cached) return cached
  let meta: ManifestMeta = { version: null, includeEnv: null }
  try {
    const raw = execFileSync('tar', ['-xzO', '-f', join(dir, file), 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
    const m = JSON.parse(raw)
    meta = {
      version: typeof m?.cavecms?.version === 'string' ? m.cavecms.version : null,
      includeEnv: typeof m?.env?.included === 'boolean' ? m.env.included : null,
    }
  } catch {
    /* unreadable/corrupt/slow manifest — leave nulls (still listed) */
  }
  manifestCache.set(key, meta)
  // Bound cache growth.
  if (manifestCache.size > 64) {
    const firstKey = manifestCache.keys().next().value
    if (firstKey) manifestCache.delete(firstKey)
  }
  return meta
}

/** List backups newest-first, reading each plaintext archive's manifest. */
export function listBackups(): BackupEntry[] {
  const dir = resolveBackupDir()
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  // Stat + filter first, sort by recency, THEN read manifests for the newest N.
  const stated: { file: string; sizeBytes: number; createdAtMs: number; encrypted: boolean }[] = []
  for (const file of names) {
    if (!isValidArchiveBasename(file)) continue
    let st
    try {
      st = statSync(join(dir, file))
    } catch {
      continue
    }
    if (!st.isFile()) continue
    stated.push({
      file,
      sizeBytes: st.size,
      createdAtMs: st.mtimeMs,
      encrypted: file.endsWith('.age'),
    })
  }
  stated.sort((a, b) => b.createdAtMs - a.createdAtMs)

  let manifestReads = 0
  return stated.map((s) => {
    let version: string | null = null
    let includeEnv: boolean | null = null
    if (!s.encrypted && manifestReads < MAX_MANIFEST_READS) {
      manifestReads++
      const meta = readManifestMeta(dir, s.file, s.createdAtMs, s.sizeBytes)
      version = meta.version
      includeEnv = meta.includeEnv
    }
    return {
      file: s.file,
      sizeBytes: s.sizeBytes,
      createdAtMs: s.createdAtMs,
      encrypted: s.encrypted,
      version,
      includeEnv,
    }
  })
}

/** Move an archive to a sibling `.trash-<ts>/` dir (never rm). Returns the new path. */
export function trashArchive(file: string, stamp: string): string {
  if (!isValidArchiveBasename(file)) {
    throw new Error('invalid archive name')
  }
  const dir = resolveBackupDir()
  const src = join(dir, file)
  if (!existsSync(src)) throw new Error('not found')
  const trashDir = join(dir, `.trash-${stamp}`)
  mkdirSync(trashDir, { recursive: true })
  const dst = join(trashDir, file)
  renameSync(src, dst)
  return dst
}
