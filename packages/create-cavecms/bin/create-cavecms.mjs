#!/usr/bin/env node
// packages/create-cavecms/bin/create-cavecms.mjs
//
// `npx create-cavecms my-site` — one-command installer for CaveCMS.
//
// What this CLI guarantees:
//   - Customer never edits .env.local, .env.production, or any config
//     file. The CLI writes ONE sealed env.production at install time,
//     mode 600, owned by the runtime user.
//   - Customer never SSHs to a server after install. Everything they
//     need to configure (admin, branding, SMTP, integrations) lives
//     in the in-app /install wizard.
//   - Three deployment surfaces, one entry point: VPS (Ubuntu/Debian
//     with systemd + nginx), laptop (macOS/Linux dev box), cPanel
//     (Node.js Selector + Passenger on shared hosting).
//
// Pipeline (in order):
//   1. Parse argv + detect surface
//   2. Pre-flight: Node ≥ 20, write permission, target dir state
//   3. Download cavecms.derricksiawor.com/latest.zip (or pinned version)
//   4. Verify SHA-256 against the manifest + Ed25519 signature
//   5. Unzip into the surface's canonical install path
//   6. Prompt for DB host/port/user/password/name, public URL, port
//   7. Generate every bootstrap secret (JWT/CSRF/preview/brochure/
//      internal-revalidate/secrets-encryption + a random LOGIN_PATH)
//   8. Write the sealed env.production
//   9. Run db migrations via scripts/install-migrate.mjs
//  10. Start the service via the surface's adapter
//  11. Print the wizard URL + the hidden LOGIN_PATH the operator
//      needs after walking the wizard
//
// All third-party-network access is via cavecms.derricksiawor.com.
// No bundled npm deps — everything uses Node ≥ 20 built-ins.

import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { randomBytes, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { homedir, platform, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

const DEFAULT_RELEASE_HOST = 'https://cavecms.derricksiawor.com'
const RELEASE_HOST = process.env.CAVECMS_RELEASE_HOST ?? DEFAULT_RELEASE_HOST

// Browser User-Agent for release-host downloads (see fetchToFileViaWget for
// the full rationale): Cloudflare Bot Fight Mode 403s curl + node-fetch by
// TLS fingerprint from datacenter IPs, and even wget needs a browser UA on
// top of its (unflagged) fingerprint to clear the challenge. RELEASE_CLIENT_ID
// rides in a custom header CF ignores so origin logs can still tell installer
// traffic apart.
const RELEASE_FETCH_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const RELEASE_CLIENT_ID = 'create-cavecms'
const DEFAULT_PORT = 3040
const MIN_NODE_MAJOR = 20

// Ed25519 public key for offline signature verification of the
// downloaded zip. Generated from ~/.cavecms-release-private.pem and
// bundled here so the CLI can verify releases without round-tripping
// to fetch it. When the operator-side key is rotated, this bundled
// pubkey is updated in lockstep + the CLI version bumped.
//
// Rotation procedure (run on the publisher's box):
//   1. openssl genpkey -algorithm ed25519 -out ~/.cavecms-release-private.pem
//      (this overwrites the old key — back up the OLD .pem first if you
//      want to keep verifying older releases)
//   2. openssl pkey -in ~/.cavecms-release-private.pem \
//                   -pubout -out ~/.cavecms-release-public.pem
//   3. Replace the contents of BUNDLED_PUBKEY_PEM below with the new PEM
//   4. Bump the CLI version in packages/create-cavecms/package.json
//   5. Re-publish pubkey.pem to timemacro:/var/www/cavecms-releases/pubkey.pem
//      (so older CLIs that never updated can still curl the new key as a
//      fallback during the rotation window)
//   6. npm publish the new CLI (npm publish --access=public)
//   7. Rebuild + republish every release that should be signed with the
//      new key (or honour the cutover by keeping the old key around to
//      sign-back-fill prior releases).
//
// The env-var fallback `CAVECMS_RELEASE_PUBKEY_PEM` lets a contributor
// override the bundled key for staging tests — but ONLY when the
// CAVECMS_DEV_BUILD=1 env gate is set, mirroring how --skip-signature
// is gated. Without the gate, an attacker who can set env vars on the
// install host could swap the bundled key with their own + sign a
// malicious release with the matching private key, and verification
// would "pass" against the wrong key. Production installs MUST use
// the bundled value.
const BUNDLED_PUBKEY_PEM_LITERAL = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgfwWFnEmpbmRzmmdExV5rjAG5YTeI44tGG1hziyWnJ8=
-----END PUBLIC KEY-----
`
const BUNDLED_PUBKEY_PEM =
  process.env.CAVECMS_DEV_BUILD === '1' && process.env.CAVECMS_RELEASE_PUBKEY_PEM
    ? process.env.CAVECMS_RELEASE_PUBKEY_PEM
    : BUNDLED_PUBKEY_PEM_LITERAL

// ════════════════════════════════════════════════════════════════════
// Tiny logging + prompt helpers (no deps)
// ════════════════════════════════════════════════════════════════════

const NO_COLOR = process.env.NO_COLOR === '1' || !process.stdout.isTTY
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}
function c(color, text) {
  return NO_COLOR ? text : `${C[color]}${text}${C.reset}`
}

const log = {
  header(msg) {
    const bar = '━'.repeat(63)
    console.log('')
    console.log(c('blue', bar))
    console.log(c('blue', c('bold', `       ${msg}`)))
    console.log(c('blue', bar))
    console.log('')
  },
  step(n, total, msg) {
    console.log(c('cyan', `[${n}/${total}]`) + ' ' + msg)
  },
  ok(msg) {
    console.log(c('green', '✓') + ' ' + msg)
  },
  warn(msg) {
    console.log(c('yellow', '⚠') + ' ' + msg)
  },
  err(msg) {
    console.error(c('red', '✗') + ' ' + msg)
  },
  info(msg) {
    console.log(c('gray', 'ℹ') + ' ' + msg)
  },
  gray(msg) {
    console.log('  ' + c('gray', msg))
  },
}

function die(msg) {
  log.err(msg)
  process.exit(1)
}

// Tiny helpers wrapping spawnSync('sudo', ...) so every call has a
// timeout AND we can centralise exit-code policy. Per the audit pass,
// silently-ignored chown / install failures are how PM2-surface installs
// end up with an app that boots fine but whose first in-app update
// silently fails to snapshot (because /var/lib/cavecms wasn't actually
// created). Two flavours: `runSudo` returns the spawnSync result so the
// caller can decide; `runSudoOrDie` dies on non-zero with a clear msg.
//
// Timeout default 30s — well above any expected sudo call duration but
// short enough that a wedged interaction (locked /etc/group during
// usermod, hung pm2 daemon during ping) surfaces in seconds, not the
// 2-minute default that node's spawnSync inherits from no explicit
// timeout (which is "forever").
const DEFAULT_SUDO_TIMEOUT_MS = 30000

function runSudo(args, opts = {}) {
  return spawnSync('sudo', args, {
    stdio: 'inherit',
    timeout: DEFAULT_SUDO_TIMEOUT_MS,
    ...opts,
  })
}

// Throws (not die()s) so failures during post-unpack work bubble up
// into main()'s catch handler, which prints the retry hint
// ("rm -rf $targetDir && npx create-cavecms <name>") BEFORE the
// top-level main().catch prints the error message + exits 1. Earlier
// versions called die() directly, which short-circuited that hint and
// left the operator without recovery guidance.
//
// Three failure modes worth differentiating:
//   1. r.error  → spawn itself failed (ENOENT: sudo not installed,
//      EACCES: not executable). Operator sees a useful "sudo not
//      found" instead of the misleading "exit unknown".
//   2. r.signal → killed by signal — most commonly our own timeout
//      via the DEFAULT_SUDO_TIMEOUT_MS option.
//   3. r.status !== 0 → sudo / inner command exited non-zero.
function runSudoOrDie(args, label) {
  const r = runSudo(args)
  if (r.status === 0) return r
  if (r.error) {
    throw new Error(`${label} failed to spawn sudo: ${r.error.message}`)
  }
  if (r.signal) {
    throw new Error(`${label} timed out (signal ${r.signal}) after ${DEFAULT_SUDO_TIMEOUT_MS / 1000}s: sudo ${args.join(' ')}`)
  }
  throw new Error(`${label} failed (exit ${r.status ?? 'unknown'}): sudo ${args.join(' ')}`)
}

// ════════════════════════════════════════════════════════════════════
// Argv parsing
// ════════════════════════════════════════════════════════════════════

// Site name shape — shared by the interactive prompt + the positional /
// env-var / --dir paths so an attacker-friendly value like
// `../../etc/foo` can't slip through the CLI's positional argument and
// reach the targetDir interpolation in defaultInstallDir(). Same regex
// the interactive prompt at line ~1690 uses.
const SITE_NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

function parseArgv(argv) {
  const out = {
    siteName: null,
    surface: 'auto',
    port: null,
    version: 'latest',
    yes: false,
    help: false,
    skipSignature: false,
    skipMigrate: false,
    skipStart: false,
    targetDir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') out.help = true
    else if (a === '-y' || a === '--yes') out.yes = true
    else if (a === '--skip-signature') {
      // Gate the signature-skip behind a dev-build env. Production
      // installs MUST verify the Ed25519 signature; advertising
      // --skip-signature in the help text was an attack surface
      // ("support says run this with --skip-signature").
      if (process.env.CAVECMS_DEV_BUILD !== '1') {
        die(
          '--skip-signature is not allowed on production builds.\n' +
            '  Set CAVECMS_DEV_BUILD=1 if you are developing the CaveCMS release pipeline.',
        )
      }
      out.skipSignature = true
    }
    else if (a === '--skip-migrate') out.skipMigrate = true
    else if (a === '--skip-start') out.skipStart = true
    else if (a.startsWith('--surface=')) out.surface = a.slice('--surface='.length)
    else if (a === '--surface') out.surface = argv[++i]
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length))
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length)
    else if (a === '--version' && i + 1 < argv.length) out.version = argv[++i]
    else if (a.startsWith('--dir=')) out.targetDir = a.slice('--dir='.length)
    else if (a === '--dir') out.targetDir = argv[++i]
    else if (a.startsWith('--')) die(`Unknown flag: ${a}`)
    else if (!out.siteName) out.siteName = a
    else die(`Unexpected positional argument: ${a}`)
  }
  return out
}

function showHelp() {
  console.log([
    '',
    c('bold', 'Usage:') + ' npx create-cavecms <site-name> [options]',
    '',
    c('bold', 'Options:'),
    '  --surface=auto|vps|pm2|cpanel|laptop  Force a deployment surface (default: auto)',
    '  --port=NUMBER                      Port the app listens on (default: 3040)',
    '  --version=X.Y.Z|latest             Release to install (default: latest)',
    '  --dir=PATH                         Override the install directory',
    '  --skip-signature                   (dev-build only) Skip Ed25519 signature check',
    '  --skip-migrate                     Don\'t run database migrations',
    '  --skip-start                       Don\'t start the service',
    '  -y, --yes                          Non-interactive: accept defaults + env-supplied answers',
    '  -h, --help                         Show this message',
    '',
    c('bold', 'Examples:'),
    '  npx create-cavecms my-site',
    '  npx create-cavecms acme --surface=vps',
    '  npx create-cavecms localdev --surface=laptop --port=3050',
    '  CAVECMS_DB_HOST=... CAVECMS_DB_USER=... npx create-cavecms my-site --yes',
    '',
    c('bold', 'Non-interactive env vars (used with -y):'),
    '  CAVECMS_DB_HOST          DB host (default: 127.0.0.1)',
    '  CAVECMS_DB_PORT          DB port (default: 3306)',
    '  CAVECMS_DB_USER          DB user (required)',
    '  CAVECMS_DB_PASSWORD      DB password (required)',
    '  CAVECMS_DB_NAME          DB name (default: cavecms)',
    '  CAVECMS_SITE_URL         Public site URL (e.g. https://mysite.com)',
    '',
  ].join('\n'))
}

// ════════════════════════════════════════════════════════════════════
// Prompt utilities — readline-based, no deps
// ════════════════════════════════════════════════════════════════════

async function withReadline(fn) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await fn(rl)
  } finally {
    rl.close()
  }
}

async function ask(rl, prompt, opts = {}) {
  const { defaultValue, validate, required } = opts
  for (;;) {
    const promptText = defaultValue
      ? `${prompt} ${c('gray', `(${defaultValue})`)}: `
      : `${prompt}: `
    const raw = (await rl.question(promptText)).trim()
    const val = raw || defaultValue || ''
    if (required && !val) {
      log.warn('This is required.')
      continue
    }
    if (validate) {
      const err = validate(val)
      if (err) {
        log.warn(err)
        continue
      }
    }
    return val
  }
}

async function askSecret(rl, prompt, opts = {}) {
  // Hide input via stdin manipulation. Falls back to plain readline
  // when stdin isn't a TTY (CI / piped input).
  //
  // CRITICAL: do NOT call process.stdin.pause() when this resolves.
  // The shared readline `rl` keeps prompting for DB name, site URL,
  // etc. after the password — pausing stdin yanks the TTY listener
  // readline depends on, the next rl.question() never sees input, the
  // event loop empties, and Node exits silently mid-install (looks
  // like "install just exited" to the operator). Restoring raw mode
  // off + detaching our own listener is enough; readline picks up
  // where it left off.
  if (!process.stdin.isTTY) {
    return ask(rl, prompt, opts)
  }
  process.stdout.write(`${prompt}: `)
  return new Promise((resolveP) => {
    let answer = ''
    const onData = (buf) => {
      const ch = buf.toString('utf8')
      // Handle each char individually.
      for (const c0 of ch) {
        if (c0 === '') {
          // Ctrl+C — restore terminal cleanly before exit so the
          // operator's shell doesn't end up with raw mode + no echo.
          process.stdin.setRawMode(false)
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          process.exit(130)
        } else if (c0 === '\r' || c0 === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolveP(answer)
          return
        } else if (c0 === '' || c0 === '\b') {
          if (answer.length > 0) answer = answer.slice(0, -1)
        } else {
          answer += c0
        }
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

async function confirm(rl, prompt, defaultYes = true) {
  const def = defaultYes ? 'Y/n' : 'y/N'
  const raw = (await rl.question(`${prompt} ${c('gray', `[${def}]`)}: `)).trim().toLowerCase()
  if (!raw) return defaultYes
  return raw === 'y' || raw === 'yes'
}

// ════════════════════════════════════════════════════════════════════
// Surface detection
// ════════════════════════════════════════════════════════════════════

function detectSurface() {
  // cPanel signal — the most distinctive of the three.
  // /usr/local/cpanel/version is present on every cPanel host since
  // the early 2000s and is reliably operator-readable.
  if (existsSync('/usr/local/cpanel/version')) return 'cpanel'

  // CageFS env vars are another reliable cPanel signal (set inside
  // jailed shells).
  if (process.env.CAGEFS_LC_ALL || process.env.LVE_NUM_GUESSED) return 'cpanel'

  // Hostname-based heuristic — shared-host names often contain
  // "cpanel" / "host" / "shared".
  // (Skipping — too fuzzy. cPanel detection should be deterministic.)

  // pm2 signal — shared Linux host that already runs other Next.js
  // apps under PM2 (e.g., a portfolio host serving N domains).
  // Detected BEFORE vps because such a host typically has systemd
  // too — the vps surface would otherwise win and overwrite the
  // host's nginx + systemd convention. Signals (ALL must match):
  //
  //   - pm2 binary is on PATH
  //   - the canonical web user `www-data` exists
  //   - the canonical PM2_HOME for the www-data daemon exists
  //   - we are root OR have passwordless sudo (needed to chown into
  //     /var/www/.. and write nginx state)
  //
  // The check happens before the vps check below so a host that
  // qualifies for BOTH (Ubuntu + nginx + PM2 + systemd, which is the
  // common shared-host shape) lands on pm2 — the surface that
  // coexists with whatever else is already on the box.
  if (detectPm2Surface()) return 'pm2'

  // VPS signal — has systemd as PID 1 AND we're root-or-sudo-able.
  // /run/systemd/system is the canonical "systemd is in charge" marker.
  if (existsSync('/run/systemd/system')) {
    // Distinguish a personal Linux laptop (which also has systemd)
    // from a server. Heuristic: if we can sudo without password OR
    // we're already root, treat as VPS. Otherwise laptop.
    if (process.geteuid && process.geteuid() === 0) return 'vps'
    // Probe `sudo -n true` — succeeds silently if passwordless sudo
    // is configured (typical on VPS root accounts after setup) OR
    // if the user has cached sudo creds.
    const probe = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' })
    if (probe.status === 0) return 'vps'
  }

  // Default to laptop.
  return 'laptop'
}

/**
 * Reusable PM2-surface signal probe. Lifted out of detectSurface
 * so the help text + the post-detect logging can quote the exact
 * reasons we did/didn't pick pm2 without duplicating the conditions.
 */
function detectPm2Surface() {
  const hasPm2 = spawnSync('command', ['-v', 'pm2'], { shell: '/bin/bash', stdio: 'ignore' }).status === 0
  if (!hasPm2) return false
  const hasWwwData = spawnSync('id', ['www-data'], { stdio: 'ignore' }).status === 0
  if (!hasWwwData) return false
  const pm2Home = process.env.CAVECMS_PM2_HOME ?? '/var/www/.pm2'
  if (!existsSync(pm2Home)) return false
  if (process.geteuid && process.geteuid() === 0) return true
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0
}

// ════════════════════════════════════════════════════════════════════
// Pre-flight
// ════════════════════════════════════════════════════════════════════

function preflightNodeVersion() {
  const [majorStr] = process.versions.node.split('.')
  const major = Number(majorStr)
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    die(
      `Node ${MIN_NODE_MAJOR}+ required, found ${process.versions.node}. ` +
        `Install a newer Node via nvm (https://github.com/nvm-sh/nvm) or your platform's package manager.`,
    )
  }
}

