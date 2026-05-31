// Atomic status-file engine for the backup + restore progress UIs.
//
// Same hand-off mechanism as the update flow (lib/updates/statusFile.ts): the
// orchestrator scripts run detached and write a flat JSON file that the web
// side polls. Restore restarts the app mid-flight, so a file on disk is the
// only progress channel that survives. Backup doesn't restart but still uses
// the file so the dashboard can navigate away and poll back.
//
// Two independent status files — `backup-status.json` and
// `restore-status.json` — so a backup and a restore never clobber each other's
// progress. Both share the path-allowlist discipline from ./statusPath.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs'
import { dirname } from 'node:path'
import { ensureAllowedStatusPath, getInstallStateDir } from '@/lib/backups/statusPath'
import {
  BACKUP_STALE_AFTER_MS,
  BACKUP_TERMINAL_TTL_MS,
  BACKUP_TOTAL_STEPS,
  RESTORE_TOTAL_STEPS,
} from './constants'

export type BackupState = 'idle' | 'running' | 'completed' | 'failed'

export type RestoreState =
  | 'idle'
  | 'validating'
  | 'restoring'
  | 'restarting'
  | 'completed'
  /** Terminal success on a laptop/dev install: data restored, but a bare-node
   *  process can't self-restart, so the operator must restart it manually. */
  | 'restart_required'
  | 'failed'
  | 'rolled_back'

interface PhaseStatusBase {
  step: number
  totalSteps: number
  startedAt: string
  updatedAt: string
  /** Human-readable label for the current step. */
  stepLabel?: string
  /** Free-form error message when state is failed/rolled_back. */
  error?: string
  /** Last lines of script stderr/stdout for the modal's "details". */
  log?: string
  /** Humanised archive descriptor for terminal copy (e.g. "Today, 2:14 PM"). */
  archiveLabel?: string
}

export interface BackupStatus extends PhaseStatusBase {
  state: BackupState
}

export interface RestoreStatus extends PhaseStatusBase {
  state: RestoreState
}

const BACKUP_TERMINAL: ReadonlySet<BackupState> = new Set<BackupState>([
  'idle',
  'completed',
  'failed',
])
const RESTORE_TERMINAL: ReadonlySet<RestoreState> = new Set<RestoreState>([
  'idle',
  'completed',
  'restart_required',
  'failed',
  'rolled_back',
])

// ---------------------------------------------------------------------------
// Generic engine — one set of functions parameterized by filename + env var +
// default totalSteps + a per-engine test-override holder.
// ---------------------------------------------------------------------------

interface EngineConfig<S extends string> {
  filename: string
  envVar: string
  defaultTotalSteps: number
  terminal: ReadonlySet<S>
}

interface EngineStatus<S extends string> extends PhaseStatusBase {
  state: S
}

interface StatusEngine<S extends string> {
  getPath(): string
  read(): EngineStatus<S> | null
  write(partial: Partial<EngineStatus<S>>): EngineStatus<S>
  clear(): void
  isStale(s: EngineStatus<S>): boolean
  isStaleTerminal(s: EngineStatus<S>): boolean
  setPathForTests(path: string | null): void
  acquireLock(): number
  releaseLock(fd: number | null): void
}

