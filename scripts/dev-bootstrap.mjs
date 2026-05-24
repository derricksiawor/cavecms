#!/usr/bin/env node
// Auto-bootstrap dev dependencies — project standards rule #0.045 baseline:
// `pnpm dev` / `pnpm build` / `pnpm start` MUST bring up every
// dependency the app needs in ONE command. The user should never
// have to manually create uploads dirs before launching.
//
// Currently this script handles:
//   - mkdir -p of UPLOADS_ROOT/{originals,variants,brochures-private,.tmp}
//
// Future bootstrap concerns (docker compose up -d --wait for MariaDB,
// migrate-on-first-run, etc.) live here too. Skip the entire script
// in production — production relies on scripts/setup.sh having
// provisioned everything already, and we don't want this script
// silently masking a misconfigured /etc/bwc/env.production at boot.
//
// Invoked from package.json predev / prebuild / prestart lifecycle
// hooks via `node --env-file-if-exists=.env.local scripts/dev-bootstrap.mjs`
// so process.env reflects the dev .env.local UPLOADS_ROOT override.

import { mkdir, symlink, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'

if (process.env.NODE_ENV === 'production') {
  // Refuse to fire in production — setup.sh owns the dir layout and
  // ownership/permissions on the live box. A blind mkdir here could
  // create dirs as the wrong user, break bwc:bwc 750 ownership, or
  // mask a real misconfiguration. Exit cleanly so pnpm start still
  // launches.
  process.exit(0)
}

const root = process.env.UPLOADS_ROOT || '/opt/bwc/uploads'
const resolvedRoot = resolve(root)

// Defence in depth: in dev, refuse to mkdir under /opt/bwc/* by accident
// (e.g. a contributor copied the prod .env.production by mistake). The
// canonical dev path is something like ./.test-uploads or /tmp/...
// — never under /opt/bwc. If a dev legitimately wants to point at
// /opt/bwc, they can set BWC_DEV_BOOTSTRAP_ALLOW_PROD_PATH=1.
if (
  resolvedRoot.startsWith('/opt/bwc') &&
  process.env.BWC_DEV_BOOTSTRAP_ALLOW_PROD_PATH !== '1'
) {
  console.error(
    `[dev-bootstrap] refusing to mkdir under ${resolvedRoot} in non-production.`,
  )
  console.error(
    '[dev-bootstrap]   Set UPLOADS_ROOT to a dev path (e.g. ./.test-uploads) in .env.local,',
  )
  console.error(
    '[dev-bootstrap]   or override with BWC_DEV_BOOTSTRAP_ALLOW_PROD_PATH=1 if you really mean it.',
  )
  process.exit(1)
}

const subdirs = ['originals', 'variants', 'brochures-private', '.tmp']
const created = []

for (const sub of subdirs) {
  const dir = resolve(resolvedRoot, sub)
  try {
    // recursive: true makes mkdir idempotent (no error if exists).
    // mode is the same 0o750 setup.sh uses in production — keeps dev
    // perms in line with prod so a `chmod` mismatch never surfaces
    // in a later staging session.
    await mkdir(dir, { recursive: true, mode: 0o750 })
    created.push(dir)
  } catch (err) {
    console.error(
      `[dev-bootstrap] failed to mkdir ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}

// In dev, the public-facing `/uploads/*` URLs (which production serves
// via nginx) need a static path under Next's `public/` directory.
// Symlink `public/uploads` → resolvedRoot so a `pnpm dev` install
// can render images without an nginx in front. Skipped in production
// (setup.sh provisions /opt/bwc/uploads, nginx fronts the URL).
if (process.env['NODE_ENV'] !== 'production') {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, '..')
  const linkPath = resolve(repoRoot, 'public', 'uploads')
  try {
    const existing = await stat(linkPath).catch(() => null)
    if (!existing) {
      await symlink(resolvedRoot, linkPath, 'dir')
    } else if (existing.isSymbolicLink?.() === false && !existing.isDirectory()) {
      // Something non-link, non-dir occupies the path — refuse rather
      // than blow it away.
      console.error(
        `[dev-bootstrap] ${linkPath} exists and is not a directory or symlink; skipping.`,
      )
    }
  } catch (err) {
    // Symlink failure is non-fatal — dev images will 404 until fixed
    // manually, but the rest of dev still works.
    console.warn(
      `[dev-bootstrap] could not create ${linkPath} symlink: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// Quiet success in CI / hot-reload loops; a one-line summary only.
// Use stderr so the line doesn't clutter pnpm's stdout pipe to next.
process.stderr.write(
  `[dev-bootstrap] uploads dirs ready at ${resolvedRoot}\n`,
)

// ── MariaDB bootstrap (project standards #0.045 + audit finding X2) ──
// Goal: `pnpm dev` brings up every dependency in ONE command, including
// the MariaDB container. Logic:
//   1. TCP-probe 127.0.0.1:3306 — if reachable in <600ms, MariaDB is
//      already up (host install or container from prior session).
//      Nothing to do.
//   2. If not reachable: shell out to `docker compose -f
//      docker-compose.dev.yml up -d --wait` so the next `next dev`
//      starts against a live DB instead of crash-looping on connect.
//   3. Skip the whole branch when:
//        - BWC_SKIP_DOCKER=1            (operator opts out: "I have a
//                                       host MariaDB but no Docker")
//        - the docker CLI isn't installed (silent skip + warn)
//        - `docker compose` returns non-zero (warn + continue; the
//          downstream next-dev will surface a connect error if MariaDB
//          really is down — better that than block the whole boot).
async function probePort(host, port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      socket.destroy()
      resolveProbe(ok)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    setTimeout(() => finish(false), timeoutMs)
  })
}

// ── Port 3040 conflict probe (audit finding X3) ──
// Background: during the audit, three zombie `pnpm dev` processes
// were holding partial state — every CMS-driven public route 500'd
// until killed. The zombies were hard to spot because pnpm dev
// "succeeded" in starting (no port conflict shown — Next picks a
// different port silently? actually no, the zombies WERE bound to
// 3040 and the new dev didn't actually start). Defensive detection
// here: probe port 3040 BEFORE the rest of the bootstrap. If it's
// already bound, surface loudly so the operator kills the orphan
// (or sets BWC_SKIP_PORT_CHECK=1 to bypass for legitimate cases like
// `pnpm start` against an existing pnpm dev).
const PORT_RAW = process.env['PORT'] ?? '3040'
const PORT = Number.isFinite(Number(PORT_RAW)) ? Number(PORT_RAW) : 3040
if (process.env['BWC_SKIP_PORT_CHECK'] !== '1') {
  // 600ms matches the MariaDB probe budget below — long enough to
  // survive a momentarily-loaded loopback (CPU pegged on a parallel
  // build, swap pressure) without false-negative; short enough that
  // the happy path adds <1s to boot. Post-agent-review A7 (Chunk K).
  const portInUse = await probePort('127.0.0.1', PORT, 600)
  if (portInUse) {
    // Fail-fast: continuing means `next dev` either picks a
    // different port (silent confusion) or fails with EADDRINUSE
    // 1-2s later (operator gets two errors instead of one). Exit
    // cleanly with a single actionable message. Post-agent-review
    // R9 (Chunk K).
    console.error(
      `[dev-bootstrap] Port ${PORT} is already bound. Likely a stale \`pnpm dev\` from a prior session.`,
    )
    console.error(
      `[dev-bootstrap]   Run \`pkill -f "next dev"\` (or kill the PID from \`lsof -i :${PORT}\`) then re-run.`,
    )
    console.error(
      `[dev-bootstrap]   Set BWC_SKIP_PORT_CHECK=1 to bypass (e.g. running pnpm start against an existing dev).`,
    )
    process.exit(1)
  }
}

if (process.env['BWC_SKIP_DOCKER'] !== '1') {
  const reachable = await probePort('127.0.0.1', 3306, 600)
  if (!reachable) {
    // Check `docker` is installed before invoking compose. `command -v
    // docker` is more portable than `which docker` across macOS / Linux.
    const dockerCheck = spawnSync('docker', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    if (dockerCheck.status !== 0) {
      console.warn(
        '[dev-bootstrap] MariaDB on 127.0.0.1:3306 unreachable AND docker not on PATH.',
      )
      console.warn(
        '[dev-bootstrap]   Set up a host MariaDB OR install Docker (see docker-compose.dev.yml),',
      )
      console.warn(
        '[dev-bootstrap]   OR set BWC_SKIP_DOCKER=1 to silence this warning.',
      )
    } else {
      const here = dirname(fileURLToPath(import.meta.url))
      const repoRoot = resolve(here, '..')
      const composeFile = resolve(repoRoot, 'docker-compose.dev.yml')
      process.stderr.write(
        '[dev-bootstrap] MariaDB unreachable on 127.0.0.1:3306 — bringing up the dev container…\n',
      )
      process.stderr.write(
        '[dev-bootstrap]   First boot pulls the mariadb:10.11 image and may take 20-30s. Subsequent boots are sub-second.\n',
      )
      const upRes = spawnSync(
        'docker',
        ['compose', '-f', composeFile, 'up', '-d', '--wait'],
        { stdio: 'inherit' },
      )
      if (upRes.status !== 0) {
        console.warn(
          '[dev-bootstrap] `docker compose up -d --wait` exited non-zero — next dev may fail to connect.',
        )
      } else {
        process.stderr.write(
          '[dev-bootstrap] MariaDB container ready.\n',
        )
      }
    }
  }
}