function preflightPlatform() {
  const p = platform()
  if (p === 'win32') {
    die('Windows is not a supported deployment surface for CaveCMS. Use WSL2 + Ubuntu or a Linux VPS.')
  }
}

function preflightDeps() {
  const required = ['unzip', 'curl']
  const missing = []
  for (const cmd of required) {
    const r = spawnSync('command', ['-v', cmd], { shell: '/bin/bash', stdio: 'ignore' })
    if (r.status !== 0) missing.push(cmd)
  }
  if (missing.length) {
    die(
      `Missing required commands: ${missing.join(', ')}. ` +
        `Install via your OS package manager (e.g. apt install ${missing.join(' ')} on Debian/Ubuntu).`,
    )
  }
}

/**
 * Refuse if the chosen app port is already bound. Without this, the
 * service starts up and silently fails to listen — operator sees the
 * "running on https://…" banner but the public URL 502s.
 *
 * Linux: `ss -tnl` (preferred — coreutils on every modern distro).
 * macOS: `lsof -nP -iTCP:PORT -sTCP:LISTEN`.
 * Falls back to /dev/tcp probe if neither is available.
 */
function preflightPort(port) {
  const portStr = String(port)

  // Linux: ss is part of iproute2, present everywhere.
  let ss = spawnSync('ss', ['-tnl'], { encoding: 'utf8' })
  if (ss.status === 0 && typeof ss.stdout === 'string') {
    // Match the "Local Address:Port" column: `:PORT ` or `:PORT$`.
    const re = new RegExp(`[:.]${portStr}\\b`)
    for (const line of ss.stdout.split('\n').slice(1)) {
      if (re.test(line)) {
        die(
          `Port ${port} is already bound on this host.\n` +
            `  ${line.trim()}\n` +
            `  Pick a different port with --port=NNNN (any 4-digit unused port works).`,
        )
      }
    }
    return
  }
  // macOS / BSD: lsof.
  const lsof = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${portStr}`, '-sTCP:LISTEN'],
    { encoding: 'utf8' },
  )
  if (lsof.status === 0 && typeof lsof.stdout === 'string' && lsof.stdout.trim().length > 0) {
    die(
      `Port ${port} is already bound on this host.\n` +
        `  ${lsof.stdout.trim().split('\n').slice(1, 2).join(' ').slice(0, 100)}\n` +
        `  Pick a different port with --port=NNNN.`,
    )
  }
  // Neither ss nor lsof — quiet pass; the actual bind failure on start
  // will be loud enough.
}

/**
 * VPS-only collision guards. Run before download/install so the
 * operator finds out about a conflict in <2 seconds instead of after
 * a 70 MB download + extraction.
 *
 * 1. /etc/systemd/system/cavecms.service must NOT exist (would otherwise
 *    be overwritten by startVps).
 * 2. The operator's siteUrl host must NOT already appear in an
 *    existing nginx/apache vhost (would collide on ServerName +
 *    confuse the certbot flow).
 */
function preflightVpsCollisions({ targetDir, siteUrl }) {
  if (existsSync('/etc/systemd/system/cavecms.service')) {
    // We refuse rather than overwrite so a running CaveCMS install
    // (with a sealed env.production + an active service + uploads in
    // /opt/cavecms/uploads) is never silently replaced by this run.
    // The operator removes the unit themselves so the act of replacing
    // an install is deliberate, audit-able, and impossible to confuse
    // with "the installer hiccupped." Same posture as overwriting any
    // other production-shaped state — see #0.5 (never fix prod state
    // implicitly; require explicit operator action).
    die(
      'A cavecms.service systemd unit already exists at /etc/systemd/system/cavecms.service.\n' +
        '  Refusing to overwrite — a CaveCMS install may already be running here.\n' +
        '\n' +
        '  If you intend to replace it (e.g. re-installing on a host where a prior\n' +
        '  install failed or you want a clean slate), remove the existing unit first:\n' +
        '\n' +
        '    sudo systemctl disable --now cavecms.service\n' +
        '    sudo rm /etc/systemd/system/cavecms.service\n' +
        '    sudo systemctl daemon-reload\n' +
        '\n' +
        '  Then re-run this installer. If the old install also wrote to /opt/cavecms,\n' +
        '  inspect that directory before re-using the path — it contains the previous\n' +
        '  env.production (with the prior LOGIN_PATH + secrets) and any uploads.',
    )
  }
  scanWebserverForHostCollision(siteUrl)
}

/**
 * Scan nginx + Apache config trees for a vhost claiming `host` (the
 * hostname of `siteUrl`). die()s with a clear list of matching files
 * if one is found; returns silently when no collision detected, or
 * when siteUrl is empty / unparseable / there are no web-server
 * config dirs to scan.
 *
 * Extracted from preflightVpsCollisions + preflightPm2Collisions which
 * previously inlined the same regex+grep loop verbatim.
 */
function scanWebserverForHostCollision(siteUrl) {
  if (!siteUrl) return
  let host = ''
  try {
    host = new URL(siteUrl).hostname.toLowerCase()
  } catch {
    return
  }
  if (!host) return
  const places = [
    '/etc/nginx',
    '/etc/apache2/sites-available',
    '/etc/apache2/sites-enabled',
    '/etc/httpd/conf.d',
  ].filter((p) => existsSync(p))
  if (places.length === 0) return
  const escapedHost = host.replace(/\./g, '\\.')
  const patterns = [
    `\\bserver_name[ \\t][^;]*\\b${escapedHost}\\b`,
    `\\bServerName[ \\t]+${escapedHost}\\b`,
    `\\bServerAlias[ \\t][^\\n]*\\b${escapedHost}\\b`,
  ]
  for (const dir of places) {
    for (const pattern of patterns) {
      const r = spawnSync('grep', ['-rIlE', pattern, dir], {
        encoding: 'utf8',
        timeout: 10000,
      })
      if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim().length > 0) {
        const files = r.stdout.trim().split('\n').slice(0, 3)
        die(
          `The hostname ${host} is already in an existing web-server config:\n` +
            files.map((f) => `  ${f}`).join('\n') +
            '\n  Pick a different subdomain OR remove the existing config first.',
        )
      }
    }
  }
}

/**
 * PM2-only collision guards. Same shape as preflightVpsCollisions but
 * tuned for the shared-host model:
 *
 * 1. A PM2 app with this install's name must NOT already be running
 *    under the www-data daemon. Without this, `pm2 start` happily
 *    starts a SECOND instance with the same name (PM2 allows
 *    name dupes by design) — port conflict + log scribbling ensue.
 * 2. The operator's siteUrl host must NOT already appear in an
 *    existing nginx vhost (reuses the same scan as the VPS guard).
 */
function preflightPm2Collisions({ pm2AppName, siteUrl, pm2User, pm2Home }) {
  // Probe pm2 jlist as the runUser daemon. If the call fails for any
  // reason (sudo prompt, pm2 daemon not yet started for this user),
  // we pass through silently — the actual `pm2 start` later in the
  // flow will surface a clearer error than we could synthesise here.
  // Timeout: 10s — a wedged daemon (orphaned IPC socket at
  // $PM2_HOME/rpc.sock after a kernel OOM-kill) would otherwise hang
  // the install indefinitely.
  const probe = spawnSync(
    'sudo',
    ['-n', '-u', pm2User, 'env', `PM2_HOME=${pm2Home}`, 'pm2', 'jlist'],
    { encoding: 'utf8', timeout: 10000 },
  )
  if (probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim().length > 0) {
    let parsed
    let parseErr = null
    try {
      parsed = JSON.parse(probe.stdout)
    } catch (err) {
      parsed = null
      parseErr = err
    }
    // Parse failure on non-empty stdout means jlist returned junk
    // (truncated by a daemon mid-restart, OR pm2 binary outputting a
    // warning before the JSON). Don't silently pass — a real
    // collision could be hiding here. Fail loud + show the diagnosis.
    if (parsed === null && parseErr) {
      die(
        `pm2 jlist returned unparseable output — refusing to start an app whose name might already collide with a registered app.\n` +
          `  Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n` +
          `  First 200 chars of stdout: ${probe.stdout.slice(0, 200)}\n` +
          `  Investigate: sudo -u ${pm2User} PM2_HOME=${pm2Home} pm2 jlist`,
      )
    }
    if (Array.isArray(parsed)) {
      const collision = parsed.find((p) => p && p.name === pm2AppName)
      if (collision) {
        die(
          `A PM2 app named "${pm2AppName}" is already registered under ${pm2User}'s PM2 daemon.\n` +
            `  pid=${collision.pid ?? '?'} status=${collision.pm2_env?.status ?? '?'}\n` +
            `\n` +
            `  Refusing to start a second instance. If this is an old install you want to\n` +
            `  replace, stop and delete it first:\n` +
            `\n` +
            `    sudo -u ${pm2User} PM2_HOME=${pm2Home} pm2 delete ${pm2AppName}\n` +
            `    sudo -u ${pm2User} PM2_HOME=${pm2Home} pm2 save\n` +
            `\n` +
            `  Then re-run this installer. If the prior install also wrote to\n` +
            `  /var/www/html/<site>/public_html, inspect that path before re-using it.`,
        )
      }
    }
  }
  // Same nginx + Apache server_name collision scan that VPS surface
  // uses — extracted to a shared helper.
  scanWebserverForHostCollision(siteUrl)
}

