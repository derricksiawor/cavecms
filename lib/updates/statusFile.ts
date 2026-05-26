// Atomic status-file engine for the live update progress UI.
//
// Why a file (and not a DB row)? The update orchestration script runs
// AFTER spawning detached from the Next.js process — by the time pm2
// reload kicks in mid-update, the Node side that started the update
// is gone. A flat file on disk is the single hand-off mechanism that
// survives the app restart. The web side polls this file; the shell
// script writes it.
//
// Atomic write protocol: write to `<path>.tmp.<pid>` then rename(2)
// onto the final path. rename(2) is POSIX-atomic within a single
// filesystem — readers either see the old file or the new one, never
// a half-written intermediate.
//
// PATH SAFETY: the status file path is taken from an env var
// (`CAVECMS_UPDATE_STATUS_PATH`). Without restriction, a hostile env
// would let a status writer overwrite arbitrary files (e.g. /etc/
// cron.d/*). We hard-allowlist the parent directory to one of
// `/var/lib/cavecms/`, the per-platform temp dir, or an explicit
// dev/test override registered through `__setStatusPathForTests`.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  UPDATE_STALE_AFTER_MS,
  UPDATE_TERMINAL_TTL_MS,
  UPDATE_TOTAL_STEPS,
} from './constants'

export type UpdateState =
  | 'idle'
  | 'preflight'
  | 'updating'
  | 'restarting'
  | 'completed'
  | 'failed'
  | 'rolled_back'

export interface UpdateStatus {
  state: UpdateState
  step: number
  totalSteps: number
  startedAt: string
  updatedAt: string
  fromSha?: string
  toSha?: string
  /** Human-readable label for the current step. */
  stepLabel?: string
  /** Free-form error message when state is failed/rolled_back. */
  error?: string
  /** Last 16 lines of script stderr/stdout for the modal's "details". */
  log?: string
}

const TERMINAL_STATES: ReadonlySet<UpdateState> = new Set<UpdateState>([
  'idle',
  'completed',
  'failed',
  'rolled_back',
])

const DEFAULT_PATH = '/var/lib/cavecms/update-status.json'
const ALLOWED_DIR_PREFIXES: readonly string[] = ['/var/lib/cavecms/']

let statusPathOverride: string | null = null

/**
 * Test-only path override. The provided path bypasses the allowlist
 * check — only legitimate test/dev callers use this hook.
 */
export function __setStatusPathForTests(path: string | null): void {
  statusPathOverride = path
}

function ensureAllowedPath(candidate: string): string {
  const resolved = resolve(candidate)
  // Allow the per-platform temp dir (matches os.tmpdir() — on macOS
  // that's $TMPDIR i.e. /var/folders/.../T/, on Linux it's /tmp).
  if (resolved.startsWith(resolve(tmpdir()) + '/')) return resolved
  // Also explicitly allow literal /tmp/* for dev/test paths that
  // hardcode the Linux-default temp location. Both are widely-used
  // dev conventions; both are safe (not under /etc/, /usr/, etc.).
  if (resolved.startsWith('/tmp/')) return resolved
  for (const prefix of ALLOWED_DIR_PREFIXES) {
    if (resolved === prefix.replace(/\/$/, '') || resolved.startsWith(prefix)) {
      return resolved
    }
  }
  throw new Error(`status path not allowed: ${candidate}`)
}

export function getStatusPath(): string {
  if (statusPathOverride !== null) return statusPathOverride
  const fromEnv = process.env.CAVECMS_UPDATE_STATUS_PATH
  return ensureAllowedPath(fromEnv ?? DEFAULT_PATH)
}

function safeParse(raw: string): UpdateStatus | null {
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
  return parsed as UpdateStatus
}

export function readStatus(): UpdateStatus | null {
  let raw: string
  try {
    raw = readFileSync(getStatusPath(), 'utf8')
  } catch {
    return null
  }
  return safeParse(raw)
}

export function writeStatus(partial: Partial<UpdateStatus>): UpdateStatus {
  const path = getStatusPath()
  const existing = readStatus()
  const now = new Date().toISOString()
  const merged: UpdateStatus = {
    state: 'idle',
    step: 0,
    totalSteps: UPDATE_TOTAL_STEPS,
    startedAt: now,
    ...(existing ?? {}),
    ...partial,
    updatedAt: now,
  }
  // The parent directory is provisioned by setup.sh in production
  // (mode 2770, group cavecmsstate). In dev/test we create on demand;
  // the path allowlist already restricted us to /var/lib/cavecms or
  // the temp dir, so the on-demand mkdir can't escape either tree.
  mkdirSync(dirname(path), { recursive: true })
  // Use a random tmp suffix that works on both BSD and GNU date —
  // `date +%s%N` prints a literal %N on macOS, which would collide
  // across simultaneous writers.
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, JSON.stringify(merged, null, 2), {
    encoding: 'utf8',
    // Restrictive umask: only the owner can read/write the status
    // file — symlink and group-write attacks on a shared host can't
    // see our progress + can't poison the file.
    mode: 0o600,
    flag: 'wx',
  })
  renameSync(tmp, path)
  return merged
}

