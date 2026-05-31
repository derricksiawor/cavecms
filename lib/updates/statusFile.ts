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
  /** Terminal success on a laptop/dev install: the new version is on disk
   *  but a bare-`node` process can't self-restart, so the operator must
   *  restart it manually to load the new code. Treated as a success
   *  (no rollback); the modal renders a "restart to finish" affordance. */
  | 'restart_required'
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
  /** ISO timestamp until which the post-completion watchdog is
   *  guarding the install. Set by the orchestrator at the end of a
   *  successful update (typically completedAt + 1h). The UI surfaces
   *  a "we'll keep an eye on your site for the next hour" hint while
   *  this is in the future and the state is `completed`. Cleared
   *  by the watchdog when the window elapses or when it triggers a
   *  rollback. */
  watchdogUntil?: string | null
}

const TERMINAL_STATES: ReadonlySet<UpdateState> = new Set<UpdateState>([
  'idle',
  'completed',
  'restart_required',
  'failed',
  'rolled_back',
])

const SYSTEM_DEFAULT_PATH = '/var/lib/cavecms/update-status.json'
const ALLOWED_SYSTEM_DIR_PREFIXES: readonly string[] = ['/var/lib/cavecms/']

let statusPathOverride: string | null = null

/**
 * Test-only path override. The provided path bypasses the allowlist
 * check — only legitimate test/dev callers use this hook.
 */
export function __setStatusPathForTests(path: string | null): void {
  statusPathOverride = path
}

/**
 * Per-install state directory. Set by the CLI (`create-cavecms` writes
 * `CAVECMS_STATE_DIR=<install dir>/.cavecms-state` into env.production),
 * provisioned at install time as the same user that owns the install.
 * This avoids the chicken-and-egg where /var/lib/cavecms/ requires a
 * pm2-daemon-wide restart for the supplementary `cavecmsstate` group
 * to take effect — instead we keep the status file inside the install
 * dir, which the running app user already owns.
 *
 * Legacy installs (upgraded in place from pre-0.1.27 releases) won't
 * have CAVECMS_STATE_DIR stamped. For those we derive a sibling
 * `.cavecms-state` next to the standalone `process.cwd()` — that
 * directory is by-definition owned by the runtime user (otherwise the
 * Node listener couldn't have booted there), so writes will never
 * EACCES. The derived path is added to the runtime-allowlist below.
 *
 * Returns null only in dev/test contexts where neither env var nor a
 * usable cwd is available — callers then fall back to the system path.
 */
function getInstallStateDir(): string | null {
  const raw = process.env.CAVECMS_STATE_DIR
  if (raw) return resolve(raw)
  // Legacy-install fallback. process.cwd() in a Next.js standalone
  // build is `<install>/.next/standalone`; the runtime user owns it.
  // We stash state in `<cwd>/.cavecms-state/` so the on-demand mkdir
  // below never EACCES on the system path.
  try {
    const cwd = process.cwd()
    if (cwd && cwd !== '/') return resolve(`${cwd}/.cavecms-state`)
  } catch {
    /* very-restricted runtimes (some test harnesses) — null fallback */
  }
  return null
}

function ensureAllowedPath(candidate: string): string {
  const resolved = resolve(candidate)
  const isProd = process.env.NODE_ENV === 'production'
  // /tmp + os.tmpdir() are ALLOWED in dev/test only. On production
  // /tmp is world-writable and prone to symlink-precreate attacks —
  // an attacker (or another low-priv process) can create the status
  // file as a symlink to /etc/cron.d/cavecms.cron before we open it.
  // Our atomic-rename via writeFileSync would then follow the symlink
  // and stomp the target. In production we lock the allowlist to
  // /var/lib/cavecms/* (system path) OR <CAVECMS_STATE_DIR>/* (the
  // per-install path the CLI provisioned).
  if (!isProd) {
    if (resolved.startsWith(resolve(tmpdir()) + '/')) return resolved
    if (resolved.startsWith('/tmp/')) return resolved
  }
  for (const prefix of ALLOWED_SYSTEM_DIR_PREFIXES) {
    if (resolved === prefix.replace(/\/$/, '') || resolved.startsWith(prefix)) {
      return resolved
    }
  }
  const stateDir = getInstallStateDir()
  if (stateDir) {
    if (resolved === stateDir || resolved.startsWith(stateDir + '/')) {
      return resolved
    }
  }
  throw new Error(`status path not allowed: ${candidate}`)
}