function makeEngine<S extends string>(cfg: EngineConfig<S>): StatusEngine<S> {
  let override: string | null = null

  function getPath(): string {
    if (override !== null) return override
    const fromEnv = process.env[cfg.envVar]
    if (fromEnv) return ensureAllowedStatusPath(fromEnv)
    const stateDir = getInstallStateDir()
    if (stateDir) return ensureAllowedStatusPath(`${stateDir}/${cfg.filename}`)
    return ensureAllowedStatusPath(`/var/lib/cavecms/${cfg.filename}`)
  }

  function safeParse(raw: string): EngineStatus<S> | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { state?: unknown }).state !== 'string' ||
      typeof (parsed as { step?: unknown }).step !== 'number' ||
      typeof (parsed as { totalSteps?: unknown }).totalSteps !== 'number' ||
      typeof (parsed as { startedAt?: unknown }).startedAt !== 'string' ||
      typeof (parsed as { updatedAt?: unknown }).updatedAt !== 'string'
    ) {
      return null
    }
    return parsed as EngineStatus<S>
  }

  function read(): EngineStatus<S> | null {
    let raw: string
    try {
      raw = readFileSync(getPath(), 'utf8')
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code
      if (errno !== 'ENOENT') {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'backups_read_status_failed',
            file: cfg.filename,
            code: errno ?? 'UNKNOWN',
            err: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      return null
    }
    return safeParse(raw)
  }

  function write(partial: Partial<EngineStatus<S>>): EngineStatus<S> {
    const path = getPath()
    const existing = read()
    const now = new Date().toISOString()
    const merged = {
      state: 'idle' as S,
      step: 0,
      totalSteps: cfg.defaultTotalSteps,
      startedAt: now,
      ...(existing ?? {}),
      ...partial,
      updatedAt: now,
    } as EngineStatus<S>
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, JSON.stringify(merged, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    renameSync(tmp, path)
    return merged
  }

  function clear(): void {
    try {
      unlinkSync(getPath())
    } catch {
      /* ENOENT — already cleared */
    }
  }

  function isStale(s: EngineStatus<S>): boolean {
    if (cfg.terminal.has(s.state)) return false
    const t = Date.parse(s.updatedAt)
    if (Number.isNaN(t)) return true
    return Date.now() - t > BACKUP_STALE_AFTER_MS
  }

  function isStaleTerminal(s: EngineStatus<S>): boolean {
    if (!cfg.terminal.has(s.state) || s.state === ('idle' as S)) return false
    const t = Date.parse(s.updatedAt)
    if (Number.isNaN(t)) return true
    return Date.now() - t > BACKUP_TERMINAL_TTL_MS
  }

  function setPathForTests(path: string | null): void {
    override = path
  }

  function lockPath(): string {
    return `${getPath()}.lock`
  }

  function acquireLock(): number {
    const path = lockPath()
    mkdirSync(dirname(path), { recursive: true })
    return openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    )
  }

  function releaseLock(fd: number | null): void {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(lockPath())
    } catch {
      /* already gone */
    }
  }

  return {
    getPath,
    read,
    write,
    clear,
    isStale,
    isStaleTerminal,
    setPathForTests,
    acquireLock,
    releaseLock,
  }
}

const backupEngine = makeEngine<BackupState>({
  filename: 'backup-status.json',
  envVar: 'CAVECMS_BACKUP_STATUS_PATH',
  defaultTotalSteps: BACKUP_TOTAL_STEPS,
  terminal: BACKUP_TERMINAL,
})

const restoreEngine = makeEngine<RestoreState>({
  filename: 'restore-status.json',
  envVar: 'CAVECMS_RESTORE_STATUS_PATH',
  defaultTotalSteps: RESTORE_TOTAL_STEPS,
  terminal: RESTORE_TERMINAL,
})

// --- Backup exports ---
export const getBackupStatusPath = backupEngine.getPath
export const readBackupStatus = backupEngine.read
export const writeBackupStatus = backupEngine.write
export const clearBackupStatus = backupEngine.clear
export const isBackupStale = backupEngine.isStale
export const isBackupStaleTerminal = backupEngine.isStaleTerminal
export const __setBackupStatusPathForTests = backupEngine.setPathForTests
export const acquireBackupLock = backupEngine.acquireLock
export const releaseBackupLock = backupEngine.releaseLock

// --- Restore exports ---
export const getRestoreStatusPath = restoreEngine.getPath
export const readRestoreStatus = restoreEngine.read
export const writeRestoreStatus = restoreEngine.write
export const clearRestoreStatus = restoreEngine.clear
export const isRestoreStale = restoreEngine.isStale
export const isRestoreStaleTerminal = restoreEngine.isStaleTerminal
export const __setRestoreStatusPathForTests = restoreEngine.setPathForTests
export const acquireRestoreLock = restoreEngine.acquireLock
export const releaseRestoreLock = restoreEngine.releaseLock
