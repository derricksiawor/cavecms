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
  const entries: BackupEntry[] = []
  for (const file of names) {
    if (!isValidArchiveBasename(file)) continue
    let st
    try {
      st = statSync(join(dir, file))
    } catch {
      continue
    }
    if (!st.isFile()) continue
    const encrypted = file.endsWith('.age')
    let version: string | null = null
    let includeEnv: boolean | null = null
    if (!encrypted) {
      try {
        const raw = execFileSync('tar', ['-xzO', '-f', join(dir, file), 'manifest.json'], {
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        })
        const m = JSON.parse(raw)
        version = typeof m?.cavecms?.version === 'string' ? m.cavecms.version : null
        includeEnv = typeof m?.env?.included === 'boolean' ? m.env.included : null
      } catch {
        /* unreadable manifest — leave nulls */
      }
    }
    entries.push({
      file,
      sizeBytes: st.size,
      createdAtMs: st.mtimeMs,
      encrypted,
      version,
      includeEnv,
    })
  }
  entries.sort((a, b) => b.createdAtMs - a.createdAtMs)
  return entries
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
