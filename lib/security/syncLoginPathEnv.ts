import 'server-only'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Keeps the LOGIN_PATH= line in the sealed env.production in sync with the
// DB's security_login_path setting.
//
// WHY: on cPanel/LiteSpeed (Passenger) the app listens on a private Unix
// socket, so the Edge middleware can never reach its loopback config API and
// permanently routes with the env LOGIN_PATH it captured at boot. The DB is
// the live source of truth (wizard + Settings → Security write there, and the
// login page validates against it) — so the moment the two diverge, BOTH the
// old and the new login URL 404 and the operator is locked out:
//   - new path → middleware doesn't recognise it → CMS rewrite → no page → 404
//   - old path → login page checks the DB → mismatch → 404
// Syncing the env line on every DB change (and touching tmp/restart.txt so
// the host restarts on the next request) makes divergence impossible.
//
// On surfaces where the loopback works (vps/pm2/laptop/dev) the sync is a
// harmless consistency write: the env value is only the bootstrap fallback
// there, but keeping it current means a later restart can never resurrect a
// stale path.
//
// Best-effort by design: the DB write has already committed (or is about to);
// throwing here would fail the request AFTER the source of truth changed,
// which is strictly worse. Failures log loudly instead. The Settings flow is
// additionally protected by its confirm-within-10-minutes auto-revert (and
// the revert path calls this sync too, restoring full consistency).

const LOGIN_PATH_LINE_RE = /^LOGIN_PATH=/

function resolveEnvFile(): string | null {
  // Explicit pin first (written by the CLI on laptop + cpanel surfaces, and
  // injected by the systemd unit / pm2 ecosystem on hosted surfaces). Then
  // the repo-dir + cwd fallbacks for installs created before the pin existed.
  const candidates = [
    process.env.CAVECMS_ENV_FILE,
    process.env.CAVECMS_REPO_DIR && join(process.env.CAVECMS_REPO_DIR, 'env.production'),
    join(process.cwd(), 'env.production'),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/**
 * Rewrite the LOGIN_PATH= line in env.production to `newPath` (bare segment,
 * no leading slash) and, on the cpanel surface, touch tmp/restart.txt so the
 * host restarts the app on the next request and the middleware picks the new
 * value up. No-ops in dev (no env.production) and when already in sync.
 */
export function syncLoginPathEnv(newPath: string): void {
  try {
    // Defence in depth — the callers already Zod-validate this shape, but a
    // file-content write warrants its own gate (no newlines, no shell noise).
    if (!/^[a-z0-9-]{6,32}$/.test(newPath)) return

    const envFile = resolveEnvFile()
    if (!envFile) return // dev / contributor run — nothing to sync

    const original = readFileSync(envFile, 'utf8')
    const lines = original.split('\n')
    let replaced = false
    let changed = false
    const next = lines.map((line) => {
      if (!LOGIN_PATH_LINE_RE.test(line)) return line
      replaced = true
      if (line === `LOGIN_PATH=${newPath}`) return line
      changed = true
      return `LOGIN_PATH=${newPath}`
    })
    if (!replaced) {
      // Sealed file without the line (shouldn't happen — the CLI always
      // writes it) — append rather than silently dropping the sync.
      next.push(`LOGIN_PATH=${newPath}`, '')
      changed = true
    }
    if (changed) {
      // Atomic swap, preserving the sealed file's mode (600). A crash
      // mid-write must never leave a truncated env.production behind.
      const mode = statSync(envFile).mode & 0o777
      const tmp = `${envFile}.tmp-loginpath`
      writeFileSync(tmp, next.join('\n'), { mode })
      renameSync(tmp, envFile)
    }

    // cPanel restarts lazily on tmp/restart.txt (what its Restart button
    // touches). Restart even when the file was already in sync — the RUNNING
    // process may still hold the stale value it captured at boot.
    if (process.env.CAVECMS_RESTART_MODE === 'cpanel') {
      const repoDir = process.env.CAVECMS_REPO_DIR ?? dirname(envFile)
      mkdirSync(join(repoDir, 'tmp'), { recursive: true })
      writeFileSync(join(repoDir, 'tmp', 'restart.txt'), String(Date.now()))
    }
  } catch (err) {
    console.error(
      '[login-path-sync] failed to sync LOGIN_PATH into env.production:',
      err instanceof Error ? err.message : err,
    )
  }
}
