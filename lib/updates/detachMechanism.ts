// lib/updates/detachMechanism.ts — choose the strongest detach
// mechanism available for spawning the update orchestrator + the
// post-completion watchdog. Both processes need to survive a pm2
// reload of the parent Next.js process; the right mechanism depends
// on what the host actually has.
//
// Ordering (strongest → weakest):
//
//   systemd-run-user
//     Available when (a) the systemd-run binary exists AND (b) the
//     user systemd manager is running (XDG_RUNTIME_DIR/bus exists).
//     `systemd-run --user --scope --no-block` creates a fresh systemd
//     scope outside pm2's cgroup — pm2 reload's process-tree walk
//     cannot reach the child. This is the CeyMail-equivalent path
//     (CeyMail uses `systemd-run --no-block` directly; we use the
//     user variant so we don't need root). It's also what most modern
//     VPS hosts (Ubuntu 20.04+, DO/Hetzner/Vultr 2023+ images) give us
//     by default.
//
//   setsid-nohup
//     `setsid` creates a fresh process session — the child is no
//     longer in the parent's process group, so SIGINT/SIGTERM
//     delivered to the parent's pgroup doesn't propagate. `nohup`
//     additionally ignores SIGHUP. The combination handles every
//     pm2-reload-kills-child scenario we've seen except an explicit
//     `pgrep -P <bash_pid>` + `kill -9` (which pm2 doesn't do). No
//     cgroup escape, but on a box without user systemd this is the
//     strongest reliable option.
//
//   nohup-only
//     POSIX baseline. Ignores SIGHUP, redirects stdio. No new
//     session, no cgroup escape. Last resort.
//
// Detection result is module-cached — the host's detach capabilities
// don't change between requests, and `execSync` is too expensive to
// run per apply call. Cache survives until the Node process restarts.

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export type DetachMechanism =
  | 'systemd-run-user'
  | 'setsid-nohup'
  | 'nohup-only'

let cached: DetachMechanism | null = null

function hasBinary(name: string): boolean {
  try {
    execSync(`command -v ${name}`, {
      stdio: 'ignore',
      timeout: 1500,
      // Inherit a minimal PATH so we don't false-positive on a
      // hostile env var that aliases `command` itself. Cast to the
      // project's augmented ProcessEnv shape — we deliberately don't
      // forward NODE_ENV / other vars; the binary-existence probe
      // doesn't need them.
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      } as unknown as NodeJS.ProcessEnv,
    })
    return true
  } catch {
    return false
  }
}

function userSystemdAvailable(): boolean {
  // Both conditions must hold:
  //   1. systemd-run binary present
  //   2. user bus socket exists at $XDG_RUNTIME_DIR/bus (only created
  //      when systemd --user is actually running for this UID)
  if (!hasBinary('systemd-run')) return false
  const xdg = process.env.XDG_RUNTIME_DIR
  if (!xdg) return false
  return existsSync(`${xdg}/bus`)
}

export function detectDetachMechanism(): DetachMechanism {
  if (cached !== null) return cached
  if (userSystemdAvailable()) {
    cached = 'systemd-run-user'
  } else if (hasBinary('setsid')) {
    cached = 'setsid-nohup'
  } else {
    cached = 'nohup-only'
  }
  return cached
}

/** Test-only — reset the cached detection so tests can swap host
 *  capabilities between assertions. Not exported from the package
 *  index; callers must import directly. */
export function __resetDetachCacheForTests(): void {
  cached = null
}

/**
 * Build the `bash -c` argument that spawns the orchestrator (or
 * watchdog) under the chosen detach mechanism. The returned string
 * is passed verbatim as the second arg of `spawn('/bin/bash', ['-c',
 * <this>])`. All shell-injection-relevant inputs (scriptPath, args,
 * logPath) MUST be JSON.stringify-quoted by the caller before being
 * threaded in — the function trusts that and embeds them as-is.
 */
export function buildDetachCommand(opts: {
  mechanism: DetachMechanism
  scriptPath: string
  args: readonly string[]
  logPath: string
}): string {
  const { mechanism, scriptPath, args, logPath } = opts
  const quotedArgs = args.map((a) => JSON.stringify(a)).join(' ')
  const quotedScript = JSON.stringify(scriptPath)
  const quotedLog = JSON.stringify(logPath)

  switch (mechanism) {
    case 'systemd-run-user':
      // --user --scope: ephemeral systemd unit in the calling user's
      // manager, removed when the process exits. --no-block: don't
      // wait for the scope to finish before returning (we want spawn()
      // to return ~immediately). --collect: drop the scope when the
      // process exits even if it failed.
      // The inner /bin/bash command redirects stdio cleanly so the
      // scope doesn't inherit the parent's controlling terminal.
      return `systemd-run --user --scope --no-block --collect --quiet --unit="cavecms-update-$$" -- /bin/bash -c 'exec </dev/null >>${quotedLog} 2>&1; /bin/bash ${quotedScript} ${quotedArgs}'`

    case 'setsid-nohup':
      // setsid creates a fresh session AND process group; nohup
      // ignores SIGHUP from the now-disowned parent. & disown
      // detaches from the subshell's job table so the subshell can
      // `exit 0` immediately without waiting on the child.
      return `( exec </dev/null >>${quotedLog} 2>&1; setsid nohup /bin/bash ${quotedScript} ${quotedArgs} >>${quotedLog} 2>&1 < /dev/null & disown ) ; exit 0`

    case 'nohup-only':
    default:
      return `( exec </dev/null >>${quotedLog} 2>&1; nohup /bin/bash ${quotedScript} ${quotedArgs} >>${quotedLog} 2>&1 & disown ) ; exit 0`
  }
}