export function getStatusPath(): string {
  if (statusPathOverride !== null) return statusPathOverride
  const fromEnv = process.env.CAVECMS_UPDATE_STATUS_PATH
  if (fromEnv) return ensureAllowedPath(fromEnv)
  // No explicit status-path env. Prefer the per-install state dir
  // (CLI-provisioned, no pm2-daemon-restart needed) over the system
  // path (/var/lib/cavecms/) which requires the daemon to have been
  // restarted with the cavecmsstate supplementary group.
  const stateDir = getInstallStateDir()
  if (stateDir) {
    return ensureAllowedPath(`${stateDir}/update-status.json`)
  }
  return ensureAllowedPath(SYSTEM_DEFAULT_PATH)
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
  // We distinguish "file does not exist" (ENOENT — no update has been
  // run, clean dashboard state) from "file exists but unreadable"
  // (EACCES / permission error — operator state-dir mode bug; would
  // otherwise surface as stale "Up to date" forever). On ENOENT we
  // return null silently; on every other error we log a structured
  // warning so the operator sees a forensic trail.
  let raw: string
  try {
    raw = readFileSync(getStatusPath(), 'utf8')
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code
    if (errno !== 'ENOENT') {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'updates_read_status_failed',
          code: errno ?? 'UNKNOWN',
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
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
// Check whether the PID-holding process is one of our update scripts
// by reading /proc/<pid>/cmdline (Linux). Closes two gaps:
//   1. EPERM on cross-user PIDs — kill(0) returns EPERM if the lock-
//      holding PID exists but is owned by a different user. Without
//      this check, we'd treat ANY alive PID at that number as "our
//      orchestrator" and refuse new updates for the full mtime
//      stale window.
//   2. PID recycling — on a busy host, the orchestrator's PID can
//      recycle to an unrelated process within seconds of orchestrator
//      death. kill(0) returns success against the recycled PID,
//      lockIsStale() falsely returns false, operator gets stuck.
// Returns true ONLY when /proc/<pid>/cmdline confirms one of our
// scripts. Returns null on platforms without /proc (macOS dev).
function pidIsCaveCmsScript(pid: number): boolean | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    // /proc cmdline uses NUL separators. Look for our known script
    // names anywhere in the joined cmdline. Both the orchestrator and
    // watchdog scripts qualify.
    const joined = raw.replace(/\0/g, ' ')
    return (
      joined.includes('cavecms-update.sh') ||
      joined.includes('cavecms-watchdog.sh')
    )
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT — process is gone.
    if (code === 'ENOENT') return false
    // EACCES — different user owns /proc/<pid>; we can't read its
    // cmdline. Treat as "unknown" — fall back to PID liveness only.
    // ENOTDIR / not Linux → null (caller falls through).
    if (code === 'EACCES') return null
    return null
  }
}

export function lockIsStale(): boolean {
  try {
    statSync(getLockPath())
  } catch {
    // No lock file → not stale (and nothing to clean up).
    return false
  }
  // Primary check: PID liveness + script-identity. We need BOTH:
  //   - kill(pid, 0) confirms a process exists at that PID
  //   - /proc/<pid>/cmdline confirms it's our script (closes PID-
  //     recycling false positives, closes cross-user EPERM stalls)
  const pid = readLockPid()
  if (pid !== null) {
    let aliveByKill: boolean | null = null
    try {
      process.kill(pid, 0)
      aliveByKill = true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') aliveByKill = false
      else aliveByKill = null // EPERM or unknown — can't decide via kill
    }
    if (aliveByKill === false) return true // definitively dead

    const isOurs = pidIsCaveCmsScript(pid)
    if (isOurs === false) {
      // Process exists at that PID but it's NOT one of our scripts.
      // Either PID recycled to an unrelated process OR something
      // else stamped this PID into our lock. Lock is effectively
      // stale.
      return true
    }
    if (isOurs === true) {
      // Definitely our script. We already returned early on
      // aliveByKill === false, so the PID is either alive (kill
      // returned true) or "EPERM but cmdline matched ours" — either
      // way, NOT stale.
      return false
    }
    // isOurs === null (no /proc, e.g. macOS dev) — fall through
    // to the mtime heuristic. On macOS dev we can't do better.
  }
  // Fallback (unstamped lock from an older apply route, no /proc
  // available, or readLockPid failure): use the status file's
  // `updatedAt`.
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
