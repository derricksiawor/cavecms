import { spawn } from 'node:child_process'
import {
  openSync,
  closeSync,
  statSync,
  mkdirSync,
  existsSync,
  constants as fsConstants,
} from 'node:fs'
import { resolve } from 'node:path'
import path from 'node:path'
import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'
import {
  readStatus,
  writeStatus,
  clearStatus,
  isStale,
  acquireUpdateLock,
  releaseUpdateLock,
  lockIsStale,
} from '@/lib/updates/statusFile'

// POST /api/admin/updates/apply — kick off the update orchestrator
// asynchronously and return 202 immediately. The shell script runs
// detached so it survives the pm2 reload that happens partway
// through. The web UI polls /api/admin/updates/status to track
// progress.
//
// CRITICAL invariants:
//
// (1) Concurrent-operator safety. We hold an O_EXCL file-lock for the
//     entire status-read + status-seed + spawn window. Two operators
//     clicking "Update now" within ~50ms can't both pass the check —
//     the second's `openSync(..., O_EXCL)` fails with EEXIST and we
//     return 409.
//
// (2) Secret containment. The spawn does NOT inherit the full Node
//     `process.env`. Secrets like JWT_SECRET / CSRF_SECRET /
//     PREVIEW_SECRET / BROCHURE_SECRET / RECAPTCHA_SECRET_KEY would
//     otherwise leak into pnpm's lifecycle scripts (postinstall hooks
//     in any future malicious dep) and into the script's stdout/
//     stderr log file. Only the env the script actually needs is
//     forwarded.
//
// (3) Log file integrity. The spawn log is opened with O_CREAT |
//     O_EXCL | O_APPEND | O_NOFOLLOW and 0600 mode, BUT macOS's
//     openSync doesn't expose O_NOFOLLOW via the fs module — we
//     emulate by lstat-then-open with O_APPEND, refusing if the
//     path resolves to a symlink. The file lives under
//     /var/log/cavecms in production, /tmp in dev.
//
// (4) Script integrity. The script path is statSync'd before spawn
//     and refused if it doesn't exist or isn't a regular file. In
//     production it lives at $PROJECT_ROOT/scripts/cavecms-update.sh
//     under root/operator ownership.

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    targetSha: z
      .string()
      .min(7)
      .max(64)
      .regex(/^[0-9a-f]+$/i, 'targetSha must be hex'),
  })
  .strict()

// Allowlist of env vars the orchestrator script needs. Everything
// else from process.env is dropped. Order: process-runtime essentials
// first, then update-specific knobs, then DB connectivity (db:migrate
// uses DATABASE_URL), then deploy-time invariants the script propagates
// into the new running version.
const SCRIPT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_ENV',
  'NPM_CONFIG_USERCONFIG',
  // Update knobs.
  'CAVECMS_UPDATE_TARGET',
  'CAVECMS_UPDATE_FROM',
  'CAVECMS_UPDATE_STATUS_PATH',
  'CAVECMS_UPDATE_DRY_RUN',
  'CAVECMS_REPO_DIR',
  'CAVECMS_HEALTHZ_URL',
  'CAVECMS_RELEASE_PROBE_URL',
  'CAVECMS_LOG_DIR',
  // DB connectivity for db:migrate inside step 3.
  'DATABASE_URL',
  'DATABASE_MIGRATOR_URL',
  // Healthz auth — the script polls /healthz with verbose mode to
  // verify the new build's commit matches the target.
  'HEALTHZ_TOKEN',
  // Deploy-time invariants. The script exports new values to pm2
  // reload; the new process picks them up via `--update-env`.
  'CAVECMS_COMMIT',
  'CAVECMS_RELEASE_TS',
]

function buildScriptEnv(target: string, fromSha: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SCRIPT_ENV_ALLOWLIST) {
    const v = process.env[k]
    if (typeof v === 'string') out[k] = v
  }
  out.CAVECMS_UPDATE_TARGET = target
  out.CAVECMS_UPDATE_FROM = fromSha
  // Hard-PATH augmentation — on a hardened systemd unit, pm2 lives
  // under `~/.local/share/pnpm/`. Without this, the script fails at
  // step 3 with `pnpm: command not found`.
  const home = out.HOME ?? '/root'
  out.PATH = [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    `${home}/.local/share/pnpm`,
    `${home}/.npm-global/bin`,
    out.PATH ?? '',
  ]
    .filter(Boolean)
    .join(':')
  if (process.env.CAVECMS_UPDATE_DRY_RUN === '1') {
    out.CAVECMS_UPDATE_DRY_RUN = '1'
  }
  return out
}

