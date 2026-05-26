import { spawn } from 'node:child_process'
import {
  openSync,
  closeSync,
  statSync,
  mkdirSync,
  existsSync,
  constants as fsConstants,
} from 'node:fs'
import path, { resolve } from 'node:path'
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
    // Static-manifest tarball coords. CLI-installed instances have no
    // .git directory, so the orchestrator MUST use tarball mode (curl +
    // sha256 verify + atomic extract) instead of git-fetch. These come
    // from /api/admin/updates/check's response, which the client
    // forwards verbatim. Both fields are required for the apply chain
    // to function on non-git installs.
    downloadUrl: z
      .string()
      .url('downloadUrl must be a valid URL')
      // Defence-in-depth: orchestrator also validates origin against the
      // manifest URL. We require https here so a stripped-down manifest
      // can't downgrade to plaintext fetch.
      .startsWith('https://', 'downloadUrl must be https')
      .max(2048),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'sha256 must be 64 hex chars'),
    // Force re-running install on the SAME SHA — exposed in the UI as
    // "Re-run install" (visible when current === available). Used to
    // recover from a corrupted .next/ cache or a previously-interrupted
    // migration. The orchestrator script honours --force / CAVECMS_UPDATE_FORCE=1
    // by deleting .next/ before rebuild.
    force: z.boolean().optional(),
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
  'CAVECMS_UPDATE_FORCE',
  'CAVECMS_UPDATE_TARBALL_URL',
  'CAVECMS_UPDATE_TARBALL_SHA256',
  'CAVECMS_REPO_DIR',
  'CAVECMS_HEALTHZ_URL',
  'CAVECMS_RELEASE_PROBE_URL',
  'CAVECMS_LOG_DIR',
  'CAVECMS_INTERNAL_URL',
  // DB connectivity for db:migrate inside step 3.
  'DATABASE_URL',
  'DATABASE_MIGRATOR_URL',
  // Healthz auth — the script polls /healthz with verbose mode to
  // verify the new build's commit matches the target.
  'HEALTHZ_TOKEN',
  // Internal-endpoint auth — the script POSTs to /api/internal/updates/*
  // for the maintenance toggle and terminal-state audit row.
  'INTERNAL_REVALIDATE_SECRET',
  // Deploy-time invariants. The script exports new values to pm2
  // reload; the new process picks them up via `--update-env`.
  'CAVECMS_COMMIT',
  'CAVECMS_RELEASE_TS',
]

function buildScriptEnv(
  target: string,
  fromSha: string,
  opts: { force: boolean; downloadUrl: string; sha256: string },
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SCRIPT_ENV_ALLOWLIST) {
    const v = process.env[k]
    if (typeof v === 'string') out[k] = v
  }
  out.CAVECMS_UPDATE_TARGET = target
  out.CAVECMS_UPDATE_FROM = fromSha
  // Tarball coords from the static manifest — the orchestrator's step 2
  // switches to tarball mode (curl + sha256 verify + atomic extract)
  // when these are present, so CLI-installed (no-git) instances can
  // update without a .git directory.
  out.CAVECMS_UPDATE_TARBALL_URL = opts.downloadUrl
  out.CAVECMS_UPDATE_TARBALL_SHA256 = opts.sha256
  if (opts.force) {
    out.CAVECMS_UPDATE_FORCE = '1'
  }
  // Hard-PATH augmentation — on a hardened systemd unit, pm2 lives
  // under `~/.local/share/pnpm/`. Without this, the script fails at
  // step 3 with `pnpm: command not found`.
  const home = out.HOME ?? '/root'
  // Split the inherited PATH too so we can drop empty segments —
  // `::` in PATH means CWD, which postinstall scripts could exploit.
  const inheritedPathSegments = (out.PATH ?? '').split(':').filter(Boolean)
  out.PATH = [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    `${home}/.local/share/pnpm`,
    `${home}/.npm-global/bin`,
    ...inheritedPathSegments,
  ]
    .filter(Boolean)
    .join(':')
  if (process.env.CAVECMS_UPDATE_DRY_RUN === '1') {
    out.CAVECMS_UPDATE_DRY_RUN = '1'
  }
  return out
}

