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
//   3. Download cavecms-updates.derricksiawor.com/latest.zip (or pinned version)
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
// All third-party-network access is via cavecms-updates.derricksiawor.com.
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
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs'
import { randomBytes, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { homedir, platform, tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import * as nodeHttps from 'node:https'
import * as nodeHttp from 'node:http'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

const DEFAULT_RELEASE_HOST = 'https://cavecms-updates.derricksiawor.com'
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

// Full list of trusted public keys the CLI will verify a release zip
// against — it installs if ANY key verifies. TODAY this holds exactly
// one key, so behaviour is identical to a single-key anchor. The list
// shape lets a FUTURE key rotation bundle BOTH the old and the new key
// in one CLI release, so installs straddling the rotation window verify
// either signature. To rotate: add the new PEM as a second entry, bump
// the CLI, and follow the bridge procedure in lib/updates/releasePubkey.ts.
const BUNDLED_PUBKEYS_PEM = [BUNDLED_PUBKEY_PEM]

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

// Reject install paths carrying bytes that would break out of a
// double-quoted bash context. The `cavecms` shim interpolates the install
// path into a `cd "..."` line, so a path with $, backtick, backslash,
// quote, or a control char could inject commands into a persisted,
// PATH-exposed, often-sudo'd script. Mirrors the apply route's
// assertSafePathForShell (SHELL_DOUBLEQUOTE_DANGEROUS) + the double-quote
// char the shim's raw interpolation adds. Spaces / non-ASCII still pass so
// legit paths like `/srv/café/cavecms` keep working.
const SHELL_UNSAFE_PATH = /[$`\\'"\x00-\x1f]/
function assertSafeInstallPath(p) {
  if (SHELL_UNSAFE_PATH.test(p)) {
    die(`Unsafe install path (contains shell metacharacters): ${JSON.stringify(p)}`)
  }
}

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
    detectOnly: false,
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
    // Dry run: resolve + confirm the deployment surface, then exit
    // without downloading or installing. Diagnostic + local test hook.
    else if (a === '--detect-only' || a === '--check-surface') out.detectOnly = true
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
    '       npx create-cavecms <command> [options]   ' + c('gray', '(manage an existing install)'),
    '',
    c('bold', 'Commands (run from an install dir, or pass --dir):'),
    '  update [--check] [--force] [--version=X.Y.Z]   Update an existing install (latest, or a pinned release)',
    '                                     --check prints JSON (current vs latest), applies nothing',
    '                                     --force re-installs the current version (recover a broken build)',
    '                                     --version=X.Y.Z pins a specific release (re-install / downgrade)',
    '  rollback                           Restore the previous version from the most recent snapshot',
    '  backup [--include-env]             Back up content + media to a dated archive (--include-env adds secrets)',
    '  backups                            List local backups',
    '  restore --archive <file>           Restore content + media from a backup (rolls back on failure)',
    '                                     --identity <age-key> decrypts a .age archive; --restore-env restores env.production',
    '                                     --yes skips the confirmation prompt',
    '  status                             Show the running version + whether an update is available',
    '  version                            Print the installed version',
    '  login                              Save a site URL + API token; push/pull then default to it',
    '  logout                             Forget the saved site',
    '  whoami                             Show the saved site',
    '  pull                               Download the logged-in site\'s content into a bundle dir (--out)',
    '                                     (or --from <url> --token <tok> to override the saved site)',
    '  push --from <url>                  Publish your local content to the logged-in site (atomic, drift-gated)',
    '                                     --from <url> --from-token <tok> assembles from a source; or --bundle <dir>',
    '                                     --to <url> --token <tok> overrides the saved site',
    '                                     --dry-run validates against the target + writes nothing; --force overrides drift',
    '  help                               Show this message',
    c('gray', '  (these command names are reserved and cannot be used as a site name)'),
    '',
    c('bold', 'Install options:'),
    '  --surface=auto|vps|pm2|cpanel|laptop  Force a deployment surface (default: auto)',
    '  --detect-only                      Show which setup is detected, then exit (no install)',
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

  // Desktop / laptop signals (Linux only). A personal Linux machine
  // often looks exactly like a server to the systemd+sudo heuristic
  // below — a dev laptop with passwordless sudo would wrongly resolve
  // to `vps`. So BEFORE concluding vps, look for things only a
  // desktop/laptop has (a battery, a graphical session, an attached
  // seat). macOS never reaches here — it has no /run/systemd/system
  // and falls straight through to the laptop default.
  //
  // These signals are ADVISORY: they set the default the confirm
  // prompt shows, never an authoritative answer. A genuine headless
  // VPS has none of them and still resolves to vps just below.
  if (platform() === 'linux' && hasDesktopSignals()) return 'laptop'

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
 * Linux desktop/laptop signal probe. Returns true if ANY signal that a
 * personal machine has (and a headless server lacks) is present. Used
 * to keep a dev laptop with systemd + passwordless sudo from being
 * mistaken for a VPS. Advisory only — see detectSurface().
 */
function hasDesktopSignals() {
  // Battery — the strongest signal. Servers have no power-supply
  // battery; laptops expose /sys/class/power_supply/BAT0 (or BAT1).
  try {
    const psDir = '/sys/class/power_supply'
    if (existsSync(psDir) && readdirSync(psDir).some((n) => n.startsWith('BAT'))) {
      return true
    }
  } catch {
    // power_supply unreadable in this environment — fall through.
  }

  // Graphical session — these env vars are set inside a desktop login
  // and absent on a headless server's shell.
  if (
    process.env.WAYLAND_DISPLAY ||
    process.env.DISPLAY ||
    process.env.XDG_CURRENT_DESKTOP ||
    process.env.DESKTOP_SESSION
  ) {
    return true
  }

  // systemd's default boot target is graphical.target on a desktop
  // install, multi-user.target on a server.
  const def = spawnSync('systemctl', ['get-default'], { encoding: 'utf8' })
  if (def.status === 0 && /graphical\.target/.test(def.stdout || '')) {
    return true
  }

  // An attached seat that can drive a display (loginctl seat0). A
  // headless server either has no seat0 or reports CanGraphical=no.
  const seat = spawnSync('loginctl', ['show-seat', 'seat0'], { encoding: 'utf8' })
  if (seat.status === 0 && /CanGraphical=yes/.test(seat.stdout || '')) {
    return true
  }

  return false
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

// Friendly, jargon-free description of each surface for the confirm
// gate. Leads with WHAT THE MACHINE IS — the internal word "surface"
// never appears in operator-visible copy.
const SURFACE_DESCRIPTIONS = {
  laptop: 'Laptop / personal computer (runs CaveCMS as a normal app, no server manager)',
  vps: 'Server (Linux VPS with systemd — runs as a managed system service)',
  pm2: 'Shared Linux server (runs alongside other sites under PM2)',
  cpanel: 'cPanel hosting account',
}

/**
 * Interactive confirmation gate. Detection is a best guess, and a wrong
 * surface writes the wrong env knobs + restart mode — which silently
 * breaks in-app updates later. So on a real TTY we show the operator
 * what we detected, in plain language, and let them correct it BEFORE
 * any install work happens. Returns the confirmed (or re-picked) surface.
 */
async function confirmSurface(detected) {
  return withReadline(async (rl) => {
    console.log('')
    console.log(`${c('bold', 'Detected setup:')} ${SURFACE_DESCRIPTIONS[detected]}.`)
    console.log('')
    console.log(c('gray', '  • Press Enter / y  — yes, continue'))
    console.log(c('gray', '  • n                — choose a different setup'))
    console.log('')
    const ok = await confirm(
      rl,
      'CaveCMS will install it for this kind of machine. Is that right?',
      true,
    )
    if (ok) return detected

    // The operator says the guess is wrong — let them pick. Default the
    // picker to the detected option so a stray Enter doesn't change it.
    const order = ['laptop', 'vps', 'pm2', 'cpanel']
    console.log('')
    console.log('Which setup matches this machine?')
    console.log('  1) Laptop / personal computer')
    console.log('  2) Server (Linux VPS with systemd)')
    console.log('  3) Shared Linux host (PM2)')
    console.log('  4) cPanel hosting account')
    const choice = await ask(rl, 'Enter a number', {
      defaultValue: String(order.indexOf(detected) + 1),
      validate: (v) => (/^[1-4]$/.test(v.trim()) ? null : 'Enter 1, 2, 3, or 4.'),
    })
    return order[Number(choice.trim()) - 1]
  })
}

/**
 * Resolve the deployment surface, applying the precedence the operator
 * expects:
 *   - explicit --surface=  → used verbatim, no detection, no prompt
 *   - auto + interactive   → detect, then CONFIRM (correctable picker)
 *   - auto + non-TTY / -y  → detect, then log the choice loudly
 * Shared by main() and the `--detect-only` dry run so both see identical
 * behaviour. Returns the resolved surface string.
 */
async function resolveSurface(args) {
  if (args.surface !== 'auto') {
    // An explicit --surface= is a deliberate operator choice. Never
    // second-guess a deliberate flag with detection or a prompt.
    if (!['vps', 'pm2', 'laptop', 'cpanel'].includes(args.surface)) {
      die(`Unknown surface: ${args.surface}`)
    }
    return args.surface
  }

  const detected = detectSurface()
  // Interactive = a real TTY and the operator didn't pass -y.
  const interactive = Boolean(process.stdin.isTTY) && !args.yes
  if (interactive) {
    return confirmSurface(detected)
  }

  // Non-interactive (-y / piped / CI): never block on a prompt, but make
  // the auto-detected choice impossible to miss in the output so a
  // mismatch is caught on the first run — not after a broken in-app
  // update weeks later.
  console.log('')
  console.log(c('bold', `▶ Surface: ${detected} (auto-detected).`))
  console.log(
    c('gray', `  Override with --surface=<vps|pm2|cpanel|laptop> if that's wrong.`),
  )
  console.log('')
  if (!['vps', 'pm2', 'laptop', 'cpanel'].includes(detected)) {
    die(`Unknown surface: ${detected}`)
  }
  return detected
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
  // wget is the hard download dependency for BOTH install (zip) and update
  // (manifest + tarball) — release-host downloads go through wget because
  // Cloudflare Bot Fight Mode 403s curl/node-fetch. unzip extracts install
  // zips; curl is used by the orchestrator for the release probe + healthz.
  const required = ['wget', 'unzip', 'curl']
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
// `soft: true` makes failures THROW instead of die()ing (process.exit), so
// graceful-degradation callers (e.g. `cavecms status` when the host is
// offline) can catch + warn rather than hard-exit. Default stays hard-exit.
function fetchToFileViaWget(url, destPath, timeoutSec, { soft = false, tries = 3 } = {}) {
  const fail = (msg) => { if (soft) throw new Error(msg); die(msg) }
  const res = spawnSync(
    'wget',
    [
      '--quiet',
      `--timeout=${timeoutSec}`,
      `--tries=${tries}`,
      '--user-agent', RELEASE_FETCH_UA,
      '--header', `X-CaveCMS-Client: ${RELEASE_CLIENT_ID}`,
      '-O', destPath,
      url,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      // wget's --timeout is a per-stall, per-try cap; against a black-holed
      // host it can burn timeoutSec × tries. Add a Node wall-clock backstop
      // (a little over that budget) so an interactive `cavecms status` can't
      // block for minutes — a SIGKILL'd wget lands in the res.error branch
      // and fail()s cleanly. killSignal SIGKILL because wget ignores TERM mid-
      // connect on some platforms.
      timeout: (timeoutSec * tries + 10) * 1000,
      killSignal: 'SIGKILL',
    },
  )
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      fail(
        'wget is required to download the release but is not installed.\n' +
          '  Install it and re-run:  Debian/Ubuntu → sudo apt install wget   ·   RHEL/Alma → sudo yum install wget',
      )
    }
    fail(`wget couldn't run downloading ${url}: ${res.error.message}`)
  }
  if (res.status !== 0) {
    fail(
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

// Same-origin + HTTPS guard on a manifest entry's downloadUrl. A
// tampered manifest could point downloadUrl at attacker.com with a
// matching sha256 + a signature from a key the attacker controls. The
// in-app updater (lib/updates/checkLatestRelease.ts) enforces the same
// gate via CAVECMS_RELEASE_DOWNLOAD_ORIGINS — extracted here so the
// install path AND the `update`/`status` subcommands share one copy of
// this security-critical check (no drift between them).
function assertManifestTargetSafe(manifestUrl, downloadUrl, { soft = false } = {}) {
  const fail = (msg) => { if (soft) throw new Error(msg); die(msg) }
  try {
    const manifestOrigin = new URL(manifestUrl).origin
    const downloadOrigin = new URL(downloadUrl).origin
    if (downloadOrigin !== manifestOrigin) {
      const allowedRaw = process.env.CAVECMS_RELEASE_DOWNLOAD_ORIGINS
      const allowed = allowedRaw
        ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : []
      if (!allowed.includes(downloadOrigin)) {
        fail(
          `Manifest points downloadUrl at a different origin than the manifest itself.\n` +
            `  manifest: ${manifestOrigin}\n` +
            `  download: ${downloadOrigin}\n` +
            `  Refusing. If your fork legitimately splits manifest + zip across origins,\n` +
            `  set CAVECMS_RELEASE_DOWNLOAD_ORIGINS to the allowed list (comma-separated).`,
        )
      }
    }
    // Strict HTTPS, matching the dashboard apply route + checkLatestRelease.
    // The loopback-http exception is for local dev mirrors only, so gate it
    // behind CAVECMS_DEV_BUILD (same gate as the pubkey override / dry-run) —
    // production CLI runs enforce the exact same gate as the dashboard.
    const allowLoopbackHttp = process.env.CAVECMS_DEV_BUILD === '1' &&
      /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(downloadUrl)
    if (!/^https:\/\//i.test(downloadUrl) && !allowLoopbackHttp) {
      fail(`downloadUrl must be HTTPS (got: ${downloadUrl})`)
    }
  } catch (err) {
    // Re-throw our own deliberate failures; only wrap genuine URL-parse errors.
    if (err instanceof Error && (err.message.startsWith('Manifest points') || err.message.startsWith('downloadUrl must be HTTPS'))) throw err
    fail(`Invalid downloadUrl in manifest: ${downloadUrl}`)
  }
}

// Resolve the manifest entry to install/update to WITHOUT downloading
// the zip. Returns { target, manifestUrl }. Shared by the installer
// (downloadAndVerify) and the `update`/`status` subcommands — the
// latter hand the coords to the orchestrator's tarball mode rather
// than unpacking here.
function resolveReleaseTarget({ version, soft = false }) {
  const fail = (msg) => { if (soft) throw new Error(msg); die(msg) }
  const manifestUrl = `${RELEASE_HOST}/manifest.json`
  const tmpManifest = join(
    tmpdir(),
    `cavecms-manifest-${process.pid}-${randomBytes(6).toString('hex')}.json`,
  )
  // die() is process.exit() and does NOT run `finally`; register an
  // exit handler so the tmp file is reaped on the hard-exit error paths too.
  const cleanup = () => { try { rmSync(tmpManifest, { force: true }) } catch { /* best-effort */ } }
  process.once('exit', cleanup)
  try {
    // Progress to stderr so `update --check` keeps stdout pure JSON.
    console.error(c('gray', `ℹ Fetching release index from ${manifestUrl}…`))
    // The manifest is a few KiB. On the soft (interactive status/--check) path
    // fail fast against a stalled/black-holed host — one try, short timeout —
    // so the command degrades in seconds, not minutes. Non-soft (install/
    // update apply) keeps the patient 60s × 3 budget.
    fetchToFileViaWget(manifestUrl, tmpManifest, soft ? 10 : 60, { soft, tries: soft ? 1 : 3 })
    let manifest
    try {
      manifest = JSON.parse(readFileSync(tmpManifest, 'utf8'))
    } catch {
      // Cloudflare challenge HTML / truncated body / garbage → clean message,
      // not a raw SyntaxError stack at the operator.
      return fail(
        `The release index from ${manifestUrl} couldn't be read (it wasn't valid JSON).\n` +
          `  The dist host may be returning an error or challenge page. Try again in a moment.`,
      )
    }
    if (!Array.isArray(manifest.releases) || manifest.releases.length === 0) {
      return fail('Release manifest is empty — the dist host is misconfigured.')
    }
    const target = version === 'latest'
      ? manifest.releases[0]
      : manifest.releases.find((r) => r.version === version)
    if (!target) {
      return fail(
        `Version "${version}" not found in the release manifest. ` +
          `Available: ${manifest.releases.map((r) => r.version).join(', ')}`,
      )
    }
    assertManifestTargetSafe(manifestUrl, target.downloadUrl, { soft })
    return { target, manifestUrl }
  } finally {
    cleanup()
  }
}

async function downloadAndVerify({ targetDir, version, skipSignature }) {
  const { target } = resolveReleaseTarget({ version })
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

  log.ok(`Will install CaveCMS ${target.version} (published ${target.publishedAt})`)
  if (target.isSecurity) {
    log.warn('This is marked as a security release. Continuing.')
  }

  // Download the zip via wget (memory-friendly for large files).
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
    const ok = BUNDLED_PUBKEYS_PEM.some((pem) =>
      verifyEd25519(zipPath, target.signature, pem),
    )
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

  // Restart mode for the in-app updater (scripts/cavecms-update.sh restart_app).
  // The orchestrator's modes are systemd | cpanel | pm2 | laptop; the CLI's
  // `vps` surface installs a systemd unit, so it maps to `systemd`. The others
  // pass through unchanged. Persisting this lets the dashboard apply route
  // forward it — without it the orchestrator defaults to pm2, and a bare-node
  // laptop install can't self-restart (pm2 reload → no daemon → health-check
  // fail → spurious rollback). With it, a laptop install finishes the update
  // in `laptop` mode (build + "restart required" prompt, no rollback).
  const restartMode = surface === 'vps' ? 'systemd' : surface

  // Per-install backup output dir for the operator-facing backup/restore
  // engine (scripts/cavecms-backup.sh). A host-filesystem fact like
  // UPLOADS_ROOT — the engine must locate it + disk-check it BEFORE it can
  // trust the DB is reachable, so it lives in env, not the settings table
  // (infra, not product config). Retention is an engine constant, not here.
  // Derived from targetDir on ALL surfaces so it stays inside the systemd
  // unit's ReadWritePaths (= ${targetDir}) even with a custom --dir on vps.
  // For the default vps install (targetDir=/opt/cavecms) this is the unchanged
  // /opt/cavecms/backups.
  const backupDir = join(targetDir, 'backups')

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
    `# Per-install log directory for the in-app updater's spawn log + the`,
    `# orchestrator's step logs. Owned by the runtime user → writable without`,
    `# root. The updater's default is /var/log/cavecms, which doesn't exist and`,
    `# can't be created without root on a non-root (laptop / shared-host)`,
    `# install — pointing it here keeps the dashboard updater working there.`,
    `CAVECMS_LOG_DIR=${stateDir}/logs`,
    `# Per-install cache for background-prestaged release artifacts (the`,
    `# auto-download feature). The updater downloads + verifies a release here`,
    `# after a check finds it, so a later "Update now" installs in seconds.`,
    `# Owned by the runtime user; defaults to <STATE_DIR>/release-cache when`,
    `# unset, so legacy installs need no edit.`,
    `CAVECMS_UPDATE_CACHE_DIR=${stateDir}/release-cache`,
    `# Per-install backup output directory for 'cavecms backup' + the in-app`,
    `# Settings → Backups page. Host-filesystem fact (like UPLOADS_ROOT); the`,
    `# backup engine disk-checks + writes archives here. Retention (keep last 5`,
    `# / 30 days) is an engine constant, not configured here.`,
    `CAVECMS_BACKUP_DIR=${backupDir}`,
    `# How the in-app updater restarts this install after a successful build.`,
    `# systemd | cpanel | pm2 | laptop. A laptop/dev install can't self-restart`,
    `# (bare node, no service manager) — the updater installs the new version`,
    `# then asks you to restart the process. Hosted surfaces restart`,
    `# automatically. When unset (legacy installs) the updater defaults to pm2.`,
    `CAVECMS_RESTART_MODE=${restartMode}`,
    // Laptop installs start via bare `node --env-file=env.production` with NO
    // service manager (systemd unit / pm2 ecosystem) to inject the
    // installer-pinned vars. On VPS/PM2 those configs set CAVECMS_ENV_FILE +
    // CAVECMS_REPO_DIR; the laptop surface has nowhere else to put them, so
    // they live here. Without CAVECMS_ENV_FILE the in-app updater's migrate +
    // env-stamp steps fall back to /etc/cavecms/env.production (the bare-metal
    // default), which doesn't exist on a laptop install → step 3 fails +
    // rolls back. (On VPS/PM2 we deliberately DON'T add these — the service
    // config is authoritative there.)
    ...(surface === 'laptop'
      ? [
          `# Installer-pinned paths (laptop surface has no service manager to inject them).`,
          `CAVECMS_ENV_FILE=${envPath}`,
          `CAVECMS_REPO_DIR=${targetDir}`,
        ]
      : []),
    `# Release bookkeeping — re-stamped on every in-app update.`,
    `# CAVECMS_COMMIT is the short (12-char) git SHA the release was built`,
    `# from. The in-app updater compares this against the latest manifest's`,
    `# sha via getCurrentVersion() to decide "is an update available?". A`,
    `# missing or 'dev' value here disables the updater (cannot_apply_from_dev).`,
    `CAVECMS_COMMIT=${normalizeCommitSha(release?.sha)}`,
    `CAVECMS_RELEASE_TS=${new Date().toISOString()}`,
    `# The CLI installed this from cavecms-updates.derricksiawor.com — keep this in sync`,
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
  // Backup output dir for the operator-facing backup/restore engine. Same
  // chown-on-surface-start mechanism (for laptop/pm2 it's under targetDir; for
  // vps it's /opt/cavecms/backups, chowned by startVps).
  mkdirSync(backupDir, { recursive: true, mode: 0o750 })
  return { envPath, databaseUrl, uploadsRoot, stateDir, backupDir }
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
// Recovery subcommands — `update` / `rollback` / `version` / `status`
//
// These let an operator with only shell access update or roll back an
// EXISTING install from the terminal, WITHOUT the admin dashboard — the
// recovery path for "I'm locked out of the dashboard" or "a bad release
// broke the site". Because they ship in the npm-published CLI (run via
// `npx create-cavecms@latest <cmd>` or the installed `cavecms` shim),
// the recovery logic is fetched fresh each run and can't be taken down
// by the install's own (possibly-broken) tree.
//
// They reuse the install's scripts/cavecms-update.sh orchestrator
// (tarball mode + Ed25519 verify + snapshot/rollback) and the sealed
// env.production for all connection + path config, mirroring the env
// recipe in app/api/admin/updates/apply/route.ts.
// ════════════════════════════════════════════════════════════════════

const RECOVERY_SUBCOMMANDS = new Set([
  'update',
  'rollback',
  'version',
  'status',
  'backup',
  'restore',
  'backups',
  'login',
  'logout',
  'whoami',
  'pull',
  'push',
])

function parseSubArgv(argv, sub) {
  const out = {
    dir: null,
    check: false,
    force: false,
    version: 'latest',
    // backup/restore flags
    includeEnv: false,
    restoreEnv: false,
    insecurePlaintextEnv: false,
    yes: false,
    archive: null,
    identity: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') out.check = true
    else if (a === '--force') out.force = true
    else if (a === '--include-env') out.includeEnv = true
    else if (a === '--restore-env') out.restoreEnv = true
    else if (a === '--insecure-plaintext-env') out.insecurePlaintextEnv = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a.startsWith('--dir=')) {
      const v = a.slice('--dir='.length)
      if (v === '') die('--dir requires a path (e.g. --dir /opt/cavecms)')
      out.dir = v
    }
    else if (a === '--dir') {
      const v = argv[++i]
      // Guard against `--dir` as the last token or `--dir --force` (which
      // would silently target cwd / swallow the next flag).
      if (v === undefined || v === '' || v.startsWith('--')) die('--dir requires a path (e.g. --dir /opt/cavecms)')
      out.dir = v
    }
    else if (a.startsWith('--archive=')) {
      const v = a.slice('--archive='.length)
      if (v === '') die('--archive requires a path to a .tar.gz backup file')
      out.archive = v
    }
    else if (a === '--archive') {
      const v = argv[++i]
      if (v === undefined || v === '' || v.startsWith('--')) die('--archive requires a path to a .tar.gz backup file')
      out.archive = v
    }
    else if (a.startsWith('--identity=')) {
      const v = a.slice('--identity='.length)
      if (v === '') die('--identity requires a path to an age identity file')
      out.identity = v
    }
    else if (a === '--identity') {
      const v = argv[++i]
      if (v === undefined || v === '' || v.startsWith('--')) die('--identity requires a path to an age identity file')
      out.identity = v
    }
    else if (a.startsWith('--version=')) {
      const v = a.slice('--version='.length)
      if (v === '') die('--version requires a value (e.g. --version 0.1.50 or latest)')
      out.version = v
    }
    else if (a === '--version') {
      const v = argv[++i]
      if (v === undefined || v === '' || v.startsWith('--')) die('--version requires a value (e.g. --version 0.1.50 or latest)')
      out.version = v
    }
    else if (a.startsWith('--')) die(`Unknown flag for this command: ${a}`)
    else die(`Unexpected argument "${a}"${sub === 'update' ? ` — did you mean --version=${a}?` : ''}`)
  }
  // Reject flags a command doesn't honour, instead of silently no-op'ing,
  // so a mistyped recovery command fails loudly.
  if (sub && sub !== 'update') {
    if (out.check) die(`\`cavecms ${sub}\` does not take --check`)
    if (out.force) die(`\`cavecms ${sub}\` does not take --force`)
    if (out.version !== 'latest') die(`\`cavecms ${sub}\` does not take --version`)
  }
  if (sub && sub !== 'backup' && out.includeEnv) die(`\`cavecms ${sub}\` does not take --include-env`)
  if (sub && sub !== 'restore' && (out.restoreEnv || out.archive || out.identity)) {
    die(`\`cavecms ${sub}\` does not take restore flags`)
  }
  if (sub === 'update' && (out.includeEnv || out.restoreEnv || out.archive || out.identity)) {
    die('`cavecms update` does not take backup/restore flags')
  }
  return out
}

function parseEnvFile(envPath) {
  const env = {}
  for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return env
}

function resolveInstallDir(opts) {
  const dir = opts.dir ? resolve(opts.dir) : process.cwd()
  const envPath = join(dir, 'env.production')
  if (!existsSync(envPath)) {
    die(
      `No CaveCMS install found at ${dir}\n` +
        `  (expected a sealed env.production there).\n` +
        `  Run this from your install directory, or pass --dir /path/to/install.`,
    )
  }
  return { dir, envPath, env: parseEnvFile(envPath) }
}

function detectInstallSurface(dir, env) {
  // Detect from THIS install's own signals only — never a global path like
  // /etc/systemd/system/cavecms.service, which could belong to a SIBLING
  // install on a multi-install host and shadow the cpanel/laptop checks.
  // writeSealedEnv is the sole producer of /opt/cavecms-rooted paths and
  // writes them only for the vps surface, so the env is an install-specific
  // vps signal.
  if (existsSync(join(dir, 'pm2.config.cjs'))) return 'pm2'
  if (
    (typeof env.UPLOADS_ROOT === 'string' && env.UPLOADS_ROOT.startsWith('/opt/cavecms')) ||
    (typeof env.CAVECMS_STATE_DIR === 'string' && env.CAVECMS_STATE_DIR.startsWith('/opt/cavecms'))
  ) return 'vps'
  if (existsSync(join(dir, 'app.js'))) return 'cpanel'
  return 'laptop'
}

// Read the pm2 app name + PM2_HOME the installer baked into
// pm2.config.cjs so the orchestrator reloads the RIGHT app under the
// RIGHT daemon — matches the CAVECMS_PM2_APP_NAME / PM2_HOME forwarding
// in app/api/admin/updates/apply/route.ts's buildScriptEnv.
function readPm2Config(dir) {
  const p = join(dir, 'pm2.config.cjs')
  if (!existsSync(p)) return {}
  const text = readFileSync(p, 'utf8')
  const nameM = text.match(/CAVECMS_PM2_APP_NAME:\s*(['"])(.*?)\1/) || text.match(/name:\s*(['"])(.*?)\1/)
  const homeM = text.match(/PM2_HOME:\s*(['"])(.*?)\1/)
  return {
    pm2AppName: nameM ? nameM[2] : undefined,
    pm2Home: homeM ? homeM[2] : undefined,
  }
}

function shortSha(s) {
  return typeof s === 'string' ? s.slice(0, 12) : s
}

// Allowlist of env vars the orchestrator actually needs — mirrors the
// dashboard apply route's SCRIPT_ENV_ALLOWLIST. The app-auth secrets
// (JWT/CSRF/PREVIEW/BROCHURE/SECRETS_ENCRYPTION_KEY/INSTALL_BOOTSTRAP_TOKEN)
// are DELIBERATELY excluded: the orchestrator never reads them, and
// forwarding them into the spawned bash + its `pnpm install` lifecycle
// scripts would let a malicious dependency postinstall read the full secret
// set (and echo it into the inherited stdio). The CLI must not be a
// weaker-trust path than the dashboard.
const ORCHESTRATOR_ENV_ALLOWLIST = [
  // Process essentials so node/pnpm/pm2/wget/git resolve.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV',
  'NPM_CONFIG_USERCONFIG', 'XDG_RUNTIME_DIR',
  // DB connectivity for db:migrate.
  'DATABASE_URL', 'DATABASE_MIGRATOR_URL',
  // The only two secrets the orchestrator genuinely uses (internal
  // maintenance/audit POST + healthz verify) — NOT the app-auth secrets.
  'INTERNAL_REVALIDATE_SECRET', 'HEALTHZ_TOKEN',
  // Process-manager handles + the surface's restart mechanism.
  'PM2_HOME', 'CAVECMS_PM2_APP_NAME', 'CAVECMS_RESTART_MODE', 'CAVECMS_SYSTEMD_UNIT',
  // Per-install runtime state + snapshot + log dirs.
  'CAVECMS_STATE_DIR', 'CAVECMS_SNAPSHOT_ROOT', 'CAVECMS_LOG_DIR',
  // Release bookkeeping the orchestrator restamps into env.production.
  'CAVECMS_COMMIT', 'CAVECMS_RELEASE_TS',
  // PORT — used to derive CAVECMS_HEALTHZ_URL. CAVECMS_RELEASE_PROBE_URL is
  // forwarded only if an operator explicitly set it (parity with the dashboard
  // allowlist); the CLI never defaults it (see runOrchestrator note on the CF
  // curl-403 hazard), so the orchestrator keeps its curl-friendly default.
  'PORT', 'CAVECMS_RELEASE_PROBE_URL',
  // Operator opt-ins the orchestrator honours only when explicitly set.
  // (CAVECMS_UPDATE_DRY_RUN is intentionally NOT here — it's a dev/test
  //  harness flag, gated behind CAVECMS_DEV_BUILD in runOrchestrator so an
  //  ambient shell value can't make a real recovery silently no-op.)
  'CAVECMS_ALLOW_CONTRACT', 'CAVECMS_FORCE_SINGLE_TREE',
]

// Decide whether an existing lock is stale (its holder is gone or not
// actually one of our orchestrator processes, or it's old with no live
// holder). Mirrors lib/updates/statusFile.ts lockIsStale() so the CLI can
// reclaim an orphaned PID-stamped lock in the OOM-kill / recycled-PID /
// cross-user cases the dashboard already handles — otherwise the recovery
// CLI gets permanently wedged on "already in progress" in exactly the
// bad-release scenario it exists for.
function lockIsStaleCli(lockPath, statusPath) {
  const STALE_MS = 15 * 60 * 1000
  let pid = 0
  try { pid = Number((readFileSync(lockPath, 'utf8') || '').trim()) } catch { /* unreadable */ }
  if (Number.isInteger(pid) && pid > 0) {
    let alive
    try {
      process.kill(pid, 0)
      alive = true
    } catch (e) {
      if (e && e.code === 'ESRCH') return true // no such process → stale
      alive = true // EPERM → a live process we don't own (maybe recycled)
    }
    if (alive) {
      // Identity check (Linux /proc): a live PID that is NOT one of our
      // orchestrator scripts is a recycled/cross-user PID → stale. If /proc
      // is unavailable (macOS dev) or unreadable, fall through to the mtime
      // backstop rather than trusting the bare PID.
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        if (cmdline) {
          return !/cavecms-update|cavecms-watchdog|cavecms-backup|cavecms-restore/.test(cmdline)
        }
      } catch { /* no /proc → mtime backstop below */ }
    }
  }
  // mtime backstop — prefer the status file's updatedAt (the orchestrator
  // rewrites it every step), fall back to the lock file's mtime.
  try {
    const s = JSON.parse(readFileSync(statusPath, 'utf8'))
    if (s && typeof s.updatedAt === 'string') {
      const age = Date.now() - Date.parse(s.updatedAt)
      if (Number.isFinite(age)) return age > STALE_MS
    }
  } catch { /* no/garbage status → lock mtime */ }
  try {
    return (Date.now() - statSync(lockPath).mtimeMs) > STALE_MS
  } catch {
    return false // can't stat → treat as held (conservative)
  }
}

// Acquire the update lock the orchestrator + dashboard share, so a CLI
// update/rollback can't run concurrently with the dashboard (or a second
// CLI run) on the same tree, and can never delete a lock it doesn't own.
// Returns the open fd on success, the string 'held' if a LIVE updater holds
// it (caller refuses), or 'skip' if the lock infra is unavailable (legacy
// install with no writable state dir — proceed unlocked rather than block
// recovery). Mirrors the apply route's O_EXCL acquire + staleness check.
function acquireCliLock(lockPath, statusPath) {
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd
    try {
      fd = openSync(lockPath, flags, 0o600)
    } catch (err) {
      const code = err && err.code
      // ENOENT (no state dir at all → legacy install) degrades to unlocked
      // recovery. But EACCES/EPERM must fail CLOSED, matching the dashboard
      // apply route (which 500s `state_dir_not_writable`) — otherwise the CLI
      // would be a weaker-trust path and a concurrent update could race.
      if (code === 'ENOENT') return 'skip'
      if (code === 'EACCES' || code === 'EPERM') {
        die(
          "Can't acquire the update lock — the runtime user can't write the update state dir.\n" +
            '  A concurrent dashboard or CLI update can\'t be detected safely from here.\n' +
            '  Re-run as the install\'s runtime user or with sudo (e.g. `sudo cavecms ' + 'update`/`rollback`), or fix the state-dir ownership.',
        )
      }
      if (code !== 'EEXIST') throw err
      if (attempt === 0 && lockIsStaleCli(lockPath, statusPath)) {
        try { unlinkSync(lockPath) } catch { /* raced */ }
        continue
      }
      return 'held'
    }
    // Stamp our PID so a concurrent staleness check sees a live holder in
    // the window before the orchestrator re-stamps its own PID.
    try { writeSync(fd, String(process.pid)) } catch { /* best-effort */ }
    return fd
  }
  return 'held'
}

// Build the env the orchestrator needs + spawn it in the FOREGROUND
// (stdio inherit) so the operator watches progress live and gets the
// real exit code. Reconstructs the recipe from
// app/api/admin/updates/apply/route.ts (SCRIPT_ENV_ALLOWLIST /
// buildScriptEnv) out of the sealed env.production instead of the
// running process's env.
function runOrchestrator({ dir, envPath, env, mode, targetSha, fromSha, force, target }) {
  const scriptPath = join(dir, 'scripts', 'cavecms-update.sh')
  if (!existsSync(scriptPath)) {
    die(
      `Updater engine missing at ${scriptPath}.\n` +
        `  The install tree looks incomplete. Reinstall: npx create-cavecms@latest --dir ${dir}`,
    )
  }
  const surface = detectInstallSurface(dir, env)
  const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0

  // The orchestrator must run as the RIGHT user per surface so the restart
  // talks to the right daemon and snapshots get the right ownership.
  if (surface === 'pm2') {
    // pm2 installs are managed by a dedicated runtime user (www-data). Running
    // pm2 as root would hit a DIFFERENT root daemon (reload no-ops, the live
    // www-data process keeps serving) AND write root-owned snapshots the
    // dashboard updater later can't restore. So root is WRONG here — refuse.
    const runUser = env.CAVECMS_PM2_USER || process.env.CAVECMS_PM2_USER || 'www-data'
    if (isRoot) {
      die(
        `This is a pm2 install managed by "${runUser}". Running ${mode} as root would reload the wrong pm2 daemon and write snapshots ${runUser} can't restore.\n` +
          `  Re-run as the runtime user:  sudo -u ${runUser} cavecms ${mode}`,
      )
    }
    log.warn(`pm2 install (managed by "${runUser}"). If ${mode} fails with a permission/daemon error, run it as that user:`)
    log.gray(`  sudo -u ${runUser} cavecms ${mode}`)
  } else if (surface === 'vps' && !isRoot) {
    // vps installs restart via systemd — that needs root (systemctl).
    log.warn(`vps/systemd install — ${mode} needs root to restart the service (systemctl).`)
    log.gray(`  If ${mode} fails with a permission error, re-run with: sudo cavecms ${mode}`)
  }

  // Build a NARROW child env from the allowlist — operator's shell value
  // first (PATH/HOME so node/pnpm/pm2/wget/git resolve), then the sealed
  // install config wins. App-auth secrets are never copied (see allowlist).
  const childEnv = {}
  for (const k of ORCHESTRATOR_ENV_ALLOWLIST) {
    if (typeof process.env[k] === 'string') childEnv[k] = process.env[k]
    if (typeof env[k] === 'string') childEnv[k] = env[k]
  }
  childEnv.CAVECMS_REPO_DIR = dir
  childEnv.CAVECMS_ENV_FILE = envPath
  const port = env.PORT || '3040'
  if (!childEnv.CAVECMS_HEALTHZ_URL) {
    childEnv.CAVECMS_HEALTHZ_URL = `http://127.0.0.1:${port}/healthz`
  }
  // NOTE: we deliberately do NOT point the orchestrator's step-1 reachability
  // probe at the release host. That host is behind Cloudflare Bot Fight Mode,
  // which 403s plain curl from datacenter IPs (the whole reason downloads use
  // wget+UA) — and the orchestrator probes with curl. Leaving
  // CAVECMS_RELEASE_PROBE_URL unset lets the orchestrator use its
  // curl-friendly api.github.com/zen default (matching the dashboard), and the
  // CLI has ALREADY proven the release host reachable via wget in
  // resolveReleaseTarget just above, so a second probe adds no signal.
  // Tell the orchestrator how to restart THIS install's service. Without it
  // the orchestrator defaults to pm2, which silently no-ops on systemd (vps)
  // + Passenger (cpanel) installs.
  childEnv.CAVECMS_RESTART_MODE = surface === 'vps' ? 'systemd' : surface
  if (surface === 'vps') childEnv.CAVECMS_SYSTEMD_UNIT = 'cavecms.service'
  // Resolve the status + lock path the same way the dashboard does, so our
  // lock and its lock are the same file. For legacy installs (no
  // CAVECMS_STATE_DIR) fall back to the per-install `.cavecms-state` dir
  // (owned by the runtime user) — NOT /var/lib/cavecms, which the runtime
  // user typically can't write. Mirrors statusFile.ts getInstallStateDir().
  const stateDir = env.CAVECMS_STATE_DIR || join(dir, '.cavecms-state')
  const statusPath = join(stateDir, 'update-status.json')
  childEnv.CAVECMS_UPDATE_STATUS_PATH = statusPath
  if (!childEnv.CAVECMS_STATE_DIR) childEnv.CAVECMS_STATE_DIR = stateDir
  childEnv.CAVECMS_UPDATE_FROM = fromSha || env.CAVECMS_COMMIT || 'unknown'

  // Dry-run is a dev/test harness affordance only — honour an ambient
  // CAVECMS_UPDATE_DRY_RUN ONLY under CAVECMS_DEV_BUILD so a stale shell
  // export can't make a real operator's recovery silently no-op.
  if (process.env.CAVECMS_DEV_BUILD === '1' && process.env.CAVECMS_UPDATE_DRY_RUN === '1') {
    childEnv.CAVECMS_UPDATE_DRY_RUN = '1'
  }

  if (surface === 'pm2') {
    const { pm2AppName, pm2Home } = readPm2Config(dir)
    if (pm2AppName) childEnv.CAVECMS_PM2_APP_NAME = pm2AppName
    if (pm2Home) childEnv.PM2_HOME = pm2Home
  }

  let args
  if (mode === 'rollback') {
    args = ['rollback']
  } else {
    // Update: hand the orchestrator tarball-mode coords + the bundled
    // pubkey so it verifies the SAME way the dashboard apply path does.
    childEnv.CAVECMS_UPDATE_TARBALL_URL = target.downloadUrl
    childEnv.CAVECMS_UPDATE_TARBALL_SHA256 = target.sha256
    if (target.signature) childEnv.CAVECMS_UPDATE_TARBALL_SIGNATURE = target.signature
    childEnv.CAVECMS_RELEASE_PUBKEY_PEM = BUNDLED_PUBKEY_PEM
    args = force ? ['--force', targetSha] : [targetSha]
  }

  // Cross-process mutual exclusion — O_EXCL lock so a CLI update/rollback
  // can't run concurrently with the dashboard (or a second CLI run) on the
  // same tree, and can't delete a lock it doesn't own. Unlike the dashboard
  // apply route (which DETACHES the orchestrator and hands the lock off to
  // it), this path runs the orchestrator in the FOREGROUND and holds the
  // lock for the whole synchronous run; the orchestrator best-effort
  // re-stamps its own PID and rm's the lock in its EXIT/signal traps, and we
  // rm it again defensively below.
  const lockPath = `${statusPath}.lock`
  const lock = acquireCliLock(lockPath, statusPath)
  if (lock === 'held') {
    die('An update or rollback is already in progress on this install. Wait for it to finish, then try again.')
  }

  const r = spawnSync('bash', [scriptPath, ...args], {
    cwd: dir,
    stdio: 'inherit',
    env: childEnv,
    // Overall wall-clock backstop so a wedged sub-step (hung pm2 daemon,
    // stalled mirror) can't pin an unattended `cavecms update` forever. 60 min
    // is well above a legitimate pnpm install+build on a small VPS. SIGTERM so
    // the orchestrator's TERM trap still runs lock + maintenance cleanup; the
    // r.signal branch below then prints the actionable retry message.
    timeout: 60 * 60 * 1000,
    killSignal: 'SIGTERM',
  })
  // spawnSync ran to completion in the foreground; the orchestrator's EXIT
  // trap already rm'd the lock. Defensively clean up in case it was SIGKILL'd
  // before its trap ran — but ONLY unlink a lock that still carries OUR pid,
  // so we can't delete a lock a concurrent dashboard apply re-acquired in the
  // tiny window after the orchestrator removed it.
  if (typeof lock === 'number') {
    try { closeSync(lock) } catch { /* already closed */ }
    try {
      if ((readFileSync(lockPath, 'utf8') || '').trim() === String(process.pid)) {
        unlinkSync(lockPath)
      }
    } catch { /* gone, re-stamped by the orchestrator, or re-acquired — leave it */ }
  }
  // vps + root: the orchestrator just wrote snapshots + update-status.json as
  // root, but the systemd-managed app (and thus the dashboard updater) runs as
  // the unit's runtime user. Hand ownership of the state dir back so a later
  // dashboard rollback can read those snapshots / rewrite status.
  if (surface === 'vps' && isRoot && env.CAVECMS_STATE_DIR) {
    let runUser = process.env.SUDO_USER || 'cavecms'
    try {
      const u = spawnSync('systemctl', ['show', '-p', 'User', '--value', 'cavecms.service'], { encoding: 'utf8' })
      if (u.status === 0 && typeof u.stdout === 'string' && u.stdout.trim()) runUser = u.stdout.trim()
    } catch { /* keep default */ }
    spawnSync('chown', ['-R', `${runUser}:${runUser}`, env.CAVECMS_STATE_DIR], { stdio: 'ignore' })
  }
  if (r.error) {
    die(`Couldn't run the updater engine: ${r.error.message}`)
  }
  if (r.signal) {
    if (mode === 'rollback') {
      die(`The rollback engine was stopped by ${r.signal} (often the out-of-memory killer or an external stop). The restore may have been interrupted — your site could be left in maintenance mode and partially rolled back. Re-run \`cavecms rollback\` (it's idempotent), then check \`cavecms status\`.`)
    }
    die(`The updater engine was stopped by ${r.signal} (often the out-of-memory killer or an external stop). No changes were committed; your previous version should still be running — check 'cavecms status'.`)
  }
  process.exit(r.status ?? 1)
}

function readInstallVersion(dir) {
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const v = JSON.parse(readFileSync(pkgPath, 'utf8')).version
      if (typeof v === 'string') return v
    } catch { /* fall through */ }
  }
  return 'unknown'
}

async function commandUpdate(argv) {
  const opts = parseSubArgv(argv, 'update')
  const { dir, envPath, env } = resolveInstallDir(opts)
  const current = env.CAVECMS_COMMIT || 'dev'
  // Validate current up front (parity with the dashboard, which throws
  // current_sha_malformed) — a hand-edited/truncated CAVECMS_COMMIT would
  // otherwise corrupt the prefix comparison below and flow into the
  // orchestrator as PREVIOUS_SHA.
  if (current !== 'dev' && !/^[0-9a-f]{7,64}$/i.test(current)) {
    die(`This install's CAVECMS_COMMIT is malformed (${JSON.stringify(current)}). Reinstall from a current release: npx create-cavecms@latest --dir ${dir}`)
  }
  if (!opts.check) {
    log.header('CaveCMS update')
    preflightDeps() // wget (manifest + tarball), unzip, curl — checked up front
    // The update path takes a mandatory pre-destructive snapshot via rsync
    // (snapshot_current_tree hard-fails without it) — check it here so a
    // missing rsync fails fast with an actionable hint, like rollback does,
    // instead of opaquely at orchestrator step 2.
    if (spawnSync('command', ['-v', 'rsync'], { shell: '/bin/bash', stdio: 'ignore' }).status !== 0) {
      die(
        'update needs rsync (it snapshots your current version before applying), which is not installed.\n' +
          '  Install it and retry:  Debian/Ubuntu → sudo apt install rsync   ·   RHEL/Alma → sudo yum install rsync',
      )
    }
  }
  const { target } = resolveReleaseTarget({ version: opts.version })
  const targetSha = (target.sha || '').toLowerCase()
  if (!/^[0-9a-f]{7,64}$/.test(targetSha)) {
    die(`Latest release manifest has no usable commit SHA (got ${JSON.stringify(target.sha)}). Can't update safely.`)
  }
  const upToDate =
    current !== 'dev' &&
    (targetSha.startsWith(current) || current.startsWith(targetSha))

  if (opts.check) {
    // Machine-readable. resolveReleaseTarget logs progress to stderr so
    // stdout stays pure JSON. A dev install's updater is disabled (the apply
    // path refuses), so report updateAvailable:false + an explicit
    // updaterDisabled flag rather than a misleading true.
    const updaterDisabled = current === 'dev'
    console.log(JSON.stringify({
      current,
      latest: {
        version: target.version,
        sha: targetSha,
        publishedAt: target.publishedAt,
        isSecurity: !!target.isSecurity,
      },
      updateAvailable: updaterDisabled ? false : !upToDate,
      updaterDisabled,
    }, null, 2))
    return
  }

  if (current === 'dev') {
    die(
      `This install reports CAVECMS_COMMIT=dev — the updater is disabled.\n` +
        `  Reinstall from a current release: npx create-cavecms@latest --dir ${dir}`,
    )
  }
  if (upToDate && !opts.force) {
    log.ok(`Already on the latest release (${target.version}, ${shortSha(current)}).`)
    log.gray('  Force a clean re-install of the same version with: cavecms update --force')
    return
  }
  if (!target.signature) {
    die(`Latest release (${target.version}) has no Ed25519 signature — refusing to update.`)
  }
  // Require sha256 too — the dashboard apply route hard-requires it (Zod
  // /^[a-f0-9]{64}$/); without parity the CLI would accept a manifest the
  // dashboard rejects and the orchestrator's sha256 check would be skipped.
  if (!/^[a-f0-9]{64}$/i.test(String(target.sha256 || ''))) {
    die(`Latest release (${target.version}) has no usable sha256 fingerprint — refusing to update.`)
  }

  log.ok(`Updating ${shortSha(current)} → ${target.version} (${targetSha.slice(0, 12)})`)
  log.gray('Your site stays online until the new version is verified healthy; a failed update rolls back automatically.')
  console.log('')
  runOrchestrator({ dir, envPath, env, mode: 'update', targetSha, fromSha: current, force: opts.force, target })
}

async function commandRollback(argv) {
  const opts = parseSubArgv(argv, 'rollback')
  const { dir, envPath, env } = resolveInstallDir(opts)
  const current = env.CAVECMS_COMMIT || 'dev'
  // Validate up front (parity with commandUpdate + the dashboard) so a
  // malformed CAVECMS_COMMIT can't flow un-escaped into the orchestrator's
  // FROM_SHA → status/audit JSON. rollback is destructive, so die loudly.
  if (current !== 'dev' && !/^[0-9a-f]{7,64}$/i.test(current)) {
    die(`This install's CAVECMS_COMMIT is malformed (${JSON.stringify(current)}). Reinstall from a current release: npx create-cavecms@latest --dir ${dir}`)
  }
  // A dev install has no recorded version to roll back from — refuse (parity
  // with commandUpdate's dev guard), but DON'T tell the operator to reinstall
  // (that would discard a recoverable install).
  if (current === 'dev') {
    die(
      `This install reports CAVECMS_COMMIT=dev — there's no recorded version to roll back from.\n` +
        `  If your site is broken, install a known-good release: npx create-cavecms@latest --version=X.Y.Z --dir ${dir}`,
    )
  }
  log.header('CaveCMS rollback')
  // rollback restores the snapshot via rsync and verifies health via curl
  // (no download → no wget/unzip needed). Fail early with a clear hint if a
  // hard dep is missing, instead of an opaque mid-restore failure.
  for (const cmd of ['rsync', 'curl']) {
    if (spawnSync('command', ['-v', cmd], { shell: '/bin/bash', stdio: 'ignore' }).status !== 0) {
      die(
        `rollback needs ${cmd}, which is not installed.\n` +
          `  Install it and retry:  Debian/Ubuntu → sudo apt install ${cmd}   ·   RHEL/Alma → sudo yum install ${cmd}`,
      )
    }
  }
  log.warn('This restores the previous version from the most recent snapshot.')
  log.gray(`  Current version: ${shortSha(current)}`)
  console.log('')
  runOrchestrator({ dir, envPath, env, mode: 'rollback', fromSha: current })
}

function commandVersion(argv) {
  const opts = parseSubArgv(argv, 'version')
  const { dir, env } = resolveInstallDir(opts)
  console.log(`${c('bold', 'CaveCMS')} v${readInstallVersion(dir)}  ${c('gray', `(commit ${shortSha(env.CAVECMS_COMMIT || 'dev')})`)}`)
}

async function commandStatus(argv) {
  const opts = parseSubArgv(argv, 'status')
  const { dir, env } = resolveInstallDir(opts)
  // Coerce a malformed CAVECMS_COMMIT to 'dev' (parity with
  // getCurrentVersion) so the prefix comparison can't false-match an
  // empty/truncated value. status must NOT die on a broken box.
  let current = env.CAVECMS_COMMIT || 'dev'
  if (current !== 'dev' && !/^[0-9a-f]{7,64}$/i.test(current)) current = 'dev'
  console.log(`${c('bold', 'CaveCMS')} v${readInstallVersion(dir)}  ${c('gray', `(commit ${shortSha(current)})`)}`)
  console.log(c('gray', `Install dir: ${dir}`))
  // Mirror runOrchestrator's (and getInstallStateDir's) legacy fallback so the
  // 'Last update' line shows on legacy installs (no CAVECMS_STATE_DIR), where
  // the CLI wrote status to <dir>/.cavecms-state.
  {
    const stateDir = env.CAVECMS_STATE_DIR || join(dir, '.cavecms-state')
    const statusPath = join(stateDir, 'update-status.json')
    if (existsSync(statusPath)) {
      try {
        const s = JSON.parse(readFileSync(statusPath, 'utf8'))
        console.log(c('gray', `Last update: ${s.state} (step ${s.step}/${s.totalSteps}) — ${s.stepLabel || ''}`))
      } catch { /* ignore unreadable status */ }
    }
  }
  if (current === 'dev') {
    log.warn('Updater disabled (CAVECMS_COMMIT=dev).')
    return
  }
  try {
    // soft:true → resolveReleaseTarget throws (not process.exit) on an
    // unreachable/garbage host, so this catch degrades gracefully instead
    // of hard-exiting — `status` must work on a broken/offline box.
    const { target } = resolveReleaseTarget({ version: 'latest', soft: true })
    const targetSha = (target.sha || '').toLowerCase()
    if (!/^[0-9a-f]{7,64}$/.test(targetSha)) {
      log.warn(`Latest release (${target.version}) has no usable commit SHA — can't determine update state.`)
      return
    }
    const upToDate = targetSha.startsWith(current) || current.startsWith(targetSha)
    if (upToDate) {
      log.ok(`Up to date (latest is ${target.version}).`)
    } else {
      log.warn(`Update available: ${target.version} (${targetSha.slice(0, 12)})${target.isSecurity ? ' — security release' : ''}.`)
      log.gray('  Apply it with: cavecms update')
    }
  } catch (err) {
    log.warn(`Couldn't check for updates: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ════════════════════════════════════════════════════════════════════
// cavecms pull / push — local↔prod content sync (Promote-Snapshot model)
// ════════════════════════════════════════════════════════════════════
//
// pull  : read-only. Builds a bundle dir from a source install's content +
//         media + the source's content hash (the drift baseline).
// push  : assemble a bundle (from --from, or use --bundle=<dir>) → upload to
//         the target's /api/cms/sync/stage (validate + media) → /cutover
//         (drift-gated, atomic). --dry-run validates only, writes nothing.
//
// Zero-dep: node:https/http, system `tar`. Auth is a Bearer API token created
// in the target's /admin/settings/api-tokens (admin role). The push never
// touches users, secrets, leads, analytics, or security settings — the token
// scope + the server's cutover write-set enforce that.

function parseSyncArgv(argv, sub) {
  const o = { from: null, to: null, token: null, fromToken: null, out: null, bundle: null, site: null, dryRun: false, force: false, yes: false }
  const take = (a, i, name) => {
    const v = argv[i]
    if (v === undefined || v === '' || v.startsWith('--')) die(`${name} requires a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--force') o.force = true
    else if (a === '--yes' || a === '-y') o.yes = true
    else if (a.startsWith('--site=')) o.site = a.slice('--site='.length)
    else if (a === '--site') o.site = take(a, ++i, '--site')
    else if (a.startsWith('--from=')) o.from = a.slice('--from='.length)
    else if (a === '--from') o.from = take(a, ++i, '--from')
    else if (a.startsWith('--to=')) o.to = a.slice('--to='.length)
    else if (a === '--to') o.to = take(a, ++i, '--to')
    else if (a.startsWith('--token=')) o.token = a.slice('--token='.length)
    else if (a === '--token') o.token = take(a, ++i, '--token')
    else if (a.startsWith('--from-token=')) o.fromToken = a.slice('--from-token='.length)
    else if (a === '--from-token') o.fromToken = take(a, ++i, '--from-token')
    else if (a.startsWith('--out=')) o.out = a.slice('--out='.length)
    else if (a === '--out') o.out = take(a, ++i, '--out')
    else if (a.startsWith('--bundle=')) o.bundle = a.slice('--bundle='.length)
    else if (a === '--bundle') o.bundle = take(a, ++i, '--bundle')
    else if (a.startsWith('--')) die(`Unknown flag for \`cavecms ${sub}\`: ${a}`)
    else die(`Unexpected argument "${a}"`)
  }
  if (sub === 'pull' && (o.to || o.bundle || o.dryRun || o.force)) die('`cavecms pull` does not take --to/--bundle/--dry-run/--force')
  return o
}

function syncRequest(method, urlStr, { token, headers = {}, body } = {}) {
  return new Promise((resolve_, reject) => {
    let u
    try { u = new URL(urlStr) } catch { return reject(new Error(`Invalid URL: ${urlStr}`)) }
    const lib = u.protocol === 'https:' ? nodeHttps : nodeHttp
    const h = { 'user-agent': RELEASE_FETCH_UA, ...headers }
    if (token) h.authorization = `Bearer ${token}`
    const req = lib.request(
      { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: h, timeout: 180000 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve_({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    if (body) req.write(body)
    req.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A 5xx/429 is transient (CF blip, origin restart, rate-limit) — worth a retry.
// A 4xx (auth/validation) is the operator's to fix — never retried.
function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

// Retry wrapper for IDEMPOTENT requests (GET / media download). One slow or
// transiently-failing request used to abort an entire 50+-file media pull over
// Cloudflare; this retries network errors, timeouts, and 5xx/429 with capped
// exponential backoff. NOT used for POST stage/cutover (those are not blindly
// retry-safe — the push flow handles their failures explicitly).
async function syncRequestRetry(method, urlStr, opts = {}, { retries = 3, label = '' } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1))
      log.warn(`retrying${label ? ` ${label}` : ''} (attempt ${attempt}/${retries}) after ${backoff}ms…`)
      await sleep(backoff)
    }
    try {
      const r = await syncRequest(method, urlStr, opts)
      if (isTransientStatus(r.status)) {
        lastErr = new Error(`HTTP ${r.status}`)
        continue
      }
      return r
    } catch (e) {
      lastErr = e // network error / timeout — retry
    }
  }
  throw lastErr ?? new Error('request failed after retries')
}

// Non-fatal target content-hash probe (retrying). Returns the hash string, or
// null on any failure — NEVER die()s/throws to the caller. Used by the
// interrupted-cutover recovery so a transient 5xx on the recovery probe can't
// hard-exit and bypass the graceful re-check.
async function probeTargetHash(toUrl, token) {
  try {
    const r = await syncRequestRetry(
      'GET',
      `${toUrl}/api/cms/sync/hash`,
      { token, headers: { accept: 'application/json' } },
      { retries: 2, label: 'target hash probe' },
    )
    if (r.status < 200 || r.status >= 300) return null
    const j = tryJson(r.body)
    return j && typeof j.contentHash === 'string' ? j.contentHash : null
  } catch {
    return null
  }
}

function tryJson(buf) { try { return JSON.parse(buf.toString('utf8')) } catch { return null } }

// Warn (loudly) when an API token would travel over plaintext http:// to a
// non-local host. Local dev (localhost/127.0.0.1/::1) is fine; anything else
// over http leaks the bearer token on the wire.
function warnInsecureTransport(urlStr, label) {
  try {
    const u = new URL(urlStr)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
    if (u.protocol === 'http:' && !local) {
      log.warn(`${label} uses plaintext http:// (${u.hostname}) — your API token will be sent UNENCRYPTED. Use https:// for any non-local target.`)
    }
  } catch { /* invalid URL surfaces later */ }
}

async function syncGetJson(url, token) {
  const r = await syncRequestRetry('GET', url, { token, headers: { accept: 'application/json' } }, { label: 'GET ' + url })
  if (r.status < 200 || r.status >= 300) die(`GET ${url} → ${r.status}: ${r.body.toString('utf8').slice(0, 300)}`)
  const j = tryJson(r.body)
  if (j === null) die(`GET ${url} → non-JSON response (is this a CaveCMS install with the sync feature?)`)
  return j
}

async function syncDownload(url, token, dest) {
  const r = await syncRequestRetry('GET', url, { token, headers: { accept: 'image/*,application/pdf' } }, { label: 'download ' + url })
  if (r.status < 200 || r.status >= 300) die(`download ${url} → ${r.status}`)
  // A 200 with an HTML body is a CDN/proxy challenge or error page, not the
  // media file — writing it would silently corrupt the bundle. Require an
  // image/pdf content-type and a non-trivial body.
  const ct = String(r.headers['content-type'] || '')
  if (!/^(image\/|application\/pdf)/i.test(ct)) {
    die(`download ${url} returned content-type "${ct || 'none'}" (expected image/* or application/pdf) — a proxy challenge or error page?`)
  }
  if (r.body.length < 4) die(`download ${url} returned an empty/truncated body (${r.body.length} bytes)`)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, r.body)
}

async function syncPostJson(url, token, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  const r = await syncRequest('POST', url, { token, headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': String(body.length) }, body })
  return { status: r.status, json: tryJson(r.body) }
}

async function syncPostBundle(url, token, fileBuf) {
  // Raw gzip body (not multipart): lets the server STREAM the upload to disk
  // under a hard byte cap instead of buffering the whole compressed bundle in
  // heap (multipart + formData() would force the latter — a shared-host OOM
  // vector on the receiving install).
  const r = await syncRequest('POST', url, {
    token,
    headers: {
      'content-type': 'application/gzip',
      accept: 'application/json',
      'content-length': String(fileBuf.length),
    },
    body: fileBuf,
  })
  return { status: r.status, json: tryJson(r.body) }
}

const SYNC_IMG_VARIANTS = [['thumb', 'webp'], ['md', 'webp'], ['lg', 'webp'], ['og', 'jpg']]

// Build a bundle directory from a source install's export + media + hash.
async function assembleSyncBundle({ fromUrl, fromToken, outDir }) {
  const exp = await syncGetJson(`${fromUrl}/api/cms/sync/export`, fromToken)
  const hashResp = await syncGetJson(`${fromUrl}/api/cms/sync/hash`, fromToken)
  const content = exp.content
  const mediaOut = []
  for (const m of content.media) {
    const files = {}
    if (m.kind === 'pdf') {
      if (m.files.pdf) {
        const dest = `media/files/${m.bundleKey}.pdf`
        await syncDownload(`${fromUrl}${m.files.pdf}`, fromToken, join(outDir, dest))
        files.pdf = dest
      }
    } else {
      for (const [variant, ext] of SYNC_IMG_VARIANTS) {
        const src = m.files[variant]
        if (!src) continue
        const dest = `media/files/${m.bundleKey}-${variant}.${ext}`
        await syncDownload(`${fromUrl}${src}`, fromToken, join(outDir, dest))
        files[variant] = dest
      }
    }
    mediaOut.push({ ...m, files })
  }
  const manifest = {
    formatVersion: exp.formatVersion ?? 1,
    createdAt: new Date().toISOString(),
    sourceUrl: fromUrl,
    baselineContentHash: hashResp.contentHash,
    contentHash: exp.contentHash,
    counts: { pages: content.pages.length, posts: content.posts.length, projects: content.projects.length, media: mediaOut.length, settings: Object.keys(content.settings).length },
  }
  mkdirSync(join(outDir, 'content'), { recursive: true })
  mkdirSync(join(outDir, 'media'), { recursive: true })
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(outDir, 'content', 'pages.json'), JSON.stringify(content.pages))
  writeFileSync(join(outDir, 'content', 'posts.json'), JSON.stringify(content.posts))
  writeFileSync(join(outDir, 'content', 'projects.json'), JSON.stringify(content.projects))
  writeFileSync(join(outDir, 'content', 'settings.json'), JSON.stringify(content.settings))
  writeFileSync(join(outDir, 'content', 'settings-media-refs.json'), JSON.stringify(content.settingsMediaRefs ?? {}))
  writeFileSync(join(outDir, 'media', 'manifest.json'), JSON.stringify(mediaOut))
  return manifest
}

// ── cavecms login / logout / whoami — saved site profiles ───────────────────
// Modeled on the Stripe CLI: credentials live in ~/.config/cavecms/config.json
// (XDG_CONFIG_HOME respected) as named profiles, one marked default. `cavecms
// login` saves a site URL + its API token (the same `cave_…` token used across
// /api/cms/*) and makes it the default, so `push`/`pull` just work. A single-
// site user only ever does login → logout → login; an agency keeps one profile
// per client and selects with `--site <name>` (no logout/login churn). Tokens
// are sensitive → the file is mode 600.
function cavecmsConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'cavecms', 'config.json')
}
function readCavecmsConfig() {
  try {
    const j = JSON.parse(readFileSync(cavecmsConfigPath(), 'utf8'))
    if (j && typeof j === 'object' && j.profiles && typeof j.profiles === 'object') {
      return { default: typeof j.default === 'string' ? j.default : null, profiles: j.profiles }
    }
  } catch {
    /* no config yet */
  }
  return { default: null, profiles: {} }
}
function writeCavecmsConfig(cfg) {
  const p = cavecmsConfigPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* best-effort re-assert if the file pre-existed with looser perms */
  }
}
// Resolve the active site: explicit --site name, else the default profile.
function resolveSite(name) {
  const cfg = readCavecmsConfig()
  const key = name || cfg.default
  if (!key) return null
  const prof = cfg.profiles[key]
  if (!prof || typeof prof.url !== 'string' || typeof prof.token !== 'string') return null
  return { name: key, url: prof.url, token: prof.token }
}
function deriveSiteName(url) {
  try {
    return (
      new URL(url).hostname
        .replace(/^www\./, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'site'
    )
  } catch {
    return 'site'
  }
}
function readSiteFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--site=')) return a.slice('--site='.length)
    if (a === '--site') return argv[i + 1]
  }
  return null
}

async function commandLogin(argv) {
  // Non-interactive form: cavecms login --url=… --token=… [--site name]
  let url = null
  let token = null
  let name = readSiteFlag(argv)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--url=')) url = a.slice('--url='.length)
    else if (a === '--url') url = argv[++i]
    else if (a.startsWith('--token=')) token = a.slice('--token='.length)
    else if (a === '--token') token = argv[++i]
  }
  await withReadline(async (rl) => {
    if (!url) {
      url = await ask(rl, 'Site URL (e.g. https://yoursite.com)', {
        required: true,
        validate: (v) => {
          try {
            return new URL(v).protocol.startsWith('http') ? null : 'Use http:// or https://'
          } catch {
            return 'Enter a full URL like https://yoursite.com'
          }
        },
      })
    }
    if (!token) token = await askSecret(rl, 'API token (Settings → API Tokens)', { required: true })
  })
  url = url.replace(/\/+$/, '')
  token = token.trim()
  warnInsecureTransport(url, 'login')
  log.info(`Verifying ${url} …`)
  // The sync hash endpoint is ADMIN-gated, so a 200 proves three things at once:
  // the URL is a CaveCMS install, it has content sync, and the token is a valid
  // admin token. (Editor tokens can't push/pull, so we reject them here.)
  let r
  try {
    r = await syncRequestRetry(
      'GET',
      `${url}/api/cms/sync/hash`,
      { token, headers: { accept: 'application/json' } },
      { retries: 1, label: 'login check' },
    )
  } catch (e) {
    die(`Could not reach ${url}: ${e.message}`)
  }
  if (r.status === 401 || r.status === 403) {
    die(`That token was rejected by ${url}. Mint an ADMIN token under Settings → API Tokens, then try again.`)
  }
  if (r.status === 404) {
    die(`${url} returned 404 for the sync API — it may be an older CaveCMS without content sync, or the URL is wrong.`)
  }
  if (r.status < 200 || r.status >= 300) die(`${url} returned ${r.status} on the login check.`)
  if (!tryJson(r.body)?.contentHash) die(`${url} did not return a CaveCMS sync response — check the URL.`)
  if (!name) name = deriveSiteName(url)
  const cfg = readCavecmsConfig()
  cfg.profiles[name] = { url, token, loggedInAt: new Date().toISOString() }
  cfg.default = name
  writeCavecmsConfig(cfg)
  log.ok(`Logged in to ${url} (site “${name}”).`)
  console.log(c('gray', '  cavecms pull                       ← pull this site’s content into a bundle'))
  console.log(c('gray', '  cavecms push --from=<your-local>   → publish your local content to this site'))
  const others = Object.keys(cfg.profiles).filter((k) => k !== name)
  if (others.length) console.log(c('gray', `  other sites: ${others.join(', ')} — select with --site <name>`))
}

function commandLogout(argv) {
  const cfg = readCavecmsConfig()
  if (argv.includes('--all')) {
    writeCavecmsConfig({ default: null, profiles: {} })
    log.ok('Logged out of all sites.')
    return
  }
  const key = readSiteFlag(argv) || cfg.default
  if (!key || !cfg.profiles[key]) {
    log.info('You were not logged in.')
    return
  }
  const { url } = cfg.profiles[key]
  delete cfg.profiles[key]
  if (cfg.default === key) cfg.default = Object.keys(cfg.profiles)[0] || null
  writeCavecmsConfig(cfg)
  log.ok(`Logged out of ${url} (site “${key}”).`)
  if (cfg.default) console.log(c('gray', `  active site is now “${cfg.default}”`))
}

function commandWhoami(argv) {
  const cfg = readCavecmsConfig()
  const active = resolveSite(readSiteFlag(argv))
  if (!active) {
    log.info('Not logged in. Run `cavecms login`.')
    return
  }
  log.ok(`Active site “${active.name}” → ${active.url}`)
  console.log(c('gray', `  token: ${active.token.slice(0, 10)}…`))
  const all = Object.keys(cfg.profiles)
  if (all.length > 1) {
    console.log(
      c('gray', `  all sites: ${all.map((k) => (k === cfg.default ? `${k} (default)` : k)).join(', ')}`),
    )
  }
}

async function commandPull(argv) {
  const o = parseSyncArgv(argv, 'pull')
  const site = resolveSite(o.site)
  const fromUrl = (o.from || process.env.CAVECMS_SYNC_FROM || site?.url || '').replace(/\/+$/, '')
  const token = o.token || process.env.CAVECMS_SYNC_TOKEN || site?.token
  if (!fromUrl) die('`cavecms pull` needs a site — run `cavecms login`, or pass --from=<url>.')
  if (!token) die('`cavecms pull` needs an API token — run `cavecms login`, or pass --token=<api-token>.')
  warnInsecureTransport(fromUrl, 'pull source')
  const outDir = resolve(o.out || './cavecms-bundle')
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  log.info(`Pulling content from ${fromUrl} …`)
  const m = await assembleSyncBundle({ fromUrl, fromToken: token, outDir })
  log.ok(`Bundle written to ${outDir}`)
  console.log(c('gray', `  content sha: ${m.contentHash}`))
  console.log(c('gray', `  ${m.counts.pages} pages · ${m.counts.posts} posts · ${m.counts.projects} projects · ${m.counts.media} media · ${m.counts.settings} settings`))
  console.log(c('gray', `  publish it elsewhere with: cavecms push --bundle=${outDir} --to=<target> --token=<token>`))
}

function printSyncStage(resp) {
  const j = resp.json
  if (j && j.ok) {
    const s = j.summary
    log.ok(`Valid: ${s.pages} pages · ${s.posts} posts · ${s.projects} projects · ${s.media} media · ${s.settings} settings`)
    return true
  }
  log.err(`Bundle rejected (${resp.status}):`)
  for (const e of (j && j.errors) || []) console.log(c('red', `  · [${e.scope}] ${e.ref || ''} ${e.reason}${e.detail ? ' — ' + e.detail : ''}`))
  return false
}

async function commandPush(argv) {
  const o = parseSyncArgv(argv, 'push')
  const site = resolveSite(o.site)
  const toUrl = (o.to || process.env.CAVECMS_SYNC_TO || site?.url || '').replace(/\/+$/, '')
  const token = o.token || process.env.CAVECMS_SYNC_TOKEN || site?.token
  if (!toUrl) die('`cavecms push` needs a target site — run `cavecms login`, or pass --to=<url>.')
  if (!token) die('`cavecms push` needs an API token — run `cavecms login`, or pass --token=<api-token>.')
  warnInsecureTransport(toUrl, 'push target')

  let bundleDir
  let tmpDir = null
  if (o.bundle) {
    bundleDir = resolve(o.bundle)
    if (!existsSync(join(bundleDir, 'manifest.json'))) die(`No manifest.json in --bundle dir ${bundleDir}`)
  } else {
    const fromUrl = (o.from || process.env.CAVECMS_SYNC_FROM || '').replace(/\/+$/, '')
    const fromToken = o.fromToken || process.env.CAVECMS_SYNC_FROM_TOKEN || token
    if (!fromUrl) die('`cavecms push` requires --from=<source-url> or --bundle=<dir>')
    warnInsecureTransport(fromUrl, 'push source')
    tmpDir = join(tmpdir(), 'cavecms-push-' + randomBytes(6).toString('hex'))
    mkdirSync(tmpDir, { recursive: true })
    // Reap the temp bundle dir on ANY exit — including a die()/process.exit from
    // a failed media download inside assembleSyncBundle, which would bypass the
    // try/catch + finally cleanup below and leak the dir into the OS tmpdir.
    process.once('exit', () => {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    })
    bundleDir = tmpDir
    log.info(`Assembling bundle from ${fromUrl} …`)
    try {
      await assembleSyncBundle({ fromUrl, fromToken, outDir: bundleDir })
    } catch (e) {
      rmSync(tmpDir, { recursive: true, force: true }) // clean up on assemble failure
      throw e
    }
  }

  const tgz = join(tmpdir(), `cavecms-push-${randomBytes(6).toString('hex')}.tgz`)
  process.once('exit', () => {
    try { rmSync(tgz, { force: true }) } catch { /* best-effort */ }
  })
  try {
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'))
    const tar = spawnSync('tar', ['-czf', tgz, '-C', bundleDir, 'manifest.json', 'content', 'media'], { encoding: 'utf8' })
    if (tar.status !== 0) die(`tar failed: ${tar.stderr || tar.status}`)
    const tgzBuf = readFileSync(tgz)
    const targetHash = (await syncGetJson(`${toUrl}/api/cms/sync/hash`, token)).contentHash

    if (o.dryRun) {
      log.info(`Dry run — validating against ${toUrl} (no writes) …`)
      const resp = await syncPostBundle(`${toUrl}/api/cms/sync/stage?validateOnly=1`, token, tgzBuf)
      const ok = printSyncStage(resp)
      console.log(c('gray', `  bundle sha: ${manifest.contentHash}`))
      console.log(c('gray', `  target sha: ${targetHash}${targetHash === manifest.contentHash ? ' (identical — nothing to push)' : ''}`))
      if (!ok) process.exitCode = 1
      log.ok('Dry run complete — nothing was written.')
      return
    }

    log.info(`Staging to ${toUrl} …`)
    const staged = await syncPostBundle(`${toUrl}/api/cms/sync/stage`, token, tgzBuf)
    if (staged.status !== 200 || !staged.json || !staged.json.ok) {
      printSyncStage(staged)
      die(`Stage failed (${staged.status}).`)
    }
    const stageId = staged.json.stageId
    log.ok(`Staged ${stageId.slice(0, 8)}… — cutting over …`)

    // The drift baseline lives server-side (stored at stage time from the
    // bundle manifest); we only send stageId + force. A bundle whose baseline
    // doesn't match the live target (e.g. a fresh local→prod push) comes back
    // drift_detected → the operator re-runs with --force to overwrite.
    let cut
    try {
      cut = await syncPostJson(`${toUrl}/api/cms/sync/cutover`, token, { stageId, force: !!o.force })
    } catch (err) {
      // A timeout / connection drop does NOT abort the in-flight DB transaction
      // — the swap may have committed (or still be committing). Decide from the
      // PRE-PUSH baseline (`targetHash`), not the source manifest: a successfully
      // applied target re-exports to a hash that can differ from the bundle's by
      // sanitization / cross-version block-schema defaults, so matching only the
      // manifest would falsely report "did not apply". Poll a few times (with a
      // short delay) to let an in-flight swap finish, and use a NON-FATAL probe
      // so a transient 5xx on the recovery check can't itself hard-exit.
      log.warn(`Cutover request interrupted (${err.message}); re-checking the target…`)
      let after = null
      for (let i = 0; i < 5; i++) {
        await sleep(i === 0 ? 1500 : 3000)
        after = await probeTargetHash(toUrl, token)
        if (after && after === manifest.contentHash) break
        if (after && after !== targetHash) break // changed → applied; stop early
      }
      if (after && after === manifest.contentHash) {
        log.ok(`Target now matches the pushed content (sha ${manifest.contentHash}). The cutover landed despite the interruption.`)
        return
      }
      if (after && after !== targetHash) {
        log.ok(
          `The target content CHANGED (sha ${after.slice(0, 12)}…) — the cutover very likely applied ` +
            `(its re-exported hash can differ from the source by sanitization defaults). Verify the live site; do NOT blindly re-push.`,
        )
        return
      }
      if (after === null) {
        die(`Cutover interrupted and the target could not be re-probed. Check ${toUrl}, then re-run the push only if its content is unchanged.`)
      }
      die(`Cutover interrupted and the target is UNCHANGED (still sha ${targetHash.slice(0, 12)}…) — it did not apply. Re-run the push.`)
    }
    if (cut.status === 409 && cut.json && cut.json.reason === 'drift_detected') {
      die(`Refused: ${toUrl} changed since this bundle was built (drift).\n  Re-pull/rebuild the bundle, or re-run with --force to overwrite.`)
    }
    if (cut.status !== 200 || !cut.json || !cut.json.ok) {
      die(`Cutover failed (${cut.status}): ${cut.json ? cut.json.reason || JSON.stringify(cut.json) : 'no response'}`)
    }
    const s = cut.json.swapped
    log.ok(`Published to ${toUrl}: ${s.pages} pages · ${s.posts} posts · ${s.projects} projects · ${s.settings} settings`)
    console.log(c('gray', `  content sha: ${cut.json.contentHash}`))
    console.log(c('gray', `  pre-cutover snapshot (manual restore): ${cut.json.backupArtifact}`))
  } finally {
    rmSync(tgz, { force: true })
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function runSubcommand(sub, argv) {
  if (sub === 'update') return commandUpdate(argv)
  if (sub === 'rollback') return commandRollback(argv)
  if (sub === 'version') return commandVersion(argv)
  if (sub === 'status') return commandStatus(argv)
  if (sub === 'backup') return commandBackup(argv)
  if (sub === 'restore') return commandRestore(argv)
  if (sub === 'backups') return commandListBackups(argv)
  if (sub === 'login') return commandLogin(argv)
  if (sub === 'logout') return commandLogout(argv)
  if (sub === 'whoami') return commandWhoami(argv)
  if (sub === 'pull') return commandPull(argv)
  if (sub === 'push') return commandPush(argv)
  die(`Unknown command: ${sub}`)
}

// Build the narrow child env a backup/restore orchestrator needs — same
// allowlist + surface detection as runOrchestrator, plus the backup-specific
// paths. Returns { childEnv, surface, scriptPath, sharedLockPath }.
function buildBackupChildEnv({ dir, envPath, env, script, statusFilename, statusEnvVar }) {
  const scriptPath = join(dir, 'scripts', script)
  if (!existsSync(scriptPath)) {
    die(
      `Backup engine missing at ${scriptPath}.\n` +
        `  The install tree looks incomplete. Reinstall: npx create-cavecms@latest --dir ${dir}`,
    )
  }
  const surface = detectInstallSurface(dir, env)
  const childEnv = {}
  for (const k of ORCHESTRATOR_ENV_ALLOWLIST) {
    if (typeof process.env[k] === 'string') childEnv[k] = process.env[k]
    if (typeof env[k] === 'string') childEnv[k] = env[k]
  }
  childEnv.CAVECMS_REPO_DIR = dir
  childEnv.CAVECMS_ENV_FILE = envPath
  if (typeof env.UPLOADS_ROOT === 'string') childEnv.UPLOADS_ROOT = env.UPLOADS_ROOT
  if (typeof env.CAVECMS_BACKUP_DIR === 'string') childEnv.CAVECMS_BACKUP_DIR = env.CAVECMS_BACKUP_DIR
  else childEnv.CAVECMS_BACKUP_DIR = join(dir, 'backups')
  // Backup encryption recipient + retention — from the shell env (advanced
  // `CAVECMS_BACKUP_AGE_RECIPIENT=age1… cavecms backup`) OR env.production.
  // Without forwarding these, the bash age path / custom retention is dead.
  const ageRecip = process.env.CAVECMS_BACKUP_AGE_RECIPIENT || env.CAVECMS_BACKUP_AGE_RECIPIENT
  if (ageRecip) childEnv.CAVECMS_BACKUP_AGE_RECIPIENT = ageRecip
  const keep = process.env.CAVECMS_BACKUP_KEEP || env.CAVECMS_BACKUP_KEEP
  if (keep) childEnv.CAVECMS_BACKUP_KEEP = keep
  const port = env.PORT || '3040'
  childEnv.CAVECMS_HEALTHZ_URL = `http://127.0.0.1:${port}/healthz`
  childEnv.CAVECMS_RESTART_MODE = surface === 'vps' ? 'systemd' : surface
  if (surface === 'vps') childEnv.CAVECMS_SYSTEMD_UNIT = 'cavecms.service'
  if (surface === 'pm2') {
    const { pm2AppName, pm2Home } = readPm2Config(dir)
    if (pm2AppName) childEnv.CAVECMS_PM2_APP_NAME = pm2AppName
    if (pm2Home) childEnv.PM2_HOME = pm2Home
  }
  const stateDir = env.CAVECMS_STATE_DIR || join(dir, '.cavecms-state')
  if (!childEnv.CAVECMS_STATE_DIR) childEnv.CAVECMS_STATE_DIR = stateDir
  childEnv[statusEnvVar] = join(stateDir, statusFilename)
  // Shared op lock = the updater's lock, so backup/update/restore are mutually
  // exclusive on one install.
  const sharedLockPath = `${join(stateDir, 'update-status.json')}.lock`
  return { childEnv, surface, scriptPath, sharedLockPath }
}

// Refuse if an update/backup/restore is already running (the bash O_EXCL acquire
// is authoritative; this is a fast pre-check so the CLI fails clearly instead of
// the bash silently exiting on contention). Reuses lockIsStaleCli so a wedged
// prior run doesn't block recovery forever.
function assertNoOpInProgress(sharedLockPath, updateStatusPath, mode) {
  if (!existsSync(sharedLockPath)) return
  if (lockIsStaleCli(sharedLockPath, updateStatusPath)) return
  die(
    `Another update, backup, or restore is already running on this install. ` +
      `Wait for it to finish, then re-run \`cavecms ${mode}\`.`,
  )
}

// Resolve the runtime user that OWNS the install (so a root CLI run can hand
// ownership of new artefacts back to it — otherwise the dashboard, running as
// that user, can't read root-owned mode-600 archives).
function resolveRuntimeUser(surface, env) {
  if (surface === 'pm2') return env.CAVECMS_PM2_USER || process.env.CAVECMS_PM2_USER || 'www-data'
  if (surface === 'vps') {
    let u = process.env.SUDO_USER || 'cavecms'
    try {
      const r = spawnSync('systemctl', ['show', '-p', 'User', '--value', 'cavecms.service'], { encoding: 'utf8' })
      if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) u = r.stdout.trim()
    } catch { /* keep default */ }
    return u
  }
  return null
}

function spawnBackupEngine({ dir, scriptPath, childEnv, args, mode, surface, backupDir }) {
  const r = spawnSync('bash', [scriptPath, ...args], {
    cwd: dir,
    stdio: 'inherit',
    env: childEnv,
    timeout: 60 * 60 * 1000,
    killSignal: 'SIGTERM',
  })
  if (r.error) die(`Couldn't run the ${mode} engine: ${r.error.message}`)
  if (r.signal) {
    die(
      `The ${mode} engine was stopped by ${r.signal} (often the out-of-memory killer or an external stop). ` +
        (mode === 'restore'
          ? "Your site may be in maintenance mode and partially restored — re-run `cavecms restore` (it rolls back on failure), then check `cavecms status`."
          : 'No backup was written.'),
    )
  }
  // Root CLI backup on a managed surface writes a mode-600 root-owned archive
  // into a runtime-user-owned dir → hand ownership back so the dashboard
  // (running as that user) can list/download/restore it.
  const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0
  if (r.status === 0 && mode === 'backup' && isRoot && backupDir && (surface === 'vps' || surface === 'pm2')) {
    const runUser = resolveRuntimeUser(surface, childEnv)
    if (runUser) {
      spawnSync('chown', ['-R', `${runUser}:${runUser}`, backupDir], { stdio: 'ignore' })
    }
  }
  process.exit(r.status ?? 1)
}

async function commandBackup(argv) {
  const opts = parseSubArgv(argv, 'backup')
  const { dir, envPath, env } = resolveInstallDir(opts)
  log.header('CaveCMS backup')
  const { childEnv, scriptPath, surface, sharedLockPath } = buildBackupChildEnv({
    dir,
    envPath,
    env,
    script: 'cavecms-backup.sh',
    statusFilename: 'backup-status.json',
    statusEnvVar: 'CAVECMS_BACKUP_STATUS_PATH',
  })
  assertNoOpInProgress(sharedLockPath, childEnv.CAVECMS_UPDATE_STATUS_PATH || join(childEnv.CAVECMS_STATE_DIR, 'update-status.json'), 'backup')
  if (opts.includeEnv) {
    const hasAge =
      spawnSync('command', ['-v', 'age'], { shell: '/bin/bash', stdio: 'ignore' }).status === 0
    if (!hasAge && !opts.insecurePlaintextEnv) {
      die(
        '--include-env writes your secrets (incl. the encryption + session keys) into the backup.\n' +
          "  'age' isn't installed, so the archive would be UNENCRYPTED. Install age to encrypt it,\n" +
          '  or re-run with --insecure-plaintext-env if you understand the risk and will keep the file safe.',
      )
    }
    childEnv.CAVECMS_BACKUP_INCLUDE_ENV = '1'
  }
  spawnBackupEngine({ dir, scriptPath, childEnv, args: [], mode: 'backup', surface, backupDir: childEnv.CAVECMS_BACKUP_DIR })
}

async function commandRestore(argv) {
  const opts = parseSubArgv(argv, 'restore')
  const { dir, envPath, env } = resolveInstallDir(opts)
  if (!opts.archive) die('restore needs a backup file: cavecms restore --archive /path/to/cavecms-backup-*.tar.gz')
  const archive = resolve(opts.archive)
  if (!existsSync(archive)) die(`Backup file not found: ${archive}`)
  log.header('CaveCMS restore')
  log.warn('Restore REPLACES this site’s content + media with the backup’s contents.')
  log.gray('  A safety snapshot is taken first; on any failure the restore rolls back automatically.')
  if (!opts.yes) {
    const ok = await withReadline(async (rl) =>
      ask(rl, 'Type "restore" to proceed', {
        validate: (v) => (v === 'restore' ? null : 'Type the word restore to confirm, or Ctrl-C to cancel.'),
      }),
    )
    if (ok !== 'restore') die('Cancelled.')
  }
  const { childEnv, scriptPath, surface, sharedLockPath } = buildBackupChildEnv({
    dir,
    envPath,
    env,
    script: 'cavecms-restore.sh',
    statusFilename: 'restore-status.json',
    statusEnvVar: 'CAVECMS_RESTORE_STATUS_PATH',
  })
  assertNoOpInProgress(sharedLockPath, childEnv.CAVECMS_UPDATE_STATUS_PATH || join(childEnv.CAVECMS_STATE_DIR, 'update-status.json'), 'restore')
  childEnv.CAVECMS_RESTORE_ARCHIVE = archive
  if (opts.identity) childEnv.CAVECMS_RESTORE_IDENTITY = resolve(opts.identity)
  if (opts.restoreEnv) childEnv.CAVECMS_RESTORE_ENV = '1'
  spawnBackupEngine({ dir, scriptPath, childEnv, args: [], mode: 'restore', surface, backupDir: childEnv.CAVECMS_BACKUP_DIR })
}

async function commandListBackups(argv) {
  const opts = parseSubArgv(argv, 'backups')
  const { dir, env } = resolveInstallDir(opts)
  const backupDir = env.CAVECMS_BACKUP_DIR || join(dir, 'backups')
  log.header('CaveCMS backups')
  if (!existsSync(backupDir)) {
    log.info('No backups yet.')
    return
  }
  const files = readdirSync(backupDir)
    .filter((f) => /^cavecms-backup-.*\.tar\.gz(\.age)?$/.test(f))
    .map((f) => ({ f, mtime: statSync(join(backupDir, f)).mtimeMs, size: statSync(join(backupDir, f)).size }))
    .sort((a, b) => b.mtime - a.mtime)
  if (files.length === 0) {
    log.info('No backups yet.')
    return
  }
  for (const { f, size } of files) {
    const enc = f.endsWith('.age') ? ' (encrypted)' : ''
    let ver = ''
    if (!f.endsWith('.age')) {
      try {
        const out = spawnSync('tar', ['-xzO', '-f', join(backupDir, f), 'manifest.json'], { encoding: 'utf8' })
        if (out.status === 0) ver = ` v${JSON.parse(out.stdout).cavecms?.version ?? '?'}`
      } catch { /* unreadable manifest — skip version */ }
    }
    const mb = (size / (1024 * 1024)).toFixed(1)
    log.gray(`  ${f}${ver}  (${mb} MB)${enc}`)
  }
  log.info(`Restore one with:  cavecms restore --archive ${join(backupDir, files[0].f)}`)
}

// Install the `cavecms` recovery shim into the install dir + (best
// effort) onto PATH at /usr/local/bin/cavecms.
//
// Engine sourcing strategy:
//   - update/status/version → `npx create-cavecms@latest` (fresh logic; a
//     broken local app tree can't break recovery — ceymail decouples via a
//     system binary, we via npm).
//   - rollback → run the BUNDLED engine copy (in the update-surviving state
//     dir) so it works OFFLINE / when npm is unreachable. Rollback is a
//     purely-local snapshot restore that needs no network, and is the
//     primary "get me back online now" affordance. Falls back to npx if the
//     bundled copy is missing.
function installCavecmsShim({ targetDir, stateDir }) {
  // The paths are interpolated raw into double-quoted bash lines below —
  // refuse shell-dangerous paths so the persisted, PATH-exposed, often-sudo'd
  // shim can't be turned into a command-injection sink.
  assertSafeInstallPath(targetDir)
  if (stateDir) assertSafeInstallPath(stateDir)
  const shimPath = join(targetDir, 'cavecms')
  // Bundle this very engine (a self-contained zero-dep ESM file) into the
  // state dir, which survives in-app updates (it's outside the tarball
  // move-aside set) and isn't part of the app build that a bad release could
  // corrupt — so offline `cavecms rollback` keeps working.
  const localEngine = stateDir ? join(stateDir, 'cavecms-cli.mjs') : ''
  if (localEngine) {
    try {
      cpSync(__filename, localEngine)
      chmodSync(localEngine, 0o755)
    } catch (err) {
      log.warn(`Couldn't bundle the offline recovery engine: ${err instanceof Error ? err.message : String(err)} (rollback will require npm)`)
    }
  }
  // Bundle the zero-dep backup-archive validator into the state dir too, so
  // offline `cavecms restore` can validate an archive (manifest + checksum +
  // zip-slip + compat) even when the app build tree is corrupt. The restore
  // orchestrator prefers <stateDir>/backup-lib.mjs, then <repo>/scripts/backup.
  if (stateDir) {
    try {
      const srcLib = join(targetDir, 'scripts', 'backup', 'backup-lib.mjs')
      if (existsSync(srcLib)) {
        cpSync(srcLib, join(stateDir, 'backup-lib.mjs'))
        chmodSync(join(stateDir, 'backup-lib.mjs'), 0o755)
      }
    } catch (err) {
      log.warn(`Couldn't bundle the offline backup validator: ${err instanceof Error ? err.message : String(err)} (restore will use the in-tree copy)`)
    }
  }
  const localEngineLine = localEngine
    ? `LOCAL_ENGINE="${localEngine}"`
    : `LOCAL_ENGINE=""`
  const shim = `#!/bin/bash
# CaveCMS recovery CLI shim.
#   cavecms update [--check] [--force] [--version=X.Y.Z]   pull + apply a release
#   cavecms rollback                     restore the previous version (works offline)
#   cavecms backup [--include-env]       make a backup of content + media (+ optional secrets)
#   cavecms backups                      list local backups
#   cavecms restore --archive <file> [--identity <age-key>] [--restore-env] [--yes]
#   cavecms pull --from <url> --token <tok> [--out <dir>]   download content into a bundle
#   cavecms push --to <url> --token <tok> [--from <url> --from-token <tok> | --bundle <dir>] [--dry-run] [--force]
#   cavecms status | version | help
#
# Prefer the BUNDLED engine (a self-contained zero-dep copy in the state dir,
# outside the app build a bad release could corrupt) for ALL commands: it works
# offline, needs no npm cache, and runs cleanly under \`sudo -u <runuser>\` on
# pm2 installs (where the nologin runtime user can't run npx). Fall back to
# \`npx create-cavecms@latest\` only when the bundled copy is missing. The actual
# release download still goes over the release host via wget, not npm. For the
# absolutely-latest CLI logic, run \`npx create-cavecms@latest <cmd>\` directly.
set -euo pipefail
cd "${targetDir}" || { echo "CaveCMS install dir missing: ${targetDir}" >&2; exit 1; }
${localEngineLine}
if [ -n "\$LOCAL_ENGINE" ] && [ -f "\$LOCAL_ENGINE" ]; then
  exec node "\$LOCAL_ENGINE" "\$@"
fi
exec npx --yes create-cavecms@latest "\$@"
`
  try {
    writeFileSync(shimPath, shim, { mode: 0o755 })
    chmodSync(shimPath, 0o755)
  } catch (err) {
    log.warn(`Couldn't write the cavecms CLI shim: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const globalPath = '/usr/local/bin/cavecms'
  const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0
  const canSudo = isRoot || spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0
  let linked = false
  // Never clobber another install's global shim silently.
  if (canSudo && !existsSync(globalPath)) {
    const r = runSudo(['ln', '-sf', shimPath, globalPath])
    linked = r.status === 0
  }
  console.log('')
  if (linked) {
    log.ok(`Recovery CLI ready: ${c('bold', 'cavecms update')} / ${c('bold', 'cavecms rollback')} (from anywhere).`)
  } else {
    log.info('Recovery CLI (run from the install dir, or put it on your PATH):')
    log.gray(`  ${shimPath} update        # pull + apply the latest release`)
    log.gray(`  ${shimPath} rollback      # restore the previous version`)
    log.gray(`  On PATH:  sudo ln -sf ${shimPath} /usr/local/bin/cavecms`)
  }
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

  // --detect-only: a dry run that resolves the deployment surface
  // (detect → confirm / loud log, or an explicit --surface=) and exits
  // WITHOUT downloading or installing anything. Lets an operator preview
  // which setup CaveCMS will pick, and lets us exercise the detection +
  // confirmation gate locally without a full install. Runs before the
  // dependency pre-flight so it works on a box missing wget/unzip.
  if (args.detectOnly) {
    const resolved = await resolveSurface(args)
    log.ok(`Resolved setup: ${SURFACE_DESCRIPTIONS[resolved]}`)
    log.gray('(dry run — nothing was downloaded or installed)')
    return
  }

  preflightDeps()

  // 1. Surface detect → (interactive) confirm gate / (non-interactive) loud log.
  const surface = await resolveSurface(args)
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
  // --dir bypasses SITE_NAME_RE; reject shell-dangerous install paths before
  // any sudo chown/symlink work or the shim write touches them.
  assertSafeInstallPath(targetDir)

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
    const { envPath, uploadsRoot, stateDir } = writeSealedEnv({
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

    // Drop the `cavecms` recovery CLI shim so the operator can
    // update/roll back from the shell even if the dashboard is later
    // unreachable. Done BEFORE startService because the laptop surface's
    // foreground start never returns.
    installCavecmsShim({ targetDir, stateDir })

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

// Run the CLI ONLY when this file is the process entry point — never when a
// test (or any other module) `import`s it for its exported helpers. The npm
// `.bin` shim is a SYMLINK to this file, so we compare realpath'd paths (an
// `import.meta.url === argv[1]` check would mismatch through that symlink and
// silently refuse to install). realpathSync resolves both the shim symlink and
// any nvm path-canonicalisation to the same inode path.
function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(__filename)
  } catch {
    // argv[1] not statable (rare) — fall back to a plain path compare so the
    // installer never fails CLOSED (refusing to run is worse than the tiny
    // chance of a false-positive in a non-test context).
    return entry === __filename
  }
}

// Entry router. `npx create-cavecms <site>` installs; the reserved
// first words route to the recovery subcommands instead. `help` / -h /
// --help always show usage (so the `cavecms help` shim works without
// trying to install a site literally named "help").
if (invokedDirectly()) {
  const _argv = process.argv.slice(2)
  const _sub = _argv[0]
  let _run
  // Bare `cavecms` (the recovery shim with no args) or an explicit help flag →
  // show usage. Treating a missing first arg as help stops the recovery shim
  // from silently dropping into a NEW-site install prompt.
  if (!_sub || _sub === 'help' || _sub === '-h' || _sub === '--help') {
    showHelp()
    _run = Promise.resolve()
  } else if (RECOVERY_SUBCOMMANDS.has(_sub)) {
    _run = runSubcommand(_sub, _argv.slice(1))
  } else {
    _run = main(_argv)
  }
  _run.catch((err) => {
    log.err(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  })
}

// Test-only surface: the retry/transient helpers are pure enough to unit-test
// against a real local http server. Exporting them does NOT change the CLI's
// runtime behaviour (the entry router above is gated on invokedDirectly()).
export { syncRequestRetry, isTransientStatus, syncRequest }