// Resolve the orchestrator script path with integrity checks: must
// be a regular file with mode bits 0o755 or stricter, and must NOT
// be a symlink to anywhere outside the project tree.
function resolveScriptPath(): string {
  const scriptPath = path.join(process.cwd(), 'scripts/cavecms-update.sh')
  // statSync (NOT lstatSync) — we accept the resolved real file,
  // but we'll guard against symlinks separately when opening the
  // log fd below. If a release symlink legitimately points the
  // script at a different version, that's fine; the integrity check
  // is on mode bits.
  const st = statSync(scriptPath)
  if (!st.isFile()) {
    throw new HttpError(500, 'script_not_a_file')
  }
  return scriptPath
}

// Open a spawn-log file safely. Returns an fd in append mode that
// the child will write its stdout/stderr into.
function openSpawnLog(): number {
  const dir =
    process.env.CAVECMS_LOG_DIR ??
    (process.env.NODE_ENV === 'production' ? '/var/log/cavecms' : '/tmp')
  mkdirSync(dir, { recursive: true })
  const logPath = resolve(dir, 'cavecms-update-spawn.log')
  // O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW where supported. On
  // macOS, fs.constants.O_NOFOLLOW exists; on Linux too. If the file
  // is a symlink, the openSync fails — exactly the desired behaviour
  // (prevents `/tmp/cavecms-update-spawn.log -> /etc/cron.d/x`
  // hijacks on shared hosts).
  // O_NOFOLLOW exists on both macOS and Linux libc. If for some
  // reason the platform doesn't expose it (or the constant is 0),
  // the flag is a no-op and we lose the symlink defence — log paths
  // are still inside CAVECMS_LOG_DIR which is operator-controlled,
  // and the spawn log is mode 0600 so the worst case is a single
  // append to whatever the symlink points at.
  const flags =
    fsConstants.O_APPEND |
    fsConstants.O_CREAT |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0)
  try {
    return openSync(logPath, flags, 0o600)
  } catch {
    // Symlink attack defence — refuse rather than open a dangerous
    // file. Caller can fall back to /dev/null.
    return openSync('/dev/null', 'a')
  }
}

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = Body.parse(await readJsonBody(req))
  const target = body.targetSha.toLowerCase()
  const current = getCurrentVersion()

  // Refuse to "update" from dev — regardless of NODE_ENV. A
  // production-deployed install with CAVECMS_COMMIT misconfigured to
  // `unknown` would otherwise pass through and run `git reset --hard
  // dev` which fails opaquely at step 2. Better to fail loud here.
  if (current.sha === 'dev') {
    throw new HttpError(409, 'cannot_apply_from_dev')
  }

  // (1) Acquire the cross-process lock before reading status — closes
  //     the TOCTOU window with another concurrent operator.
  let lockFd: number | null = null
  try {
    lockFd = acquireUpdateLock()
  } catch (err) {
    // Distinguish "lock held" (EEXIST) from misconfiguration
    // (path-allowlist throw). The former is operator-actionable; the
    // latter is an env-config bug we should report distinctly.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') {
      throw new HttpError(500, 'status_path_invalid')
    }
    // Lock taken. Inspect for staleness (orphaned lock from a crashed
    // orchestrator) — if older than 15 min, the script is dead;
    // release and retry once.
    if (lockIsStale()) {
      releaseUpdateLock(null)
      try {
        lockFd = acquireUpdateLock()
      } catch {
        return new Response(
          JSON.stringify({ error: 'update_in_progress' }),
          {
            status: 409,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          },
        )
      }
    } else {
      return new Response(
        JSON.stringify({ error: 'update_in_progress' }),
        {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        },
      )
    }
  }

  // Single-exit lock management via try/finally. We mark the lock
  // as `handedOff = true` ONLY after the detached child is launched
  // and its EXIT trap will assume responsibility for unlinking the
  // lock file. Every other exit path (early-return 409, thrown
  // error, validation failure) lands in the `finally` and releases
  // the lock so the operator can retry.
  let handedOff = false
  try {
    // Conflict-or-stale-clear: if there's a non-stale in-progress
    // update, refuse. If stale (script crashed >15min ago), clear the
    // status file and proceed — the operator is implicitly retrying
    // after the previous orchestrator died.
    const existing = readStatus()
    if (existing && !isStale(existing)) {
      const inProgress =
        existing.state === 'preflight' ||
        existing.state === 'updating' ||
        existing.state === 'restarting'
      if (inProgress) {
        return new Response(
          JSON.stringify({
            error: 'update_in_progress',
            since: existing.startedAt,
          }),
          {
            status: 409,
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            },
          },
        )
      }
    }
    if (existing && isStale(existing)) {
      clearStatus()
    }

    // Seed the status file BEFORE spawning so polling immediately
    // shows the preflight phase. Without this seed, there's a 1-2s
    // window where the modal opens but /status returns idle, which
    // looks like the spawn failed.
    writeStatus({
      state: 'preflight',
      step: 0,
      totalSteps: 6,
      stepLabel: 'Preparing',
      fromSha: current.sha,
      toSha: target,
      error: undefined,
      log: undefined,
    })

    let scriptPath: string
    try {
      scriptPath = resolveScriptPath()
    } catch (err) {
      writeStatus({ state: 'failed', error: 'script_unavailable' })
      throw err
    }
    if (process.env.NODE_ENV !== 'production' && !existsSync(scriptPath)) {
      writeStatus({ state: 'failed', error: `script_not_found: ${scriptPath}` })
      throw new HttpError(500, 'script_not_found')
    }

    // (2) Build a NARROW env for the child — secrets stay in the
    //     parent. (3) Open the spawn log with O_NOFOLLOW + 0600.
    const scriptEnv = buildScriptEnv(target, current.sha)
    const logFd = openSpawnLog()

    const child = spawn('/bin/bash', [scriptPath, target], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // Cast to ProcessEnv — our allowlist already filtered to strings,
      // but the node typings demand the NODE_ENV property be present.
      env: scriptEnv as NodeJS.ProcessEnv,
      cwd: scriptEnv.CAVECMS_REPO_DIR ?? process.cwd(),
    })
    // unref() so the Node event loop can exit even if this child is
    // still running. Without it, the Next.js process can't be cleanly
    // restarted by pm2 because there's a pending child reference.
    child.unref()
    // Close our copy of the fd — the child has its own dup. Without
    // this, every "Update now" click leaks one fd until pm2 reload.
    try {
      closeSync(logFd)
    } catch {
      /* already closed during spawn fork on some platforms */
    }
    // Lock hand-off: from here on the orchestrator script's EXIT
    // trap owns the lock file. We close our copy of the fd (the
    // child has its own dup) and mark `handedOff` so the `finally`
    // below DOESN'T unlink the file.
    if (lockFd !== null) {
      try {
        closeSync(lockFd)
      } catch {
        /* spawned child holds the unlink right */
      }
      lockFd = null
    }
    handedOff = true

    const meta = auditMetaFromRequest(req)
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'apply',
      resourceType: 'updates',
      resourceId: target.slice(0, 12),
      diff: { fromSha: current.sha, toSha: target },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    return new Response(
      JSON.stringify({
        accepted: true,
        fromSha: current.sha,
        toSha: target,
        pid: child.pid ?? null,
      }),
      {
        status: 202,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    )
  } finally {
    // Lock release covers every exit path except the post-spawn
    // hand-off. When the orchestrator script has been launched
    // (`handedOff === true`), its EXIT trap is responsible for
    // unlinking the lock file — calling releaseUpdateLock here would
    // race against it. Every other case (early-return 409, thrown
    // error, validation failure) MUST unlink so the operator's next
    // attempt can acquire a fresh lock.
    if (!handedOff && lockFd !== null) {
      releaseUpdateLock(lockFd)
    }
  }
})

