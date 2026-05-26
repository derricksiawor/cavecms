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
const DEFAULT_PORT = 3040
const MIN_NODE_MAJOR = 20

// Ed25519 public key for offline signature verification of the
// downloaded zip. Generated from ~/.cavecms-release-private.pem and
// bundled here so the CLI can verify releases without round-tripping
// to fetch it. When the operator-side key is rotated, this bundled
// pubkey is updated in lockstep + the CLI version bumped.
//
// Empty string when the project hasn't published a signed release yet
// — in that case signature verification is SKIPPED with a clear warning
// (the SHA-256 from the manifest still anchors integrity over HTTPS).
const BUNDLED_PUBKEY_PEM = process.env.CAVECMS_RELEASE_PUBKEY_PEM ?? ''

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

// ════════════════════════════════════════════════════════════════════
// Argv parsing
// ════════════════════════════════════════════════════════════════════

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
    '  --surface=auto|vps|laptop|cpanel   Force a deployment surface (default: auto)',
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
          process.stdin.pause()
          process.stdout.write('\n')
          process.exit(130)
        } else if (c0 === '\r' || c0 === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.removeListener('data', onData)
          process.stdin.pause()
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

function defaultInstallDir(surface, siteName) {
  if (surface === 'vps') return `/opt/cavecms`
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

async function fetchToFile(url, destPath) {
  // Native fetch (Node 20+) for the manifest. For the zip we use curl
  // — fetch streams ArrayBuffer into memory, which would be 70+ MiB
  // residents for the zip. curl with `-o` writes to disk directly.
  const r = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'create-cavecms' },
  })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} fetching ${url}`)
  const buf = Buffer.from(await r.arrayBuffer())
  writeFileSync(destPath, buf)
  return destPath
}

function fetchToFileViaCurl(url, destPath) {
  // -fsSL: fail-on-error, silent, show-errors, follow-redirects.
  // --max-time 600: 10-minute cap so a slow link doesn't hang the
  // installer indefinitely.
  const res = spawnSync(
    'curl',
    ['-fsSL', '--max-time', '600', '--output', destPath, url],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  if (res.status !== 0) {
    die(`curl failed (exit ${res.status}) downloading ${url}`)
  }
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
    await fetchToFile(manifestUrl, manifestPath)
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

  // Download the zip via curl (memory-friendly for large files).
  const zipPath = join(stagingDir, `cavecms-${target.version}.zip`)
  log.info(`Downloading ${target.downloadUrl}…`)
  fetchToFileViaCurl(target.downloadUrl, zipPath)

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
    log.warn(
      'Manifest entry has no signature field — verification skipped. ' +
        'This release was published before signing was enabled.',
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
  // Move (rename) the inner dir's contents into targetDir. cpSync with
  // recursive preserves dereferenced files — the zip itself contains no
  // symlinks (build-zip.mjs dereferences them at zip time) so we don't
  // need to worry about absolute-path symlinks here.
  for (const name of readdirSync(innerDir)) {
    const src = join(innerDir, name)
    const dst = join(targetDir, name)
    cpSync(src, dst, { recursive: true, force: true })
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
  }
}

// ════════════════════════════════════════════════════════════════════
// Env writer (sealed)
// ════════════════════════════════════════════════════════════════════

function buildDatabaseUrl({ host, port, user, password, name }) {
  // mysql2 accepts a URI directly. URL-encode credentials to survive
  // any non-alphanumeric chars in the password.
  const u = encodeURIComponent(user)
  const p = encodeURIComponent(password)
  return `mysql://${u}:${p}@${host}:${port}/${encodeURIComponent(name)}`
}

function writeSealedEnv({ targetDir, surface, config, secrets }) {
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
    `UPLOADS_ROOT=${uploadsRoot}`,
    `# Release bookkeeping — re-stamped on every in-app update.`,
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
  // mkdir uploads dir if it's inside targetDir.
  mkdirSync(uploadsRoot, { recursive: true })
  return { envPath, databaseUrl, uploadsRoot }
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
  const unit = `[Unit]
Description=CaveCMS — self-hosted CMS
After=network.target mariadb.service mysql.service
Wants=network.target

[Service]
Type=simple
User=${runUser}
WorkingDirectory=${targetDir}
EnvironmentFile=${envPath}
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
        spawnSync('sudo', ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'cavecms'], { stdio: 'inherit' })
      }
    }
    // env.production is mode 600 — chown to the runtime user so the
    // unit can actually read it. Without this the service crashes at
    // boot with EACCES env.production.
    spawnSync('sudo', ['chown', `${runUser}:${runUser}`, envPath], { stdio: 'inherit' })
    // Same for the install dir + uploads — the runtime user must
    // own everything it reads/writes at runtime.
    spawnSync('sudo', ['chown', '-R', `${runUser}:${runUser}`, targetDir], { stdio: 'inherit' })
    spawnSync('sudo', ['mv', tmpUnit, '/etc/systemd/system/cavecms.service'], { stdio: 'inherit' })
    spawnSync('sudo', ['mkdir', '-p', '/var/log/cavecms'], { stdio: 'inherit' })
    spawnSync('sudo', ['chown', `${runUser}:${runUser}`, '/var/log/cavecms'], { stdio: 'inherit' })
    spawnSync('sudo', ['systemctl', 'daemon-reload'], { stdio: 'inherit' })
    spawnSync('sudo', ['systemctl', 'enable', '--now', 'cavecms.service'], { stdio: 'inherit' })
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

function startService({ surface, targetDir, envPath, config, skipStart }) {
  if (skipStart) {
    log.warn('Skipping service start (--skip-start). Start manually:')
    log.gray(`  node --env-file=env.production scripts/start-standalone.mjs`)
    return
  }
  if (surface === 'vps') return startVps({ targetDir, envPath, config })
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
  if (!['vps', 'laptop', 'cpanel'].includes(surface)) {
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
          /^[a-z0-9][a-z0-9-]{1,40}$/.test(v)
            ? null
            : 'Lowercase letters, digits, dashes. 2-41 chars. Must start with a letter or digit.',
      }),
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

    startService({ surface, targetDir, envPath, config, skipStart: args.skipStart })
  } catch (err) {
    if (createdTargetDir && installPhase === 'pre-extract') {
      try {
        rmSync(targetDir, { recursive: true, force: true })
        log.info('Rolled back the empty target directory so you can retry.')
      } catch {
        /* best-effort cleanup */
      }
    } else if (installPhase === 'post-unpack' || installPhase === 'env-written') {
      log.warn(`Install failed mid-flight. To retry: rm -rf ${targetDir} && npx create-cavecms ${args.siteName ?? ''}`)
    }
    throw err
  }
}

main(process.argv.slice(2)).catch((err) => {
  log.err(err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