function defaultInstallDir(surface, siteName) {
  if (surface === 'vps') return `/opt/cavecms`
  if (surface === 'pm2') {
    // Mirror the convention every other Next.js site on a shared
    // Debian/Ubuntu nginx box uses: /var/www/html/<host>/public_html.
    // The siteName is expected to be the public hostname (operator
    // usually passes the apex/sub the install will serve) so the
    // install dir naturally aligns with the nginx vhost's document
    // root. When the operator picks a non-domain site name (e.g.
    // 'my-test'), the path still works — they just won't see the
    // 1:1 alignment in `ls /var/www/html`.
    return `/var/www/html/${siteName || 'cavecms'}/public_html`
  }
  if (surface === 'cpanel') return join(homedir(), siteName || 'cavecms')
  return resolve(process.cwd(), siteName || 'cavecms')
}

function preflightTargetDir(targetDir) {
  // Returns true if the CLI created the dir itself, so the main()
  // wrapper can rm it on failure without clobbering operator-owned
  // directories. Pre-existing empty dirs are left alone.
  let createdByUs = false
  if (existsSync(targetDir)) {
    const contents = readdirSync(targetDir).filter((n) => !n.startsWith('.'))
    if (contents.length > 0) {
      die(
        `Target directory is not empty: ${targetDir}\n` +
          `  Either remove it (mv ${targetDir} ${targetDir}.bak) or pass a different --dir.`,
      )
    }
  } else {
    // Try to create it — surfaces the permission error early.
    try {
      mkdirSync(targetDir, { recursive: true })
      createdByUs = true
    } catch (err) {
      die(`Cannot create install directory ${targetDir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Verify we can write to it.
  try {
    accessSync(targetDir, fsConstants.W_OK)
  } catch {
    die(`No write permission for ${targetDir}. Re-run with sudo, or pick a directory you own.`)
  }
  return createdByUs
}

// ════════════════════════════════════════════════════════════════════
// Download + verify
// ════════════════════════════════════════════════════════════════════

// Cloudflare Bot Fight Mode (Free plan, account-wide — can't be scoped via
// WAF rules) fingerprints curl + Node's undici `fetch` by their TLS
// handshake (JA3) and 403s them from datacenter IPs regardless of the
// User-Agent, which broke installs from every cloud VPS. Empirically, wget's
// fingerprint + a browser UA is the one combo that clears the challenge
// (verified against the release host from an AWS VPS: wget+UA → 200, while
// curl and node-fetch → 403 even with the same UA). So every release-host
// download — manifest AND zip — goes through wget. `timeoutSec` is wget's
// per-stall read/connect timeout; the manifest is a few KiB, the zip ~70 MiB.
function fetchToFileViaWget(url, destPath, timeoutSec) {
  const res = spawnSync(
    'wget',
    [
      '--quiet',
      `--timeout=${timeoutSec}`,
      '--tries=3',
      '--user-agent', RELEASE_FETCH_UA,
      '--header', `X-CaveCMS-Client: ${RELEASE_CLIENT_ID}`,
      '-O', destPath,
      url,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      die(
        'wget is required to download the release but is not installed.\n' +
          '  Install it and re-run:  Debian/Ubuntu → sudo apt install wget   ·   RHEL/Alma → sudo yum install wget',
      )
    }
    die(`wget couldn't run downloading ${url}: ${res.error.message}`)
  }
  if (res.status !== 0) {
    die(
      `wget failed (exit ${res.status}) downloading ${url}. ` +
        `If this is an HTTP 403, the release host's CDN is challenging this server.`,
    )
  }
  return destPath
}

function sha256OfFile(path) {
  const h = createHash('sha256')
  const buf = readFileSync(path)
  h.update(buf)
  return h.digest('hex')
}

function verifyEd25519(payloadPath, sigBase64, pubkeyPem) {
  try {
    const pubkey = createPublicKey({ key: pubkeyPem, format: 'pem' })
    if (pubkey.asymmetricKeyType !== 'ed25519') {
      die(`Bundled public key is ${pubkey.asymmetricKeyType}, expected ed25519. The CLI cannot verify this release safely.`)
    }
    const sig = Buffer.from(sigBase64, 'base64')
    const payload = readFileSync(payloadPath)
    // Ed25519 PureEdDSA — Node's crypto.verify with null digest.
    const ok = cryptoVerify(null, payload, pubkey, sig)
    return ok
  } catch (err) {
    log.warn(`Signature verify threw: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function downloadAndVerify({ targetDir, version, skipSignature }) {
  const manifestUrl = `${RELEASE_HOST}/manifest.json`
  // Put staging in $TMPDIR so a half-failed download doesn't leave
  // artifacts inside the operator's target dir (which would then trip
  // preflightTargetDir's non-empty refusal on retry). Random suffix
  // so concurrent installs don't collide.
  const stagingDir = join(
    tmpdir(),
    `create-cavecms-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  mkdirSync(stagingDir, { recursive: true })
  // Best-effort cleanup if Node exits before we explicitly rm.
  const cleanupOnExit = () => {
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  process.on('exit', cleanupOnExit)

  log.info(`Fetching release index from ${manifestUrl}…`)
  const manifestPath = join(stagingDir, 'manifest.json')
  try {
    fetchToFileViaWget(manifestUrl, manifestPath, 60)
  } catch (err) {
    die(`Couldn't fetch release manifest: ${err instanceof Error ? err.message : String(err)}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.releases) || manifest.releases.length === 0) {
    die('Release manifest is empty — the dist host is misconfigured.')
  }
  const target = version === 'latest'
    ? manifest.releases[0]
    : manifest.releases.find((r) => r.version === version)
  if (!target) {
    die(
      `Version "${version}" not found in the release manifest. ` +
        `Available: ${manifest.releases.map((r) => r.version).join(', ')}`,
    )
  }
  log.ok(`Will install CaveCMS ${target.version} (published ${target.publishedAt})`)
  if (target.isSecurity) {
    log.warn('This is marked as a security release. Continuing.')
  }

  // Same-origin guard on downloadUrl. Without this, a tampered manifest
  // could point downloadUrl at attacker.com with a matching sha256 +
  // signature from a key the attacker controls. The in-app updater
  // (lib/updates/checkLatestRelease.ts) enforces the same gate via
  // CAVECMS_RELEASE_DOWNLOAD_ORIGINS — mirror it here so the CLI path
  // can't be the soft spot.
  try {
    const manifestOrigin = new URL(manifestUrl).origin
    const downloadOrigin = new URL(target.downloadUrl).origin
    if (downloadOrigin !== manifestOrigin) {
      const allowedRaw = process.env.CAVECMS_RELEASE_DOWNLOAD_ORIGINS
      const allowed = allowedRaw
        ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : []
      if (!allowed.includes(downloadOrigin)) {
        die(
          `Manifest points downloadUrl at a different origin than the manifest itself.\n` +
            `  manifest: ${manifestOrigin}\n` +
            `  download: ${downloadOrigin}\n` +
            `  Refusing to install. If your fork legitimately splits manifest + zip across origins,\n` +
            `  set CAVECMS_RELEASE_DOWNLOAD_ORIGINS to the allowed list (comma-separated).`,
        )
      }
    }
    if (!/^https:\/\//i.test(target.downloadUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(target.downloadUrl)) {
      die(`downloadUrl must be HTTPS (got: ${target.downloadUrl})`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Manifest points')) throw err
    die(`Invalid downloadUrl in manifest: ${target.downloadUrl}`)
  }

  // Download the zip via curl (memory-friendly for large files).
  const zipPath = join(stagingDir, `cavecms-${target.version}.zip`)
  log.info(`Downloading ${target.downloadUrl}…`)
  fetchToFileViaWget(target.downloadUrl, zipPath, 1800)

  // SHA-256 verify against the manifest's claim.
  log.info('Verifying SHA-256…')
  const actualSha = sha256OfFile(zipPath)
  if (actualSha !== target.sha256) {
    die(
      `SHA-256 mismatch — refusing to install.\n` +
        `  Expected: ${target.sha256}\n` +
        `  Got:      ${actualSha}\n` +
        `  This means the download was corrupted OR the manifest doesn't match the zip.\n` +
        `  Try again. If it persists, report this URL: ${target.downloadUrl}`,
    )
  }
  log.ok('SHA-256 matches the manifest.')

  // Ed25519 signature verify.
  if (skipSignature) {
    log.warn('Skipping Ed25519 signature verification (--skip-signature).')
  } else if (!BUNDLED_PUBKEY_PEM) {
    log.warn(
      'No bundled public key — Ed25519 signature verification skipped. ' +
        'Future CLI versions will require this. SHA-256 + HTTPS still anchor integrity.',
    )
  } else if (!target.signature) {
    // Since BUNDLED_PUBKEY_PEM is non-empty here (the prior else-if
    // branch handled the empty case), we have a key and the manifest
    // is unsigned. Refuse — an unsigned release with a bundled pubkey
    // is either (a) a manifest tampered to null out signature for a
    // sha256-only attack, or (b) a real publisher mistake. Either way,
    // bailing is safer than installing.
    die(
      `Manifest entry for ${target.version} has no Ed25519 signature, but this CLI ships with a bundled public key.\n` +
        `  Refusing to install unsigned releases. Either:\n` +
        `    - publish a signed manifest (the publisher's release pipeline should sign by default), or\n` +
        `    - downgrade to a CLI version without a bundled pubkey if you really mean to install unsigned releases.`,
    )
  } else {
    log.info('Verifying Ed25519 signature…')
    const ok = verifyEd25519(zipPath, target.signature, BUNDLED_PUBKEY_PEM)
    if (!ok) {
      die(
        `Ed25519 signature verification FAILED for ${target.downloadUrl}.\n` +
          `  This release zip does not match its declared signature.\n` +
          `  Refusing to install. Report to security@derricksiawor.com.`,
      )
    }
    log.ok('Ed25519 signature verified.')
  }

  return { zipPath, stagingDir, release: target }
}

// ════════════════════════════════════════════════════════════════════
// Unpack
// ════════════════════════════════════════════════════════════════════

function unpackZip({ zipPath, targetDir, release, stagingDir }) {
  log.info(`Unpacking into ${targetDir}…`)
  // Extract into staging, then move the cavecms-X.Y.Z/ inner dir
  // contents into targetDir. This isolates the unpack atomicity:
  // a half-extracted tree never appears in the operator's target dir.
  const extractDir = join(stagingDir, 'extract')
  mkdirSync(extractDir, { recursive: true })
  const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', extractDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (res.status !== 0) {
    die(`unzip failed (exit ${res.status}). The downloaded zip may be corrupted.`)
  }
  const innerDir = join(extractDir, `cavecms-${release.version}`)
  if (!existsSync(innerDir)) {
    die(`Expected ${innerDir} inside the zip, not found. Bad zip structure.`)
  }
  // Move the inner dir's contents into targetDir using `cp -a` (BSD +
  // GNU). NOT `fs.cpSync` — that ABSOLUTIFIES relative symlinks on
  // copy (turning `node_modules/mysql2 → .pnpm/...` into
  // `node_modules/mysql2 → /tmp/user/0/create-cavecms-PID/extract/...`)
  // which then dangles once the staging dir is cleaned up. pnpm-shaped
  // standalones ship many relative symlinks (one per direct dep of
  // every package, plus the .pnpm content store) and breaking any of
  // them takes the customer's runtime down. `cp -a` preserves symlink
  // targets verbatim. Same fix as scripts/release/build-zip.mjs.
  const cpRes = spawnSync('cp', ['-a', innerDir + '/.', targetDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (cpRes.status !== 0) {
    die(`cp -a failed (exit ${cpRes.status}) moving the extracted zip into ${targetDir}.`)
  }
  // Clean up staging.
  try {
    rmSync(stagingDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  log.ok('Unpacked.')
}

// ════════════════════════════════════════════════════════════════════
// Prompts for DB + site config
// ════════════════════════════════════════════════════════════════════

function envOr(envVar, fallback) {
  const v = process.env[envVar]
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

async function gatherConfig({ surface, siteName, port, yes }) {
  const config = {
    db: {
      host: envOr('CAVECMS_DB_HOST', '127.0.0.1'),
      port: Number(envOr('CAVECMS_DB_PORT', '3306')),
      user: envOr('CAVECMS_DB_USER', ''),
      password: envOr('CAVECMS_DB_PASSWORD', ''),
      name: envOr('CAVECMS_DB_NAME', 'cavecms'),
    },
    siteUrl: envOr('CAVECMS_SITE_URL', ''),
    port: port ?? Number(envOr('CAVECMS_PORT', String(DEFAULT_PORT))),
  }

  if (yes) {
    if (!config.db.user) die('CAVECMS_DB_USER is required in non-interactive mode (--yes).')
    if (!config.db.password) die('CAVECMS_DB_PASSWORD is required in non-interactive mode (--yes).')
    return config
  }

  await withReadline(async (rl) => {
    console.log('')
    console.log(c('bold', 'Database connection'))
    console.log(c('gray', 'Point at your MariaDB instance. Create the user + DB first if needed.'))
    config.db.host = await ask(rl, 'DB host', { defaultValue: config.db.host, required: true })
    const portStr = await ask(rl, 'DB port', {
      defaultValue: String(config.db.port),
      validate: (v) => (/^\d+$/.test(v) ? null : 'Port must be a positive integer.'),
    })
    config.db.port = Number(portStr)
    config.db.user = await ask(rl, 'DB user', { defaultValue: config.db.user || 'cavecms', required: true })
    config.db.password = await askSecret(rl, 'DB password', { required: true })
    config.db.name = await ask(rl, 'DB name', { defaultValue: config.db.name, required: true })

    console.log('')
    console.log(c('bold', 'Site identity'))
    if (surface === 'laptop') {
      config.siteUrl = await ask(rl, 'Public site URL', {
        defaultValue: config.siteUrl || `http://localhost:${config.port}`,
        validate: (v) => (/^https?:\/\/.+/.test(v) ? null : 'Must be http:// or https:// URL.'),
      })
    } else {
      config.siteUrl = await ask(rl, 'Public site URL', {
        defaultValue: config.siteUrl || '',
        required: true,
        validate: (v) => {
          if (!/^https:\/\/.+/.test(v)) return 'Must be an https:// URL.'
          if (v.endsWith('/')) return 'Drop the trailing slash (e.g. https://mysite.com).'
          return null
        },
      })
    }
    const newPortStr = await ask(rl, 'App listen port', {
      defaultValue: String(config.port),
      validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? null : 'Port must be 1-65535.'),
    })
    config.port = Number(newPortStr)
  })

  return config
}

// ════════════════════════════════════════════════════════════════════
// Secrets
// ════════════════════════════════════════════════════════════════════

function genSecret(bytes = 64) {
  return randomBytes(bytes).toString('base64')
}

function genLoginPath() {
  // 12 chars, [a-z], with the first char [a-z] to avoid leading-digit
  // ambiguity. Customers can change it later via Settings → Security.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const buf = randomBytes(16)
  let out = ''
  for (let i = 0; i < 12; i++) out += alphabet[buf[i] % alphabet.length]
  // First char is a letter for path-safety/clarity.
  return out
}

function genUrlToken(bytes = 32) {
  // URL-safe base64 (no +/=) so the token can land in a URL query
  // string without further encoding pain.
  return randomBytes(bytes).toString('base64url')
}

function generateSecrets() {
  return {
    JWT_SECRET: genSecret(64),
    CSRF_SECRET: genSecret(64),
    PREVIEW_SECRET: genSecret(64),
    BROCHURE_SECRET: genSecret(64),
    INTERNAL_REVALIDATE_SECRET: genSecret(64),
    // env.ts requires EXACTLY 32 decoded bytes for this one (AES-256-GCM).
    SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    LOGIN_PATH: genLoginPath(),
    // Single-use install gate. The wizard's /api/install/* endpoints
    // require this token in an X-Install-Token header (or ?t= query
    // param the wizard page forwards). Closes the public-internet
    // window where an attacker who knows the dist host could race
    // the operator to /api/install/admin-create.
    INSTALL_BOOTSTRAP_TOKEN: genUrlToken(32),
    // Bearer token the in-app updater's healthz verification step + the
    // watchdog use to call the verbose /healthz endpoint after a pm2
    // reload. Without this, step 6 of scripts/cavecms-update.sh can't
    // verify the new commit is live and rollback won't trigger on a
    // failed reload. 32 bytes hex matches the canonical setup.sh seed.
    HEALTHZ_TOKEN: randomBytes(32).toString('hex'),
  }
}

// ════════════════════════════════════════════════════════════════════
// Env writer (sealed)
// ════════════════════════════════════════════════════════════════════

function normalizeCommitSha(raw) {
  // Manifest entries written by scripts/release/build-zip.mjs since the
  // signing-pipeline change carry the full 40-char hex sha. Older entries
  // (published before that change) have no `sha` field — we fall back to
  // 'dev' so getCurrentVersion() classifies it as "no update possible" and
  // the apply route refuses with cannot_apply_from_dev (matches local-dev
  // semantics). lib/updates/getCurrentVersion.ts enforces a 7-64 hex regex,
  // so we slice to 12 chars (short SHA) when valid hex is present.
  //
  // We log a warning when we fall through to 'dev' because the install
  // will then be unable to use the in-app updater — operator must
  // re-run with a newer CLI / manifest.
  if (typeof raw !== 'string') {
    log.warn('Manifest entry has no `sha` field — env.production will carry CAVECMS_COMMIT=dev. In-app updater will refuse to run until you re-install from a newer CLI.')
    return 'dev'
  }
  const trimmed = raw.trim()
  if (!/^[0-9a-f]{7,64}$/i.test(trimmed)) {
    log.warn(`Manifest entry's \`sha\` field is not valid hex (${JSON.stringify(trimmed.slice(0, 16))}…) — env.production will carry CAVECMS_COMMIT=dev.`)
    return 'dev'
  }
  return trimmed.slice(0, 12)
}

function buildDatabaseUrl({ host, port, user, password, name }) {
  // mysql2 accepts a URI directly. URL-encode credentials to survive
  // any non-alphanumeric chars in the password.
  const u = encodeURIComponent(user)
  const p = encodeURIComponent(password)
  return `mysql://${u}:${p}@${host}:${port}/${encodeURIComponent(name)}`
}

function writeSealedEnv({ targetDir, surface, config, secrets, release }) {
  // env.production lives at the install root. The standalone server
  // reads it via the `node --env-file=env.production` flag from
  // scripts/start-standalone.mjs (and we patch start-standalone to
  // pick it up — see below).
  const envPath = join(targetDir, 'env.production')

  const databaseUrl = buildDatabaseUrl(config.db)
  const uploadsRoot =
    surface === 'vps'
      ? '/opt/cavecms/uploads'
      : join(targetDir, 'uploads')

  // Per-install state dir for runtime artefacts that have to survive
  // an atomic-swap update (the current-symlink flip moves the install
  // dir aside, so anything we want to keep across updates lives
  // OUTSIDE that dir on the VPS surface — see the symlink flow in
  // scripts/deploy.sh — but for the CLI's PM2/systemd/manual surfaces
  // the install dir IS stable across updates, so a sibling dir works
  // fine). The in-app updater (lib/updates/statusFile.ts) reads
  // `CAVECMS_STATE_DIR` to decide where to put the status file +
  // cross-process lock; without this env var the updater defaults to
  // /var/lib/cavecms/ which requires the PM2 daemon to be re-execed
  // before its supplementary `cavecmsstate` group takes effect — a
  // chicken-and-egg that breaks the first-install-then-update flow
  // for every new customer.
  const stateDir =
    surface === 'vps'
      ? '/opt/cavecms/state'
      : join(targetDir, '.cavecms-state')

  const lines = [
    `# ----------------------------------------------------------------------`,
    `# CaveCMS sealed env.production`,
    `#`,
    `# This file was generated ONCE by 'npx create-cavecms' at install time.`,
    `# The CaveCMS install wizard + admin dashboard own all subsequent`,
    `# configuration via the 'settings' table. You should NEVER edit this`,
    `# file by hand. If a value here is wrong, re-run the installer or`,
    `# rotate the secret with the CLI's --rotate flag (future).`,
    `# ----------------------------------------------------------------------`,
    `NODE_ENV=production`,
    `PORT=${config.port}`,
    `DATABASE_URL=${databaseUrl}`,
    `JWT_SECRET=${secrets.JWT_SECRET}`,
    `CSRF_SECRET=${secrets.CSRF_SECRET}`,
    `PREVIEW_SECRET=${secrets.PREVIEW_SECRET}`,
    `BROCHURE_SECRET=${secrets.BROCHURE_SECRET}`,
    `INTERNAL_REVALIDATE_SECRET=${secrets.INTERNAL_REVALIDATE_SECRET}`,
    `SECRETS_ENCRYPTION_KEY=${secrets.SECRETS_ENCRYPTION_KEY}`,
    `LOGIN_PATH=${secrets.LOGIN_PATH}`,
    `INSTALL_BOOTSTRAP_TOKEN=${secrets.INSTALL_BOOTSTRAP_TOKEN}`,
    `HEALTHZ_TOKEN=${secrets.HEALTHZ_TOKEN}`,
    `UPLOADS_ROOT=${uploadsRoot}`,
    `# Per-install runtime-state directory for the in-app updater + watchdog.`,
    `# Owned by the runtime user → no pm2-daemon-restart needed for in-app`,
    `# updates to work. lib/updates/statusFile.ts reads this and falls back`,
    `# to /var/lib/cavecms/ when unset (legacy installs).`,
    `CAVECMS_STATE_DIR=${stateDir}`,
    `# Per-install snapshot root for the in-app updater's pre-destructive`,
    `# rsync. Owned by the runtime user (same writability story as STATE_DIR).`,
    `# Default would be /var/lib/cavecms/snapshots — requires the cavecmsstate`,
    `# supplementary group which a stale PM2 daemon doesn't have.`,
    `CAVECMS_SNAPSHOT_ROOT=${stateDir}/snapshots`,
    `# Release bookkeeping — re-stamped on every in-app update.`,
    `# CAVECMS_COMMIT is the short (12-char) git SHA the release was built`,
    `# from. The in-app updater compares this against the latest manifest's`,
    `# sha via getCurrentVersion() to decide "is an update available?". A`,
    `# missing or 'dev' value here disables the updater (cannot_apply_from_dev).`,
    `CAVECMS_COMMIT=${normalizeCommitSha(release?.sha)}`,
    `CAVECMS_RELEASE_TS=${new Date().toISOString()}`,
    `# The CLI installed this from cavecms.derricksiawor.com — keep this in sync`,
    `# with the dist host on forks so the in-app updater stays in lockstep.`,
    `CAVECMS_RELEASE_MANIFEST_URL=${RELEASE_HOST}/updates/latest.json`,
    ``,
  ].join('\n')
  // Mode 600 at create time — closes the brief world-readable window
  // between writeFileSync (creates with umask, typically 0644) and a
  // subsequent chmod. On shared cPanel hosts that race is real.
  writeFileSync(envPath, lines, { mode: 0o600 })
  // Defence in depth: re-set mode in case the platform's umask
  // overrode the requested mode flag.
  chmodSync(envPath, 0o600)
  // Verify — refuse install if the mode didn't stick (would only happen
  // on an exotic filesystem; explicit check beats silent failure).
  const finalMode = statSync(envPath).mode & 0o777
  if (finalMode !== 0o600) {
    die(`env.production ended up with mode ${finalMode.toString(8)}, expected 600. Filesystem may not support POSIX modes — operator must lock it manually.`)
  }
  // Provision the uploads tree. Boot-time `assertSameFs` in
  // lib/media/storage.ts requires all 4 subdirs to exist on the same
  // filesystem before it'll let the process serve traffic; in prod
  // mode a missing dir is a FATAL exit, not a warning. setup.sh does
  // this for the bare-metal deploy.sh path; CLI installs need to
  // replicate it. Mode 0o750 matches setup.sh's `install -d -m 750`
  // for uploads dirs. chown to the runtime user happens later in the
  // surface-specific startup (startPm2 / startVps chown -R the
  // targetDir which contains these).
  for (const sub of ['', '.tmp', 'originals', 'variants', 'brochures-private']) {
    mkdirSync(sub ? join(uploadsRoot, sub) : uploadsRoot, { recursive: true, mode: 0o750 })
  }
  // Provision the per-install state dir. Same chown-on-surface-start
  // mechanism as uploads — the dir gets created here, then the
  // surface-specific startup (startPm2 / startSystemd) chown -R's the
  // whole targetDir which includes this subtree. Mode 0o750 matches
  // uploads — owner full, group rx, world none.
  mkdirSync(stateDir, { recursive: true, mode: 0o750 })
  // Snapshot subdir for the in-app updater's pre-destructive rsync.
  // Provisioned here so the orchestrator's snapshot_current_tree can
  // `mkdir -p` + write into it on the very first update without
  // requiring the runtime user to have group write on /var/lib/cavecms/.
  mkdirSync(join(stateDir, 'snapshots'), { recursive: true, mode: 0o750 })
  return { envPath, databaseUrl, uploadsRoot, stateDir }
}

// ════════════════════════════════════════════════════════════════════
// Migrate
// ════════════════════════════════════════════════════════════════════

function runMigrations({ targetDir, envPath }) {
  const scriptPath = join(targetDir, 'scripts', 'install-migrate.mjs')
  if (!existsSync(scriptPath)) {
    die(
      `Migration runner missing: ${scriptPath}\n` +
        `  The release zip is incomplete. Report this as a bug.`,
    )
  }
  log.info('Running database migrations…')
  // node --env-file= reads the sealed env.production at startup, so
  // the runner sees DATABASE_URL without us shelling out to source it.
  const res = spawnSync(
    'node',
    ['--env-file=' + envPath, scriptPath],
    { cwd: targetDir, stdio: 'inherit' },
  )
  if (res.status !== 0) {
    die(`Migrations failed (exit ${res.status}). Check the DB credentials + permissions and re-run.`)
  }
  log.ok('Migrations applied.')
}

// ════════════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════════════

function writeSystemdUnit({ targetDir, envPath, runUser }) {
  // Cavecms-app systemd unit. Written to /etc/systemd/system/ when
  // we have root, or printed to stdout for the operator to install
  // when we don't.
  //
  // The `Environment=` lines for CAVECMS_ENV_FILE + CAVECMS_REPO_DIR
  // are installer-pinned and override any matching key in env.production
  // (per systemd ordering: Environment= AFTER EnvironmentFile= wins).
  // The orchestrator defaults these to bare-metal deploy.sh paths
  // (/etc/cavecms/env.production, $(pwd)) which don't match CLI-install
  // layout; without the overrides the orchestrator's COMMIT-stamping
  // step silently skips and the new commit never reaches env.production.
  const unit = `[Unit]
Description=CaveCMS — self-hosted CMS
After=network.target mariadb.service mysql.service
Wants=network.target

[Service]
Type=simple
User=${runUser}
WorkingDirectory=${targetDir}
EnvironmentFile=${envPath}
# CAVECMS_ENV_FILE + CAVECMS_REPO_DIR: installer-pinned. Do not
# override via env.production — the unit-file value wins.
Environment=CAVECMS_ENV_FILE=${envPath}
Environment=CAVECMS_REPO_DIR=${targetDir}
ExecStart=/usr/bin/env node ${join(targetDir, 'scripts', 'start-standalone.mjs')}
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/cavecms/out.log
StandardError=append:/var/log/cavecms/err.log
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${targetDir} /var/log/cavecms /opt/cavecms/uploads
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
`
  return unit
}

function startForeground({ targetDir, envPath }) {
  const startScript = join(targetDir, 'scripts', 'start-standalone.mjs')
  log.info(`Starting CaveCMS in the foreground (PORT from env.production).`)
  log.gray(`Press Ctrl+C to stop. To run detached, use systemd / pm2 (see below).`)
  console.log('')
  const child = spawn('node', ['--env-file=' + envPath, startScript], {
    cwd: targetDir,
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

/**
 * Slug a free-form site name into a PM2-app-name-safe token.
 * PM2 accepts a generous character set in app names but anything with
 * shell-meta or whitespace is a footgun (the operator will eventually
 * type the name into a pm2 CLI command), so we narrow to
 * [a-z0-9-]+ — same shape as nginx server_name parts.
 */
function pm2AppNameFor(siteName) {
  // Treat null / undefined / empty-string / whitespace-only siteName
  // the same way — without this, `pm2AppNameFor('')` yielded
  // 'cavecms-site' while `pm2AppNameFor(undefined)` yielded
  // 'cavecms-cavecms' (the ?? branch fell to a different default).
  const trimmed = (siteName ?? '').toString().trim()
  const raw = (trimmed || 'cavecms').toLowerCase()
  // Truncate FIRST then trim the dashes — otherwise a name ending in
  // a dash run that straddles char 40 leaves a trailing dash on the
  // final slug ('aaa-bbb-...-' instead of 'aaa-bbb-...').
  const slug = raw.replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '')
  return `cavecms-${slug || 'site'}`
}

/**
 * Provision the host-shared state every CaveCMS install needs:
 *
 *   - cavecmsstate system group (owns lock + marker files in
 *     /var/lib/cavecms, READ access for state-aware services)
 *   - /var/log/cavecms — log dir, owned by runUser:runUser 750
 *   - /var/lib/cavecms — root:cavecmsstate 2770 (setgid so inherited
 *     state files belong to cavecmsstate, not the writer's primary
 *     group)
 *   - /var/lib/cavecms/snapshots — same posture, used by the in-app
 *     updater's snapshot/rollback path (lib/cms/updateOrchestrator)
 *   - /etc/logrotate.d/cavecms — pulled from the release's
 *     deploy/logrotate.d/cavecms; rotates the update + watchdog logs
 *     so a weekly-updating install doesn't grow /var/log by ~50MB/yr
 *
 * The runtime user is added to cavecmsstate so the orchestrator can
 * write the lock/marker files under /var/lib/cavecms. The group
 * membership takes effect on the NEXT spawn (PM2 / systemd start);
 * an already-running pm2 daemon would need a fresh start to pick up
 * the supplementary group — that's fine here because we only call
 * this BEFORE first start.
 *
 * Idempotent — safe to re-run on an already-provisioned host. Used
 * by both startVps (cavecms user) and startPm2 (www-data user) so
 * the snapshot/rollback machinery from cycle-3 lands on every
 * surface that has systemd-backed durable storage.
 */
function provisionSystemDirs({ runUser, targetDir }) {
  // Group: create if missing. `getent` exits 0 iff the group exists.
  const groupExists = spawnSync('getent', ['group', 'cavecmsstate'], { stdio: 'ignore' }).status === 0
  if (!groupExists) {
    runSudoOrDie(['groupadd', '--system', 'cavecmsstate'], 'Create cavecmsstate group')
  }
  // Add the runtime user to cavecmsstate. `usermod -aG` is idempotent
  // (a no-op when the user is already a member), so re-running this
  // on an already-provisioned host is cheap.
  //
  // Shared-host trade-off: on a multi-tenant box where runUser is
  // www-data (the PM2 surface's canonical user), adding www-data to
  // cavecmsstate widens its group set across EVERY www-data process
  // on the host — sibling apps now have group r/w/x on
  // /var/lib/cavecms (mode 2770). We accept this because the
  // alternative (a dedicated per-install runtime user) breaks the
  // shared-PM2-daemon model the surface is built around. Operators
  // on hosts that mix CaveCMS with untrusted www-data tenants should
  // use the VPS surface (dedicated cavecms user) instead.
  if (runUser) {
    runSudoOrDie(['usermod', '-aG', 'cavecmsstate', runUser], `Add ${runUser} to cavecmsstate group`)
  }

  // /var/log/cavecms — log dir. 750 with owner=runUser so the orchestrator,
  // watchdog, and snapshot scripts (which run as the same user) can
  // append. Logrotate's `create 0640 root root` runs as root so it
  // can always create rotated successors.
  //
  // RE-CHOWN on every call (not just on first creation) — `install -d`
  // is a no-op for an existing dir's ownership, so a failed-then-retried
  // install with a CHANGED runUser would leave the log dir owned by
  // the FIRST attempt's runUser. The orchestrator + watchdog running as
  // the second runUser would then 403 on log writes. Explicit chown
  // makes failed-retry truly idempotent.
  //
  // KNOWN LIMITATION: multi-install-per-host with DIFFERENT runUsers
  // (e.g. one VPS surface install as `cavecms`, plus a PM2 surface
  // install as `www-data` on the same box) is NOT supported — the
  // second install's chown breaks the first install's log writes.
  // Operators on such a host should pick a single surface OR manually
  // re-shape /var/log/cavecms to root:cavecmsstate 2770 (matches the
  // /var/lib/cavecms model so any cavecmsstate member can write).
  const logOwner = runUser || 'root'
  runSudoOrDie(
    ['install', '-d', '-o', logOwner, '-g', logOwner, '-m', '750', '/var/log/cavecms'],
    'Provision /var/log/cavecms',
  )
  if (runUser) {
    runSudoOrDie(['chown', `${logOwner}:${logOwner}`, '/var/log/cavecms'], 'Re-chown /var/log/cavecms')
  }

  // /var/lib/cavecms + snapshots — root:cavecmsstate 2770. The setgid
  // bit makes every child file inherit group=cavecmsstate, regardless
  // of which user's umask wrote it. Without setgid, db-backup writes
  // as runUser:runUser (its primary), restore-drill as root:root, and
  // cross-process reads break. See setup.sh §2 for the full
  // rationale.
  //
  // CRITICAL: these dirs are the snapshot/rollback substrate. If
  // `install -d` silently no-op-fails (read-only mount, AppArmor
  // deny, parent dir missing) the install proceeds with a working
  // app whose FIRST in-app update silently fails to snapshot —
  // operator only finds out when they need rollback. Fail loud.
  runSudoOrDie(
    ['install', '-d', '-o', 'root', '-g', 'cavecmsstate', '-m', '2770', '/var/lib/cavecms'],
    'Provision /var/lib/cavecms',
  )
  runSudoOrDie(
    ['install', '-d', '-o', 'root', '-g', 'cavecmsstate', '-m', '2770', '/var/lib/cavecms/snapshots'],
    'Provision /var/lib/cavecms/snapshots',
  )

  // /etc/logrotate.d/cavecms — install only if the release shipped
  // the config AND we haven't already installed it. We don't
  // overwrite a pre-existing file at /etc/logrotate.d/cavecms because
  // the operator may have hand-tuned it (different rotate count,
  // additional log paths from a fork, etc.).
  const logrotateSrc = join(targetDir, 'deploy', 'logrotate.d', 'cavecms')
  const logrotateDest = '/etc/logrotate.d/cavecms'
  if (existsSync(logrotateSrc) && !existsSync(logrotateDest)) {
    runSudoOrDie(
      ['install', '-m', '0644', '-o', 'root', '-g', 'root', logrotateSrc, logrotateDest],
      'Install /etc/logrotate.d/cavecms',
    )
  }
}

function startVps({ targetDir, envPath, config }) {
  log.info('VPS surface: writing systemd unit to /etc/systemd/system/cavecms.service')
  const runUser = process.env.SUDO_USER || 'cavecms'
  const unitText = writeSystemdUnit({
    targetDir,
    envPath,
    runUser,
  })
  // Need sudo to write to /etc/systemd/system/. The CLI prints the
  // unit + a one-liner; doing the actual write requires escalated
  // privileges. We try sudo non-interactively; fall back to printing.
  const tmpUnit = join(targetDir, 'cavecms.service')
  writeFileSync(tmpUnit, unitText)
  const sudoOk = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0
  if (sudoOk) {
    // Ensure the runtime user exists before systemd tries to su to it.
    // On a fresh Ubuntu VPS the default `cavecms` user doesn't exist;
    // without this the unit's User= would fail with "no such process".
    if (runUser === 'cavecms') {
      const userCheck = spawnSync('id', ['cavecms'], { stdio: 'ignore' })
      if (userCheck.status !== 0) {
        log.info('Creating cavecms system user…')
        runSudoOrDie(
          ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'cavecms'],
          'Create cavecms system user',
        )
      }
    }
    // env.production is mode 600 — chown to the runtime user so the
    // unit can actually read it. Without this the service crashes at
    // boot with EACCES env.production.
    runSudoOrDie(['chown', `${runUser}:${runUser}`, envPath], `chown env.production → ${runUser}`)
    // Same for the install dir + uploads — the runtime user must
    // own everything it reads/writes at runtime. The recursive chown
    // can take >30s on a slow disk / NFS-backed /var/www / first-boot
    // IOPS-throttled droplet with a large node_modules tree; use a
    // higher bound + explicit status check (same shape as the
    // systemctl enable call below).
    const chownRes = runSudo(
      ['chown', '-R', `${runUser}:${runUser}`, targetDir],
      { timeout: 120000 },
    )
    if (chownRes.status !== 0) {
      // Mirror runSudoOrDie's error-branch ordering.
      if (chownRes.error) {
        throw new Error(`chown -R install dir → ${runUser} failed to spawn sudo: ${chownRes.error.message}`)
      }
      if (chownRes.signal) {
        throw new Error(`chown -R install dir → ${runUser} timed out (signal ${chownRes.signal}) after 120s. Slow disk?`)
      }
      throw new Error(`chown -R install dir → ${runUser} failed (exit ${chownRes.status ?? 'unknown'}).`)
    }
    runSudoOrDie(['mv', tmpUnit, '/etc/systemd/system/cavecms.service'], 'Install cavecms.service')
    // Provision the shared host state (cavecmsstate group, /var/log/cavecms,
    // /var/lib/cavecms[/snapshots], /etc/logrotate.d/cavecms). Idempotent.
    // Used to be inline-chown of /var/log/cavecms only; the helper now
    // also lays down the snapshot root + logrotate config so the
    // in-app updater's snapshot/rollback path lands on VPS too.
    provisionSystemDirs({ runUser, targetDir })
    runSudoOrDie(['systemctl', 'daemon-reload'], 'systemctl daemon-reload')
    // systemctl enable --now can take longer than the default 30s on
    // hosts where mariadb.service starts slowly (it's an After= dep);
    // bump the bound for this one call.
    const enableRes = runSudo(
      ['systemctl', 'enable', '--now', 'cavecms.service'],
      { timeout: 90000 },
    )
    if (enableRes.status !== 0) {
      // Mirror runSudoOrDie's three-branch ordering so error messages
      // stay consistent across the codebase (spawn-failed vs timeout
      // vs non-zero exit). In practice unreachable here because the
      // preceding daemon-reload would have hit the same ENOENT first;
      // kept for grep-symmetry with runSudoOrDie.
      if (enableRes.error) {
        throw new Error(`systemctl enable --now failed to spawn sudo: ${enableRes.error.message}`)
      }
      if (enableRes.signal) {
        throw new Error(`systemctl enable --now cavecms.service timed out (signal ${enableRes.signal}). The unit may have a slow dependency; check 'systemctl status cavecms.service'.`)
      }
      throw new Error(`systemctl enable --now cavecms.service failed (exit ${enableRes.status ?? 'unknown'}).`)
    }
    log.ok('cavecms.service installed + started.')
  } else {
    log.warn('Sudo unavailable non-interactively. Manual step required:')
    log.gray(`  sudo mv ${tmpUnit} /etc/systemd/system/cavecms.service`)
    log.gray(`  sudo mkdir -p /var/log/cavecms`)
    log.gray(`  sudo systemctl daemon-reload`)
    log.gray(`  sudo systemctl enable --now cavecms.service`)
  }
  // Web-server detection: Apache or nginx?
  // Apache signals (any one match):
  //   /etc/apache2/sites-available/  (Debian / Ubuntu)
  //   /etc/httpd/conf.d/             (RHEL / Fedora / CentOS / Amazon Linux)
  //   `command -v httpd` or `command -v apache2`
  // nginx signals:
  //   /etc/nginx/  + `command -v nginx`
  //
  // Prefer Apache when BOTH are present and Apache is actively running
  // (some cPanel installs have nginx for static behind Apache).
  function detectWebServer() {
    const apacheActive =
      existsSync('/etc/apache2/sites-available') ||
      existsSync('/etc/httpd/conf.d') ||
      spawnSync('command', ['-v', 'apache2'], { shell: '/bin/bash', stdio: 'ignore' }).status === 0 ||
      spawnSync('command', ['-v', 'httpd'], { shell: '/bin/bash', stdio: 'ignore' }).status === 0
    const nginxActive =
      existsSync('/etc/nginx') &&
      spawnSync('command', ['-v', 'nginx'], { shell: '/bin/bash', stdio: 'ignore' }).status === 0
    if (apacheActive && !nginxActive) return 'apache'
    if (nginxActive && !apacheActive) return 'nginx'
    if (apacheActive && nginxActive) {
      // Both present — pick whichever is actively running.
      const apacheRunning =
        spawnSync('systemctl', ['is-active', '--quiet', 'apache2'], { stdio: 'ignore' }).status === 0 ||
        spawnSync('systemctl', ['is-active', '--quiet', 'httpd'], { stdio: 'ignore' }).status === 0
      return apacheRunning ? 'apache' : 'nginx'
    }
    return null
  }
  const webServer = detectWebServer()
  if (webServer === 'apache') {
    log.info('Apache + Let\'s Encrypt:')
    log.gray(`  An Apache vhost template is at ${join(targetDir, 'scripts', 'apache', 'cavecms.conf.template')}`)
    log.gray(`  Run: sudo bash ${join(targetDir, 'scripts', 'install-apache.sh')} <APEX> <LOGIN_PATH>`)
  } else if (webServer === 'nginx') {
    log.info('nginx + Let\'s Encrypt:')
    log.gray(`  An nginx vhost template is at ${join(targetDir, 'scripts', 'nginx', 'cavecms.conf.template')}`)
    log.gray(`  Run scripts/install-nginx.sh for an automated setup.`)
  } else {
    log.warn('Neither Apache nor nginx detected. CaveCMS needs a reverse proxy in front of port 3040.')
    log.gray(`  nginx:  apt install nginx  → then run scripts/install-nginx.sh`)
    log.gray(`  Apache: apt install apache2 → then run scripts/install-apache.sh`)
  }
}

/**
 * Build the per-install PM2 ecosystem config (CommonJS — PM2 reads
 * it via require()). One app entry, named cavecms-<slug>, started
 * via `node --env-file=env.production scripts/start-standalone.mjs`
 * so it inherits the same env shape as the laptop + VPS flows.
 *
 * Log files land in /var/log/cavecms (provisioned by
 * provisionSystemDirs) with the slug prefixing the filename — so a
 * single shared host running multiple CaveCMS installs keeps its
 * logs cleanly separated.
 *
 * max_memory_restart and the V8 heap cap mirror ecosystem.config.cjs
 * at the repo root (which is the production-droplet config). They're
 * conservative for a 1 GB box; an operator on a beefier host can
 * `pm2 restart <name> --update-env --max-memory 2048M` post-install.
 */
function buildPm2EcosystemConfig({ pm2AppName, slug, targetDir, envPath, pm2Home }) {
  // CAVECMS_ENV_FILE: the orchestrator reads this to know which env
  // file to stamp the post-update CAVECMS_COMMIT / CAVECMS_RELEASE_TS
  // into. Without it, the default is /etc/cavecms/env.production which
  // doesn't exist on a CLI install — the new commit would never land.
  //
  // CAVECMS_PM2_APP_NAME: the orchestrator + watchdog both reload pm2
  // by NAME instead of by `ecosystem.config.cjs` because the atomic
  // swap of an in-app update overwrites whatever in-tree config we
  // ship here with the new release's bundled legacy ecosystem.config.cjs
  // (which still points at /opt/cavecms paths and doesn't know about
  // this install). Reloading by name sidesteps that whole class of
  // bug. Same reason for PM2_HOME — non-default daemon needs an
  // explicit handle so the reload talks to the right daemon.
  //
  // CAVECMS_REPO_DIR: redundant with cwd above but the orchestrator
  // reads this env var directly (its $(pwd) default is the
  // Next.js standalone's cwd, not the install root), so pinning it
  // here saves a path-confusion bug if the standalone server.js
  // ever changes its working directory.
  return `// Generated by create-cavecms on ${new Date().toISOString()}.
// Per-install PM2 config — DO NOT edit by hand; re-run the installer
// to regenerate. Operator changes (memory cap, args, env additions)
// should go through 'pm2 restart <name> --update-env' so they don't
// vanish on the next reinstall.
module.exports = {
  apps: [{
    name: ${JSON.stringify(pm2AppName)},
    script: 'scripts/start-standalone.mjs',
    cwd: ${JSON.stringify(targetDir)},
    // Absolute --env-file path. Earlier this was relative
    // ('env.production') which relied on PM2 honouring 'cwd' — true
    // today but Next.js standalone has shipped two breaking changes
    // to cwd resolution in 14.x→15.x. An absolute path is one less
    // foot-gun to track across upstream churn.
    node_args: ${JSON.stringify(`--env-file=${envPath} --max-old-space-size=768`)},
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      CAVECMS_ENV_FILE: ${JSON.stringify(envPath)},
      CAVECMS_PM2_APP_NAME: ${JSON.stringify(pm2AppName)},
      CAVECMS_REPO_DIR: ${JSON.stringify(targetDir)},
      PM2_HOME: ${JSON.stringify(pm2Home)},
    },
    max_memory_restart: '1280M',
    kill_timeout: 8000,
    listen_timeout: 8000,
    wait_ready: false,
    max_restarts: 10,
    min_uptime: 60000,
    out_file: ${JSON.stringify(`/var/log/cavecms/${slug}-out.log`)},
    error_file: ${JSON.stringify(`/var/log/cavecms/${slug}-err.log`)},
    merge_logs: true,
    time: true,
  }],
}
`
}

function startPm2({ targetDir, envPath, config, siteName }) {
  // Resolve the canonical PM2 runtime user + PM2_HOME. Env-var overrides
  // exist for non-Debian shared hosts where the web user is e.g.
  // `nginx` and PM2_HOME has been parked under /var/lib/pm2 by the
  // operator's own convention.
  const runUser = process.env.CAVECMS_PM2_USER ?? 'www-data'
  const pm2Home = process.env.CAVECMS_PM2_HOME ?? '/var/www/.pm2'
  const pm2AppName = pm2AppNameFor(siteName)
  // The slug for log filenames mirrors the pm2 app name with the
  // 'cavecms-' prefix stripped so /var/log/cavecms doesn't have every
  // file double-prefixed.
  const slug = pm2AppName.replace(/^cavecms-/, '')

  log.info(`PM2 surface: app="${pm2AppName}" user=${runUser} PM2_HOME=${pm2Home}`)

  const sudoOk = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0
  if (!sudoOk) {
    die(
      'Sudo is required (and was unavailable non-interactively) to:\n' +
        `  - chown the install dir to ${runUser}\n` +
        `  - register the PM2 app with the ${runUser} daemon\n` +
        `  - provision /var/log/cavecms + /var/lib/cavecms\n` +
        '  Re-run as root or with passwordless sudo.',
    )
  }

  // Detect whether the runtime user's PM2 daemon is ALREADY running
  // before this install. Matters because `usermod -aG cavecmsstate
  // www-data` (done in provisionSystemDirs below) only takes effect
  // for processes started AFTER the group change. An existing daemon
  // — which `pm2 start` will send an RPC to instead of spawning — was
  // launched long before cavecmsstate existed, so the new
  // CaveCMS app it spawns inherits the daemon's OLD supplementary
  // groups (no cavecmsstate). The orchestrator running inside that
  // app then can't write to /var/lib/cavecms/snapshots (mode 2770
  // root:cavecmsstate) → snapshot fails → in-app updates can't
  // roll back.
  //
  // We can't auto-restart the daemon because that would briefly
  // restart EVERY pm2 app the runtime user manages — a shared
  // portfolio host may have 15+ unrelated apps. The operator decides
  // when. We just surface a clear, prominent warning + exact command.
  //
  // Probe MUST be side-effect-free: `pm2 ping` starts the daemon if
  // it's not running (so it'd always succeed). Instead, read the
  // daemon's PID file directly via sudo (needed because PM2_HOME is
  // owned by runUser and may not be world-readable). The .pid file
  // exists iff a daemon was started + holds the PID of the current
  // daemon process. If the file exists AND that PID is alive, we
  // have a preexisting daemon.
  const pidProbe = spawnSync(
    'sudo',
    ['-n', 'cat', join(pm2Home, 'pm2.pid')],
    { encoding: 'utf8', timeout: 5000 },
  )
  let pm2DaemonPreexisted = false
  if (pidProbe.status === 0 && typeof pidProbe.stdout === 'string') {
    const pid = pidProbe.stdout.trim()
    if (/^\d+$/.test(pid)) {
      // ps -p <pid> exits 0 if the PID exists. -o user= so we can
      // also confirm it's running as runUser (defensive against a
      // PID-recycle race where pm2.pid points to a now-different
      // process).
      const psProbe = spawnSync('ps', ['-p', pid, '-o', 'user='], { encoding: 'utf8' })
      if (psProbe.status === 0 && (psProbe.stdout ?? '').trim() === runUser) {
        pm2DaemonPreexisted = true
      }
    }
  }

  // Verify the PM2 binary path before we shell out to sudo. `command
  // -v pm2` runs as the current user; we resolve to its absolute path
  // because `sudo -u www-data pm2 …` won't necessarily inherit the
  // invoker's PATH (sudo's secure_path can strip /usr/local/bin where
  // pm2 typically lives on Debian).
  const pm2Bin = (() => {
    const r = spawnSync('command', ['-v', 'pm2'], { shell: '/bin/bash', encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : 'pm2'
  })()

  // Provision system dirs FIRST — we need /var/log/cavecms to exist
  // (and to be writable by runUser) before pm2 start tries to open
  // out_file / error_file. Order matters: log dir before chown +
  // app start. provisionSystemDirs is idempotent.
  provisionSystemDirs({ runUser, targetDir })

  // chown the install tree to the runtime user. env.production was
  // written mode 600 by the install pipeline; flipping owner is what
  // gets www-data permission to read it. Same posture as startVps.
  // Both calls MUST succeed — if env.production isn't readable by
  // runUser, pm2 start crashes seconds later with a confusing
  // EACCES traceback inside the standalone server; the real reason
  // was here, masked by spawnSync's silent error semantics.
  runSudoOrDie(['chown', `${runUser}:${runUser}`, envPath], `chown env.production → ${runUser}`)
  runSudoOrDie(['chown', '-R', `${runUser}:${runUser}`, targetDir], `chown -R install dir → ${runUser}`)

  // Write the per-install PM2 config alongside the env-file. Stays
  // in-tree so a subsequent `pm2 start ./pm2.config.cjs` is the same
  // file PM2 originally registered with — no drift between the
  // config-as-installed and the config-as-running.
  const pm2ConfigPath = join(targetDir, 'pm2.config.cjs')
  const pm2ConfigText = buildPm2EcosystemConfig({ pm2AppName, slug, targetDir, envPath, pm2Home })
  writeFileSync(pm2ConfigPath, pm2ConfigText, { mode: 0o644 })
  // chown to runUser so a subsequent `pm2 restart` invoked as
  // sudo -u runUser can re-read it.
  runSudoOrDie(['chown', `${runUser}:${runUser}`, pm2ConfigPath], `chown pm2.config.cjs → ${runUser}`)

  // pm2 start under the runtime user's daemon. --env=production
  // wires the apps[0].env onto the started process (PM2 honours
  // this flag for the env-block selection). Timeout 60s — pm2's
  // app spawn includes a first-listen probe; Next.js standalone
  // boot is ~5-15s, so 60s is comfortable headroom over a wedged
  // daemon.
  const startRes = spawnSync(
    'sudo',
    [
      '-n', '-u', runUser,
      'env', `PM2_HOME=${pm2Home}`,
      pm2Bin, 'start', pm2ConfigPath, '--env', 'production',
    ],
    { stdio: 'inherit', timeout: 60000 },
  )
  if (startRes.status !== 0) {
    if (startRes.signal) {
      die(`pm2 start timed out (signal ${startRes.signal}). The ${runUser} PM2 daemon may be wedged — check: sudo -u ${runUser} PM2_HOME=${pm2Home} pm2 status`)
    }
    die(`pm2 start failed (exit ${startRes.status}). See output above.`)
  }

  // pm2 save — flushes the resurrect file. Without this, the app
  // starts cleanly now but disappears on the next reboot. We rely
  // on the host's existing pm2 startup unit (typically pm2-www-data
  // or pm2-cavecms) being installed already, which the shared-host
  // convention guarantees.
  const saveRes = spawnSync(
    'sudo',
    ['-n', '-u', runUser, 'env', `PM2_HOME=${pm2Home}`, pm2Bin, 'save'],
    { stdio: 'inherit', timeout: 10000 },
  )
  if (saveRes.status !== 0) {
    log.warn(`pm2 save returned ${saveRes.status ?? `signal ${saveRes.signal}`}. The app is running now, but won't auto-resurrect on reboot until you run: sudo -u ${runUser} PM2_HOME=${pm2Home} pm2 save`)
  }

  log.ok(`PM2 app "${pm2AppName}" started + saved.`)

  // Surface the daemon-group-lag warning if applicable. Phrased
  // around what the operator should DO (one-line command) rather
  // than what's technically wrong (kernel supplementary-groups
  // inheritance) — see #0.036 (in-app messages must be user-friendly).
  if (pm2DaemonPreexisted) {
    console.log('')
    log.warn(`Your ${runUser} PM2 daemon was already running before this install.`)
    log.gray(`  In-app updates depend on a group membership change that only takes effect`)
    log.gray(`  when the daemon next restarts. Until you restart it, in-app updates can`)
    log.gray(`  still apply releases but can't take or restore snapshots.`)
    log.gray(`  Restart at a maintenance window (briefly restarts all ${runUser} PM2 apps):`)
    log.gray(`    sudo -u ${runUser} PM2_HOME=${pm2Home} pm2 update`)
    console.log('')
  }

  // Print the nginx vhost block for the operator to drop into the
  // host's existing vhost file. We deliberately do NOT auto-write
  // the vhost — shared hosts park their vhosts in different shapes
  // (one file per site under /etc/nginx/sites-available, OR a single
  // big custom-sites.conf in /etc/nginx/conf.d/, OR Apache's
  // sites-available) and the operator already has a working
  // convention we shouldn't second-guess.
  printPm2NginxGuidance({ siteUrl: config.siteUrl, port: config.port, slug, runUser, pm2Home })
}

/**
 * Emit a fully-rendered nginx server-block the operator can paste
 * verbatim into their vhost file. Mirrors the CaveCMS reference
 * vhost (security + nextjs-security snippets + an upstream proxy
 * to 127.0.0.1:PORT) but doesn't depend on snippets the shared host
 * may not have — falls back to inline headers when those snippets
 * are absent.
 */
function printPm2NginxGuidance({ siteUrl, port, slug, runUser, pm2Home }) {
  // Refuse to emit nginx guidance when siteUrl is missing or
  // unparseable. Otherwise we'd print `server_name ;` (empty token),
  // which `nginx -t` rejects — operator pastes, gets a confusing
  // nginx-level error, doesn't know the CLI generated it. Surface
  // here, in the operator's terminal, where the diagnosis is local.
  if (!siteUrl) {
    log.warn('No siteUrl in this install — nginx vhost block was NOT emitted.')
    log.gray('  Set CAVECMS_SITE_URL (env var) or re-run interactively and re-render later.')
    return
  }
  let parsed
  try {
    parsed = new URL(siteUrl)
  } catch {
    log.warn(`siteUrl "${siteUrl}" is not a parseable URL — nginx vhost block was NOT emitted.`)
    log.gray('  Re-run with a valid https://… URL and capture the printed block then.')
    return
  }
  // .hostname (not .host) — strips any :port suffix. nginx
  // server_name doesn't allow port suffixes; pasting host:port would
  // produce `server_name example.com:8080;` which nginx rejects.
  const host = parsed.hostname
  if (!host) {
    log.warn(`Couldn't extract a hostname from "${siteUrl}" — nginx vhost block was NOT emitted.`)
    return
  }
  const hasSecuritySnippet = existsSync('/etc/nginx/snippets/security.conf')
  const hasNextjsSnippet = existsSync('/etc/nginx/snippets/nextjs-security.conf')
  // Derive the apex domain for the wildcard cert lookup. Strategy
  // (in priority order):
  //   1. If a cert exists at the exact host (e.g. operator placed a
  //      single-domain cert at <host>.pem), use that.
  //   2. Otherwise, strip the leftmost label and check there
  //      (test.derricksiawor.com → derricksiawor.com).
  //   3. Fall through to the placeholder (existsSync below).
  //
  // This handles BOTH the apex case (example.com → example.com.pem
  // when it's the apex) AND the common subdomain case. It also
  // shrugs off the 2-label ccTLD case (example.co.uk → strip to
  // co.uk which won't have a cert, falls to placeholder — operator
  // edits the path). Earlier 'strip first label always' broke the
  // apex (example.com → com).
  const hostCertPath = `/etc/ssl/cloudflare/${host}.pem`
  const strippedHost = host.replace(/^[^.]+\./, '')
  const apexCertPath = `/etc/ssl/cloudflare/${strippedHost}.pem`
  let certPath
  let keyPath
  if (existsSync(hostCertPath)) {
    certPath = hostCertPath
    keyPath = `/etc/ssl/cloudflare/${host}.key`
  } else if (strippedHost !== host && existsSync(apexCertPath)) {
    certPath = apexCertPath
    keyPath = `/etc/ssl/cloudflare/${strippedHost}.key`
  } else {
    certPath = '/path/to/fullchain.pem'
    keyPath = '/path/to/privkey.key'
  }
  const certHint = `  ssl_certificate ${certPath};\n  ssl_certificate_key ${keyPath};`

  console.log('')
  log.info('Add an nginx server block for the new install:')
  console.log('')
  console.log(c('gray', `  # /etc/nginx/conf.d/custom-sites.conf  (append at end)`))
  console.log('')
  console.log(`server {`)
  console.log(`  listen 80;`)
  console.log(`  server_name ${host};`)
  console.log(`  return 301 https://$host$request_uri;`)
  console.log(`}`)
  console.log('')
  console.log(`server {`)
  console.log(`  listen 443 ssl http2;`)
  console.log(`  server_name ${host};`)
  console.log('')
  console.log(certHint)
  console.log('')
  if (hasSecuritySnippet) console.log(`  include /etc/nginx/snippets/security.conf;`)
  if (hasNextjsSnippet) console.log(`  include /etc/nginx/snippets/nextjs-security.conf;`)
  console.log('')
  console.log(`  client_max_body_size 25M;  # uploads`)
  console.log('')
  console.log(`  location / {`)
  console.log(`    proxy_pass http://127.0.0.1:${port};`)
  console.log(`    proxy_http_version 1.1;`)
  console.log(`    proxy_set_header Upgrade $http_upgrade;`)
  console.log(`    proxy_set_header Connection 'upgrade';`)
  console.log(`    proxy_set_header Host $host;`)
  console.log(`    proxy_set_header X-Real-IP $remote_addr;`)
  console.log(`    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`)
  console.log(`    proxy_set_header X-Forwarded-Proto $scheme;`)
  console.log(`    proxy_cache_bypass $http_upgrade;`)
  console.log(`  }`)
  console.log(`}`)
  console.log('')
  log.gray(`Then:  sudo nginx -t && sudo systemctl reload nginx`)
  log.gray(`Logs:  sudo tail -f /var/log/cavecms/${slug}-out.log`)
  log.gray(`PM2:   sudo -u ${runUser} PM2_HOME=${pm2Home} pm2 status`)
}

function startCpanel({ targetDir, envPath }) {
  // cPanel uses Passenger via the "Setup Node.js App" interface. The
  // operator points it at the install dir + an app.js entry. We write
  // an app.js shim that the standalone server.js can be invoked through.
  log.info('cPanel surface: writing app.js Passenger shim.')
  // Inline env-file parser — `node:dotenv` does NOT exist (the real
  // module is the third-party `dotenv` package which isn't bundled).
  // cPanel's Passenger doesn't accept --env-file flags, so we parse
  // env.production into process.env ourselves before requiring the
  // standalone server.
  const shim = `// CaveCMS Passenger shim — cPanel "Setup Node.js App" invokes this.
// Reads env.production at boot and execs the standalone server.
const fs = require('node:fs')
const path = require('node:path')
const envPath = path.join(__dirname, 'env.production')
try {
  const text = fs.readFileSync(envPath, 'utf8')
  for (const raw of text.split(/\\r?\\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
} catch (err) {
  console.error('[cavecms] failed to read env.production:', err && err.message)
  process.exit(1)
}
require('./.next/standalone/server.js')
`
  writeFileSync(join(targetDir, 'app.js'), shim)
  log.ok('Wrote app.js for Passenger.')
  console.log('')
  log.info('Next steps (do these in cPanel):')
  log.gray('  1. Open cPanel → "Setup Node.js App" → "Create Application"')
  log.gray(`  2. Application Root:  ${targetDir.replace(homedir(), '~')}`)
  log.gray(`  3. Application URL:   (your domain — cPanel maps this for you)`)
  log.gray('  4. Application Startup File: app.js')
  log.gray('  5. Click "Run NPM Install" — NOT NEEDED, dependencies are bundled')
  log.gray('  6. Click "Start App"')
  log.gray('  7. Open <your-domain>/install to finish setup in the browser.')
}

function startLaptop({ targetDir, envPath, config }) {
  log.info('Laptop surface: starting CaveCMS in the foreground.')
  log.gray(`  URL: ${config.siteUrl}`)
  log.gray(`  To run detached later: nohup node --env-file=env.production scripts/start-standalone.mjs > app.log 2>&1 &`)
  console.log('')
  startForeground({ targetDir, envPath })
}

function startService({ surface, targetDir, envPath, config, skipStart, siteName }) {
  if (skipStart) {
    log.warn('Skipping service start (--skip-start). Start manually:')
    log.gray(`  node --env-file=env.production scripts/start-standalone.mjs`)
    return
  }
  if (surface === 'vps') return startVps({ targetDir, envPath, config })
  if (surface === 'pm2') return startPm2({ targetDir, envPath, config, siteName })
  if (surface === 'cpanel') return startCpanel({ targetDir, envPath })
  return startLaptop({ targetDir, envPath, config })
}

// ════════════════════════════════════════════════════════════════════
// Main pipeline
// ════════════════════════════════════════════════════════════════════

async function main(argv) {
  const args = parseArgv(argv)
  if (args.help) {
    showHelp()
    return
  }

  log.header('CaveCMS installer')

  preflightPlatform()
  preflightNodeVersion()
  preflightDeps()

  // 1. Surface detect.
  const surface = args.surface === 'auto' ? detectSurface() : args.surface
  if (!['vps', 'pm2', 'laptop', 'cpanel'].includes(surface)) {
    die(`Unknown surface: ${args.surface}`)
  }
  log.info(`Surface: ${c('bold', surface)}`)

  // 2. Site name + target dir.
  if (!args.siteName && !args.targetDir) {
    if (args.yes) die('Site name (or --dir) is required in non-interactive mode.')
    args.siteName = await withReadline(async (rl) =>
      ask(rl, 'Site name', {
        defaultValue: 'my-site',
        validate: (v) =>
          SITE_NAME_RE.test(v)
            ? null
            : 'Lowercase letters, digits, dashes. 2-41 chars. Must start with a letter or digit.',
      }),
    )
  }
  // Validate positional siteName (which skipped the interactive prompt's
  // validator). Without this, `npx create-cavecms ../../etc/foo` resolves
  // a traversed targetDir + the subsequent `sudo chown -R runUser` flips
  // ownership of a path the operator didn't intend. The interactive
  // prompt already enforced this regex; we apply it uniformly now.
  if (args.siteName && !SITE_NAME_RE.test(args.siteName)) {
    die(
      `Invalid site name "${args.siteName}". ` +
        `Must match ${SITE_NAME_RE.source} — lowercase letters, digits, and dashes ` +
        `only; 2-41 chars; first char a letter or digit.`,
    )
  }
  const targetDir = args.targetDir
    ? resolve(args.targetDir)
    : defaultInstallDir(surface, args.siteName)

  console.log(c('gray', 'Target:   ') + targetDir)
  console.log(c('gray', 'Release:  ') + (args.version === 'latest' ? `latest (${RELEASE_HOST})` : args.version))
  console.log('')

  log.step(1, 7, 'Pre-flight checks…')
  const createdTargetDir = preflightTargetDir(targetDir)
  // Port collision check runs early, BEFORE we download the zip — so a
  // misconfigured --port doesn't waste minutes on a download that
  // can't bind. The default 3040 from DEFAULT_PORT may already be in
  // use on a server with other Node apps.
  const portToProbe = args.port ?? Number(envOr('CAVECMS_PORT', String(DEFAULT_PORT)))
  preflightPort(portToProbe)
  // VPS-only safety: refuse to overwrite an existing cavecms.service
  // and refuse if the operator's chosen ServerName already appears in
  // an nginx / Apache vhost on this box.
  if (surface === 'vps') {
    preflightVpsCollisions({ targetDir, siteUrl: envOr('CAVECMS_SITE_URL', '') })
  }
  // PM2-only safety: refuse to re-register a pm2 app name that's
  // already running under the daemon, and refuse the nginx-vhost
  // collision (same scan as VPS, narrower set of dirs).
  if (surface === 'pm2') {
    preflightPm2Collisions({
      pm2AppName: pm2AppNameFor(args.siteName),
      siteUrl: envOr('CAVECMS_SITE_URL', ''),
      pm2User: process.env.CAVECMS_PM2_USER ?? 'www-data',
      pm2Home: process.env.CAVECMS_PM2_HOME ?? '/var/www/.pm2',
    })
  }
  log.ok('Pre-flight OK.')

  // Track which phase we're in so the catch handler can clean up
  // appropriately. Failures BEFORE writeSealedEnv can safely rm the
  // target dir (no install state yet); after that, we leave the dir
  // for the operator to inspect.
  let installPhase = 'pre-extract'
  try {
    log.step(2, 7, 'Download + verify…')
    const { zipPath, stagingDir, release } = await downloadAndVerify({
      targetDir,
      version: args.version,
      skipSignature: args.skipSignature,
    })

    log.step(3, 7, 'Unpacking…')
    unpackZip({ zipPath, targetDir, release, stagingDir })
    installPhase = 'post-unpack'

    log.step(4, 7, 'Gathering install config…')
    const config = await gatherConfig({ surface, siteName: args.siteName, port: args.port, yes: args.yes })

    log.step(5, 7, 'Generating secrets + writing sealed env.production…')
    const secrets = generateSecrets()
    const { envPath, uploadsRoot } = writeSealedEnv({
      targetDir,
      surface,
      config,
      secrets,
      release,
    })
    installPhase = 'env-written'
    log.ok(`Sealed env at ${envPath} (mode 600)`)
    log.gray(`Uploads dir: ${uploadsRoot}`)

    if (!args.skipMigrate) {
      log.step(6, 7, 'Running migrations…')
      runMigrations({ targetDir, envPath })
    } else {
      log.warn('Skipping migrations (--skip-migrate).')
    }

    log.step(7, 7, 'Starting service…')

    // Print the post-install banner BEFORE starting (foreground start
    // takes over stdio on laptop surface).
    const bar = '━'.repeat(63)
    console.log('')
    console.log(c('green', bar))
    console.log(c('green', c('bold', '       CaveCMS installed')))
    console.log(c('green', bar))
    console.log('')
    console.log(c('gray', 'Version:     ') + release.version)
    console.log(c('gray', 'Surface:     ') + surface)
    console.log(c('gray', 'Install dir: ') + targetDir)
    console.log(c('gray', 'Site URL:    ') + config.siteUrl)
    console.log(c('gray', 'Login path:  ') + c('bold', `/${secrets.LOGIN_PATH}`) + c('gray', '  (after wizard — write this down!)'))
    console.log('')
    console.log(c('cyan', 'Next:'))
    const installUrl = `${config.siteUrl}/install?t=${encodeURIComponent(secrets.INSTALL_BOOTSTRAP_TOKEN)}`
    console.log(c('gray', '  1. Open ') + c('bold', installUrl))
    console.log(c('gray', '  2. Walk the in-app wizard: admin account → site identity → branding → contact → SMTP → security → done'))
    console.log(c('gray', '  3. Sign in at ') + c('bold', `${config.siteUrl}/${secrets.LOGIN_PATH}`))
    console.log('')
    console.log(c('yellow', '  Note: ') + c('gray', 'the ?t=… token is a one-shot bootstrap secret. Do NOT share it.'))
    console.log(c('gray', '  Lost the URL? Run:  ') + c('bold', `grep INSTALL_BOOTSTRAP_TOKEN ${envPath}`))
    console.log('')

    startService({ surface, targetDir, envPath, config, skipStart: args.skipStart, siteName: args.siteName })
  } catch (err) {
    if (createdTargetDir && installPhase === 'pre-extract') {
      try {
        rmSync(targetDir, { recursive: true, force: true })
        log.info('Rolled back the empty target directory so you can retry.')
      } catch {
        /* best-effort cleanup */
      }
    } else if (installPhase === 'post-unpack' || installPhase === 'env-written') {
      log.warn('Install failed mid-flight. Recovery commands:')
      log.gray(`  rm -rf ${targetDir}`)
      // VPS surface may have placed a stale cavecms.service unit OR
      // started provisioning system dirs before the failure. The
      // catch can't reliably detect HOW FAR startVps got, so we
      // surface the unit-cleanup commands unconditionally — they're
      // safe no-ops on a host that doesn't have the file.
      if (surface === 'vps') {
        log.gray(`  sudo systemctl disable --now cavecms.service 2>/dev/null || true`)
        log.gray(`  sudo rm -f /etc/systemd/system/cavecms.service && sudo systemctl daemon-reload`)
      }
      // PM2 surface may have registered the pm2 app before the
      // failure (e.g. pm2 save failed). Same posture: emit the
      // delete command unconditionally; it's safe if no such app.
      if (surface === 'pm2') {
        const pm2User = process.env.CAVECMS_PM2_USER ?? 'www-data'
        const pm2Home = process.env.CAVECMS_PM2_HOME ?? '/var/www/.pm2'
        const pm2AppName = pm2AppNameFor(args.siteName)
        log.gray(`  sudo -u ${pm2User} PM2_HOME=${pm2Home} pm2 delete ${pm2AppName} 2>/dev/null || true`)
        log.gray(`  sudo -u ${pm2User} PM2_HOME=${pm2Home} pm2 save`)
      }
      log.gray(`  npx create-cavecms ${args.siteName ?? '<site-name>'}`)
    }
    throw err
  }
}

main(process.argv.slice(2)).catch((err) => {
  log.err(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