export function clearStatus(): void {
  try {
    unlinkSync(getStatusPath())
  } catch {
    // ENOENT is fine — already cleared.
  }
}

export function isStale(s: UpdateStatus): boolean {
  if (TERMINAL_STATES.has(s.state)) return false
  const t = Date.parse(s.updatedAt)
  if (Number.isNaN(t)) return true
  return Date.now() - t > UPDATE_STALE_AFTER_MS
}

export function isInProgress(s: UpdateStatus | null): boolean {
  if (!s) return false
  if (TERMINAL_STATES.has(s.state)) return false
  return !isStale(s)
}

/**
 * Terminal-state TTL — a `completed` / `failed` / `rolled_back`
 * status whose `updatedAt` is older than 24 h is treated as
 * irrelevant. Otherwise the dashboard banner would resurrect a
 * week-old completion the next time an operator logged in.
 */
export function isStaleTerminal(s: UpdateStatus): boolean {
  if (!TERMINAL_STATES.has(s.state) || s.state === 'idle') return false
  const t = Date.parse(s.updatedAt)
  if (Number.isNaN(t)) return true
  return Date.now() - t > UPDATE_TERMINAL_TTL_MS
}

/**
 * Atomic exclusive-create lock used by the apply route to prevent
 * two concurrent operators from launching two simultaneous update
 * scripts. The orchestrator script also acquires this lock as a
 * defence-in-depth and exits non-zero if held.
 *
 * Throws when another writer holds the lock (EEXIST). Caller is
 * responsible for `releaseUpdateLock()` on failure paths; on the
 * success path the orchestrator script's EXIT trap releases it.
 */
export function getLockPath(): string {
  const status = getStatusPath()
  return `${status}.lock`
}

export function acquireUpdateLock(): number {
  const path = getLockPath()
  mkdirSync(dirname(path), { recursive: true })
  // O_CREAT | O_EXCL — fails atomically if the file exists.
  // O_WRONLY because we don't read it.
  return openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  )
}

export function releaseUpdateLock(fd: number | null): void {
  if (fd !== null) {
    try {
      closeSync(fd)
    } catch {
      /* fd was already closed by the child or by Node teardown */
    }
  }
  try {
    unlinkSync(getLockPath())
  } catch {
    /* lock file already gone — orchestrator beat us to it */
  }
}

/**
 * Read the PID stamped into the lock file by the orchestrator
 * script at startup (`echo $$ > $LOCK_PATH`). Returns null if the
 * lock is unstamped (older orchestrator predating this protocol),
 * the file doesn't exist, or the contents aren't a valid integer.
 *
 * Used by `lockIsStale()` to do a process-liveness check that beats
 * the status-mtime heuristic: SIGKILL'd orchestrators look "fresh"
 * by status-mtime for 15 minutes but their PID is provably dead.
 */
export function readLockPid(): number | null {
  try {
    const raw = readFileSync(getLockPath(), 'utf8').trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Health check on the lock file — used by the apply route to detect
 * an orphaned lock (process crashed/SIGKILL'd before unlinking) so
 * the next apply can clean up automatically.
 *
 * We tie staleness to the STATUS FILE's `updatedAt` (advanced by
 * every `write_status` the orchestrator script makes) NOT to the
 * lock file's mtime. The lock is opened with O_EXCL and never
 * subsequently written, so its mtime never updates — a healthy
 * 30-minute update would otherwise register as stale at minute 15
 * and let a second operator acquire a second lock while the first
 * is still running.
 */
export function lockIsStale(): boolean {
  try {
    statSync(getLockPath())
  } catch {
    // No lock file → not stale (and nothing to clean up).
    return false
  }
  // Primary check: PID liveness. If the orchestrator stamped its PID
  // into the lock (newer apply route) we can probe the process
  // directly with kill(0). If the process is gone (ESRCH) the lock
  // is stale regardless of how recently the status file was written.
  // This closes the SIGKILL-orphans-15min-wedge gap where the
  // orchestrator dies untrappably but its status file's `updatedAt`
  // looks fresh — apply route would otherwise refuse new updates
  // for the full UPDATE_STALE_AFTER_MS window.
  const pid = readLockPid()
  if (pid !== null) {
    try {
      // POSIX kill(pid, 0) sends no signal but returns success only
      // if the caller has permission to signal the process — i.e.,
      // if the process exists. ESRCH means "no such process".
      process.kill(pid, 0)
      // Process is alive → lock NOT stale (regardless of status mtime).
      return false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') {
        // Definitively dead.
        return true
      }
      // EPERM means it exists but we can't signal it (different
      // user). Treat as alive — better to refuse a duplicate apply
      // than race a real running orchestrator.
      if (code === 'EPERM') return false
      // Anything else, fall through to the status-mtime heuristic.
    }
  }
  // Fallback (unstamped lock from an older apply route, or readLockPid
  // failure): use the status file's `updatedAt`.
  const status = readStatus()
  if (!status) {
    // Lock exists but status file is gone → the orchestrator
    // crashed between acquiring the lock and writing its first
    // status. Treat as stale.
    return true
  }
  const t = Date.parse(status.updatedAt)
  if (Number.isNaN(t)) return true
  return Date.now() - t > UPDATE_STALE_AFTER_MS
}