// Refuse any path that contains bytes bash will interpret inside the
// double-quotes of the detach command. The wrapper is:
//   bash -c '... >>"$logPath" ... bash "$scriptPath" "$target"'
// Inside bash double-quotes, only `$`, `` ` ``, `\`, `"`, and newline
// are special. JSON.stringify already escapes `"` and `\` (turns
// internal `"` into `\"`). The remaining injection vectors are:
//   - `$(...)` / `${...}` / `$VAR`  — `$` + following char
//   - `` `...` `` — backtick command substitution
//   - newline — argument-list desync
// We refuse those three plus controls — letting through spaces and
// non-ASCII letters so legitimate install paths like
// `/srv/café/cavecms` or `/Users/Derrick OConnor/cavecms` keep working.
//
// Allowlist regexes were tried first; they false-positive on perfectly
// valid Unicode dirs. A denylist scoped to the actual bash-double-quote
// active set is more precise.
// eslint-disable-next-line no-control-regex
const SHELL_DOUBLEQUOTE_DANGEROUS = /[$`\\\x00-\x1f]/

function assertSafePathForShell(p: string, label: string): void {
  if (SHELL_DOUBLEQUOTE_DANGEROUS.test(p)) {
    throw new HttpError(500, `unsafe_${label}_path`)
  }
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
  assertSafePathForShell(scriptPath, 'script')
  return scriptPath
}

// Resolve the spawn-log path (without opening). The double-fork
// orchestrator uses the path directly so nohup can re-open the file
// independently of any fd Node holds — closing Node's fd doesn't
// affect the orphaned child's file handle.
function resolveSpawnLogPath(): string {
  const dir =
    process.env.CAVECMS_LOG_DIR ??
    (process.env.NODE_ENV === 'production' ? '/var/log/cavecms' : '/tmp')
  mkdirSync(dir, { recursive: true })
  const logPath = resolve(dir, 'cavecms-update-spawn.log')
  // The path will be interpolated into a `bash -c` command line.
  // Refuse anything that could carry shell metacharacters into that
  // context (operator-controlled CAVECMS_LOG_DIR with embedded $(...)
  // would otherwise execute as the runtime user).
  assertSafePathForShell(logPath, 'log')
  return logPath
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
  const force = body.force === true
  const downloadUrl = body.downloadUrl
  const sha256 = body.sha256.toLowerCase()
  const current = getCurrentVersion()

  // Refuse to "update" from dev — regardless of NODE_ENV. A
  // production-deployed install with CAVECMS_COMMIT misconfigured to
  // `unknown` would otherwise pass through and run `git reset --hard
  // dev` which fails opaquely at step 2. Better to fail loud here.
  if (current.sha === 'dev') {
    throw new HttpError(409, 'cannot_apply_from_dev')
  }

  // No-op guard: refuse a target that's already the running SHA unless
  // the operator explicitly asked for `force: true`. The UI surfaces
  // "Re-run install" as a separate affordance precisely so an
  // accidental double-click or stale browser tab can't trigger a
  // surprise rebuild of an already-current install. Force is the
  // escape hatch (corrupted `.next/`, stuck migration).
  //
  // Length-aware prefix match: only treat as same-SHA when the LONGER
  // string starts with the SHORTER. A bidirectional `startsWith` would
  // false-positive on `abc` vs `abcdef` (when `current.sha === 'abc'`
  // from a malformed CAVECMS_COMMIT or a 'dev' partial). We also require
  // the shorter side to be ≥ 7 chars so accidentally-short SHAs don't
  // match unrelated tags.
  // Refuse a malformed current.sha up front. CAVECMS_COMMIT shorter
  // than 7 chars (anything except 'dev', already filtered above) is
  // either a typo or an old environment that predates the new
  // release-pipeline conventions. Better to fail loud than silently
  // proceed with an unreliable prefix match.
  if (current.sha.length < 7) {
    throw new HttpError(409, 'current_sha_malformed')
  }
  const isSameSha = (() => {
    const a = target
    const b = current.sha
    // Both lengths ≥ 7 (Zod min on target, just-validated b). Compare
    // by the LONGER side starting with the SHORTER. A 7-char short
    // SHA is unambiguous prefix of its 40-char full form.
    const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a]
    return longer.startsWith(shorter)
  })()
  if (isSameSha && !force) {
    throw new HttpError(409, 'already_on_target_version')
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
    const scriptEnv = buildScriptEnv(target, current.sha, {
      force,
      downloadUrl,
      sha256,
    })
    const logFd = openSpawnLog()

    // Double-fork orphan pattern. `detached: true` + `setsid` alone
    // is NOT enough on macOS to escape pm2's reload-time
    // process-tree walk — when the pm2 daemon kill_timeouts the OLD
    // Node process (8s default), it can deliver SIGKILL to children
    // even after setsid. The orchestrator script then dies mid-step-6
    // with no trap fire (SIGKILL untrappable). On Linux + systemd
    // this isn't an issue because systemd-run --no-block creates a
    // fresh scope.
    //
    // To get equivalent isolation without systemd: wrap the script
    // invocation in a subshell that re-opens its own log fd, then
    // backgrounds the orchestrator with nohup + disown so the child
    // has no inherited fds from Node, no controlling terminal, and
    // no parent process group. pm2's kill-tree walk finds nothing.
    //
    // Pattern:
    //   ( exec </dev/null >>$LOG 2>&1
    //     nohup /bin/bash $SCRIPT $TARGET >>$LOG 2>&1 &
    //     disown
    //   ) ; exit 0
    //
    // The outer subshell exits with status 0 immediately; pm2 sees
    // the spawn complete cleanly. The orchestrator runs as an
    // orphaned grandchild, reparented to launchd (PID 1) on macOS.
    const logPath = resolveSpawnLogPath()
    // Shell-quoting: paths and target are operator/route-controlled
    // strings; targetSha has been Zod-validated to /^[0-9a-f]+$/i.
    // scriptPath is the route's own resolved path. Both safe to inline
    // single-quoted with no operator-controlled escape risk.
    const detachCommand = `( exec </dev/null >>${JSON.stringify(logPath)} 2>&1; nohup /bin/bash ${JSON.stringify(scriptPath)} ${JSON.stringify(target)} >>${JSON.stringify(logPath)} 2>&1 & disown ) ; exit 0`
    const child = spawn('/bin/bash', ['-c', detachCommand], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: scriptEnv as NodeJS.ProcessEnv,
      cwd: scriptEnv.CAVECMS_REPO_DIR ?? process.cwd(),
    })
    // unref() so the Node event loop can exit even if this child is
    // still running. Without it, the Next.js process can't be cleanly
    // restarted by pm2 because there's a pending child reference.
    child.unref()
    // Mark handed-off BEFORE the closeSync(lockFd) below. If closeSync
    // itself threw mid-call (rare but possible on Node 22+), the
    // finally would otherwise see (!handedOff && lockFd !== null) and
    // call releaseUpdateLock — unlinking the lock file underneath the
    // running orchestrator. The orchestrator's EXIT trap is already
    // idempotent against double-unlink (catches ENOENT), so marking
    // first + closing second is the strictly safer ordering.
    handedOff = true
    // Close our copy of the fd — the child has its own dup. Without
    // this, every "Update now" click leaks one fd until pm2 reload.
    try {
      closeSync(logFd)
    } catch {
      /* already closed during spawn fork on some platforms */
    }
    // Lock hand-off: from here on the orchestrator script's EXIT
    // trap owns the lock file.
    if (lockFd !== null) {
      try {
        closeSync(lockFd)
      } catch {
        /* spawned child holds the unlink right */
      }
      lockFd = null
    }

    const meta = auditMetaFromRequest(req)
    // Audit insert is intentionally wrapped in its own try/catch and
    // executed AFTER the spawn handoff: the update IS running at
    // this point — letting a DB hiccup (deadlock, connection drop,
    // FK violation) throw here would surface as a 500 to the
    // operator while the orchestrator continues in the background.
    // The terminal-state audit row written by the script via
    // /api/internal/updates/audit-terminal still anchors the audit
    // thread; a missing apply row is recoverable, a phantom 500 to
    // the operator is not. Log the error so post-mortem can spot
    // the gap.
    try {
      await db.insert(auditLog).values({
        userId: ctx.userId,
        // Distinguish forced rebuilds in the audit thread so the
        // history table can surface them differently ("Re-ran
        // install" vs. "Updated to X").
        action: force ? 'force_apply' : 'apply',
        resourceType: 'updates',
        resourceId: target.slice(0, 12),
        diff: {
          fromSha: current.sha,
          toSha: target,
          ...(force ? { force: true } : {}),
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'audit_log_insert_failed_after_handoff',
          err: err instanceof Error ? err.message : String(err),
          fromSha: current.sha,
          toSha: target,
        }),
      )
    }

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

