// Detached-spawn helper for the backup + restore orchestrators, invoked from
// the admin backups routes. Mirrors the security posture of
// app/api/admin/updates/apply/route.ts (narrow env allowlist — secrets stay in
// the parent; O_NOFOLLOW spawn log; strongest available detach mechanism) but
// is self-contained so it doesn't couple to the updater's apply route.

import { spawn } from 'node:child_process'
import {
  openSync,
  closeSync,
  mkdirSync,
  statSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path, { resolve } from 'node:path'
import { HttpError } from '@/lib/auth/requireRole'
import {
  detectDetachMechanism,
  buildDetachCommand,
} from '@/lib/updates/detachMechanism'

// env the orchestrators need — everything else from process.env is dropped so
// app-auth secrets can't leak into the spawned bash + its children.
const ENGINE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_ENV',
  'NPM_CONFIG_USERCONFIG',
  'XDG_RUNTIME_DIR',
  // DB + storage substrate.
  'DATABASE_URL',
  'DATABASE_MIGRATOR_URL',
  'UPLOADS_ROOT',
  'CAVECMS_BACKUP_DIR',
  // Backup encryption recipient + retention + restore identity — without these
  // the dashboard path would silently produce PLAINTEXT backups even when an
  // age recipient is configured (the bash reads CAVECMS_BACKUP_AGE_RECIPIENT).
  'CAVECMS_BACKUP_AGE_RECIPIENT',
  'CAVECMS_BACKUP_KEEP',
  'CAVECMS_RESTORE_IDENTITY',
  // Per-install paths.
  'CAVECMS_STATE_DIR',
  'CAVECMS_LOG_DIR',
  'CAVECMS_REPO_DIR',
  'CAVECMS_ENV_FILE',
  // Forwarded so the bash scripts derive the SAME shared-lock path the updater
  // uses even when this legacy override is set (otherwise the lock would
  // diverge to the state-dir default and lose mutual exclusion).
  'CAVECMS_UPDATE_STATUS_PATH',
  'CAVECMS_HEALTHZ_URL',
  'CAVECMS_INTERNAL_URL',
  // Restart + process-manager handles (restore restarts the app).
  'CAVECMS_RESTART_MODE',
  'CAVECMS_SYSTEMD_UNIT',
  'PM2_HOME',
  'CAVECMS_PM2_APP_NAME',
  // Internal-endpoint + healthz auth.
  'INTERNAL_REVALIDATE_SECRET',
  'HEALTHZ_TOKEN',
  // Release bookkeeping (manifest version/commit).
  'CAVECMS_COMMIT',
  'CAVECMS_RELEASE_VERSION',
  'PORT',
  // Cloud backup destinations — paths/ids only. The actual secrets (refresh
  // token, passphrase) live INSIDE the mode-600 creds file, never in env/argv.
  'CAVECMS_BACKUP_DESTINATION',
  'CAVECMS_BACKUP_CLOUD_CREDS_FILE',
  'CAVECMS_BACKUP_CLOUD_CREDS_OUT',
  'CAVECMS_CLOUD_STEP',
  'CAVECMS_CLOUD_TOTAL',
  'CAVECMS_BACKUP_REMOTE_RETENTION',
  'CAVECMS_BACKUP_KEEP_LOCAL',
  'CAVECMS_CLOUD_CHUNK_BYTES',
  // Cloud restore (Phase 3).
  'CAVECMS_RESTORE_SOURCE',
  'CAVECMS_RESTORE_PROVIDER',
  'CAVECMS_RESTORE_REMOTE_ID',
]

const SHELL_DOUBLEQUOTE_DANGEROUS = /[$`\\'\x00-\x1f]/

function assertSafePathForShell(p: string, label: string): void {
  if (SHELL_DOUBLEQUOTE_DANGEROUS.test(p)) {
    throw new HttpError(500, `unsafe_${label}_path`)
  }
}

export function resolveWritableLogDir(): string {
  const candidates = [
    process.env.CAVECMS_LOG_DIR,
    process.env.CAVECMS_STATE_DIR ? resolve(process.env.CAVECMS_STATE_DIR, 'logs') : undefined,
    process.env.NODE_ENV === 'production' ? '/var/log/cavecms' : undefined,
    resolve(tmpdir(), 'cavecms'),
  ].filter((d): d is string => typeof d === 'string' && d.length > 0)
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      accessSync(dir, fsConstants.W_OK)
      return dir
    } catch {
      /* next candidate */
    }
  }
  return tmpdir()
}

function openSpawnLog(logPath: string): number {
  const flags =
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0)
  try {
    return openSync(logPath, flags, 0o600)
  } catch {
    return openSync('/dev/null', 'a')
  }
}

function buildEngineEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ENGINE_ENV_ALLOWLIST) {
    const v = process.env[k]
    if (typeof v === 'string') out[k] = v
  }
  // Hardened PATH so node/pnpm/pm2/age resolve under a minimal systemd env.
  const home = out.HOME ?? '/root'
  const inherited = (out.PATH ?? '').split(':').filter(Boolean)
  out.PATH = [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    `${home}/.local/share/pnpm`,
    `${home}/.npm-global/bin`,
    ...inherited,
  ]
    .filter(Boolean)
    .join(':')
  if (!out.CAVECMS_HEALTHZ_URL) {
    const port = process.env.PORT ?? '3040'
    out.CAVECMS_HEALTHZ_URL = `http://127.0.0.1:${port}/healthz`
  }
  out.CAVECMS_LOG_DIR = resolveWritableLogDir()
  Object.assign(out, extra)
  return out
}

export interface SpawnEngineOpts {
  /** 'cavecms-backup.sh' | 'cavecms-restore.sh' */
  script: string
  /** Extra env to forward (e.g. CAVECMS_RESTORE_ARCHIVE, status-path override). */
  env: Record<string, string>
}

/**
 * Spawn a backup/restore orchestrator detached (survives the app restart that
 * restore performs). Returns the child pid (or null). Throws HttpError on a
 * missing/unsafe script path.
 */
export function spawnBackupEngine({ script, env }: SpawnEngineOpts): number | null {
  const scriptPath = path.join(process.cwd(), 'scripts', script)
  const st = statSync(scriptPath)
  if (!st.isFile()) throw new HttpError(500, 'engine_not_a_file')
  assertSafePathForShell(scriptPath, 'script')

  const childEnv = buildEngineEnv(env)
  const mechanism = detectDetachMechanism()
  childEnv.CAVECMS_DETACH_MECHANISM = mechanism

  const logDir = resolveWritableLogDir()
  const logPath = resolve(logDir, `cavecms-${script.replace(/\.sh$/, '')}-spawn.log`)
  assertSafePathForShell(logPath, 'log')
  const logFd = openSpawnLog(logPath)

  const detachCommand = buildDetachCommand({
    mechanism,
    scriptPath,
    args: [],
    logPath,
  })
  const child = spawn('/bin/bash', ['-c', detachCommand], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: childEnv as NodeJS.ProcessEnv,
    cwd: childEnv.CAVECMS_REPO_DIR ?? process.cwd(),
  })
  child.unref()
  try {
    // close our copy of the fd — the child has its own dup
    closeSync(logFd)
  } catch {
    /* already closed during fork on some platforms */
  }
  return child.pid ?? null
}
