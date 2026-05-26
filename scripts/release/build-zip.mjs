#!/usr/bin/env node
// scripts/release/build-zip.mjs
//
// Build a signed CaveCMS release artifact (cavecms-X.Y.Z.zip) for distribution
// via cavecms.derricksiawor.com. Run from the repo root via `pnpm release:build`.
//
// What it does, in order:
//   1. Resolve the version (--version=X.Y.Z OR package.json's `version`)
//   2. Verify the repo is clean-ish (warn — not block — on uncommitted changes)
//   3. Run `pnpm build` to produce .next/standalone + .next/static
//      (skipped with --skip-build if you've already built)
//   4. Assemble a staging tree under dist/staging/cavecms-X.Y.Z/ containing
//      the runtime, migrations, ops scripts, and metadata files
//   5. Zip the staging tree into dist/cavecms-X.Y.Z.zip
//   6. Compute SHA-256, write .sha256 next to the zip
//   7. Sign the zip with Ed25519 from ~/.cavecms-release-private.pem
//      (skipped with a warning if the key doesn't exist — operator generates
//      the key once via the openssl command in docs/release-pipeline.md)
//   8. Update dist/manifest.json with the new release entry
//      (prepended; `latestVersion` + `publishedAt` bumped)
//   9. Sign the manifest the same way
//
// What it does NOT do:
//   - Upload anything to cavecms.derricksiawor.com (that's release/publish.mjs)
//   - Test-extract the zip (that's release/test-zip.mjs)
//   - Run pnpm test/typecheck/lint (those are gates the operator runs first)
//
// Output:
//   dist/cavecms-X.Y.Z.zip
//   dist/cavecms-X.Y.Z.zip.sha256
//   dist/cavecms-X.Y.Z.zip.sig          (only if signing key exists)
//   dist/manifest.json
//   dist/manifest.json.sig              (only if signing key exists)

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(__filename), '..', '..')
const DIST_DIR = join(REPO_ROOT, 'dist')
const STAGING_PARENT = join(DIST_DIR, 'staging')
const SIGNING_KEY_PATH = process.env.CAVECMS_RELEASE_PRIVATE_KEY
  ?? join(homedir(), '.cavecms-release-private.pem')

const args = parseArgs(process.argv.slice(2))

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
}
const isTty = process.stdout.isTTY
const c = (color, text) => (isTty ? `${COLORS[color]}${text}${COLORS.reset}` : text)
const log = {
  header: (msg) => {
    const bar = '━'.repeat(63)
    console.log('')
    console.log(c('blue', bar))
    console.log(c('blue', c('bold', `       ${msg}`)))
    console.log(c('blue', bar))
    console.log('')
  },
  step: (n, total, msg) => console.log(c('cyan', `[${n}/${total}]`) + ' ' + msg),
  ok: (msg) => console.log(c('green', '✓') + ' ' + msg),
  warn: (msg) => console.log(c('yellow', '⚠') + ' ' + msg),
  err: (msg) => console.log(c('red', '✗') + ' ' + msg),
  info: (msg) => console.log(c('gray', 'ℹ') + ' ' + msg),
  gray: (msg) => console.log('  ' + c('gray', msg)),
}

function parseArgs(argv) {
  const out = { version: null, skipBuild: false, skipSign: false, help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--skip-build') out.skipBuild = true
    else if (a === '--skip-sign') out.skipSign = true
    else if (a.startsWith('--version=')) out.version = a.slice('--version='.length)
    else if (a.startsWith('--')) {
      console.error(c('red', `Unknown flag: ${a}`))
      process.exit(2)
    }
  }
  return out
}

function showHelp() {
  const text = [
    '',
    'Usage: pnpm release:build [options]',
    '',
    'Options:',
    '  --version=X.Y.Z   Override the version (default: package.json "version")',
    '  --skip-build      Skip the pnpm build step (use the existing .next/standalone)',
    '  --skip-sign       Skip Ed25519 signing even if the key exists',
    '  -h, --help        Show this message',
    '',
    'Examples:',
    '  pnpm release:build',
    '  pnpm release:build --version=1.0.0',
    '  pnpm release:build --skip-build       # iterating on the bundler quickly',
    '',
  ].join('\n')
  console.log(text)
}

if (args.help) {
  showHelp()
  process.exit(0)
}

function runOrFail(cmd, argv, opts = {}) {
  const res = spawnSync(cmd, argv, { cwd: REPO_ROOT, stdio: 'inherit', ...opts })
  if (res.status !== 0) {
    log.err(`${cmd} ${argv.join(' ')} → exit ${res.status}`)
    process.exit(res.status ?? 1)
  }
}

function gitShortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readPkg() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
}

// Strict semver: X.Y.Z(-prerelease)? where prerelease is dot-separated
// alphanumerics. Refuses anything that could carry shell metacharacters
// into downstream publish/install scripts (CVE-class defence).
const SEMVER_RX = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/

function resolveVersion() {
  let v
  if (args.version) v = args.version
  else {
    const pkg = readPkg()
    if (!pkg.version) {
      log.err('No --version given and package.json has no "version" field')
      process.exit(1)
    }
    v = pkg.version
  }
  if (!SEMVER_RX.test(v)) {
    log.err(`Version is not valid semver: ${JSON.stringify(v)}`)
    log.gray('Use X.Y.Z or X.Y.Z-prerelease (alphanumerics + dots only).')
    process.exit(1)
  }
  return v
}

function verifyPrereqs() {
  // zip binary
  try {
    execSync('command -v zip', { stdio: 'ignore' })
  } catch {
    log.err('`zip` is not installed. macOS: ships with the OS. Linux: apt install zip / dnf install zip')
    process.exit(1)
  }
  // git clean check (warn, do not block — release builds during dev are normal)
  try {
    const dirty = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    if (dirty) {
      log.warn('Uncommitted changes in the working tree — the zip will reflect WIP state.')
      const lines = dirty.split('\n').slice(0, 8)
      for (const l of lines) log.gray(l)
      if (dirty.split('\n').length > 8) log.gray(`… and ${dirty.split('\n').length - 8} more`)
    }
  } catch {
    // not a git checkout, fine
  }
}

function rebuildIfNeeded() {
  const standalone = join(REPO_ROOT, '.next', 'standalone', 'server.js')
  if (args.skipBuild) {
    if (!existsSync(standalone)) {
      log.err('--skip-build given but .next/standalone/server.js is missing. Run without --skip-build.')
      process.exit(1)
    }
    log.info('Skipping build (--skip-build) — using existing .next/standalone')
    return
  }
  log.info('Running `pnpm build` (this can take a few minutes)…')
  runOrFail('pnpm', ['build'])
  if (!existsSync(standalone)) {
    log.err('pnpm build completed but .next/standalone/server.js does not exist. Aborting.')
    process.exit(1)
  }
}

// What ships in the zip. Standalone build inlines runtime node_modules; we add
// the assets/scripts/metadata it can't infer.
//
// Each entry is { src, dst, optional } — src relative to repo root, dst relative
// to staging root (which is named cavecms-X.Y.Z).
function manifestOfFiles(version) {
  return [
    // The Next.js standalone server (inlines all production node_modules).
    // Standalone contains symlinks pointing at absolute repo paths (public,
    // .next/static, node_modules/next, etc.) — we dereference them so the
    // zip carries real files and unpacks correctly on any machine.
    { src: '.next/standalone', dst: '.', dir: true, dereference: true, skipPublicUploads: true },
    // Static assets — standalone's .next/static symlink only exists after
    // a prior `pnpm start` populated it. Add it explicitly so a fresh CI
    // build (no prior start) still produces a complete zip. `force:true`
    // merges with whatever the standalone dereference already wrote.
    { src: '.next/static', dst: '.next/static', dir: true },
    // Same defensive copy for public/ — fresh builds may not have the
    // standalone/public symlink. NOTE: /public/uploads is operator-managed
    // and excluded by the filter (no media in shipped zips).
    { src: 'public', dst: 'public', dir: true, skipPublicUploads: true },
    // Drizzle SQL migrations the CLI / wizard applies on first boot.
    { src: 'db/migrations', dst: 'db/migrations', dir: true },
    // Schema fingerprint — instrumentation.ts reads cwd/db/schema-fingerprint.txt
    // at boot and fatals out if missing. Standalone needs this at its own cwd.
    { src: 'db/schema-fingerprint.txt', dst: 'db/schema-fingerprint.txt' },
    // Ops scripts the operator install needs.
    { src: 'scripts/cavecms-update.sh', dst: 'scripts/cavecms-update.sh' },
    { src: 'scripts/cavecms-updates-check.sh', dst: 'scripts/cavecms-updates-check.sh' },
    { src: 'scripts/install-nginx.sh', dst: 'scripts/install-nginx.sh' },
    { src: 'scripts/install-systemd.sh', dst: 'scripts/install-systemd.sh' },
    { src: 'scripts/install-migrate.mjs', dst: 'scripts/install-migrate.mjs' },
    { src: 'scripts/start-standalone.mjs', dst: 'scripts/start-standalone.mjs' },
    // Nginx + systemd templates the install scripts apply.
    { src: 'scripts/nginx', dst: 'scripts/nginx', dir: true, optional: true },
    { src: 'scripts/systemd', dst: 'scripts/systemd', dir: true, optional: true },
    // PM2 ecosystem config (the legacy non-systemd path).
    { src: 'ecosystem.config.cjs', dst: 'ecosystem.config.cjs' },
    // Metadata files.
    { src: 'LICENSE.md', dst: 'LICENSE.md' },
    { src: 'AGENTS.md', dst: 'AGENTS.md' },
    { src: 'README.md', dst: 'README.md' },
  ]
}

function assembleStaging(version) {
  const stagingName = `cavecms-${version}`
  const stagingDir = join(STAGING_PARENT, stagingName)

  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true })
  }
  mkdirSync(stagingDir, { recursive: true })

  const items = manifestOfFiles(version)
  let copied = 0
  let skipped = 0
  for (const item of items) {
    const src = join(REPO_ROOT, item.src)
    const dst = join(stagingDir, item.dst)
    if (!existsSync(src)) {
      if (item.optional) {
        skipped++
        continue
      }
      log.err(`Required source missing: ${item.src}`)
      process.exit(1)
    }
    mkdirSync(dirname(dst), { recursive: true })
    if (item.dir) {
      cpSync(src, dst, {
        recursive: true,
        force: true,
        // Standalone contains symlinks to absolute paths — must dereference
        // so the zip carries real bytes, not symlinks pointing at /Users/...
        dereference: Boolean(item.dereference),
        // errorOnExist false (default) — we merge on top of existing dirs
        // when the standalone copy already wrote there.
        filter: (s) => {
          if (item.skipPublicUploads && /\/public\/uploads(\/|$)/.test(s)) return false
          return true
        },
      })
    } else {
      cpSync(src, dst, { force: true })
    }
    copied++
  }

  // Write a slimmed package.json that lists only what the runtime needs
  // (the standalone build already inlined production deps, so we mainly
  // ship metadata + the bin/script entries the operator + CLI invoke).
  const fullPkg = readPkg()
  const slimPkg = {
    name: fullPkg.name,
    version,
    private: true,
    type: fullPkg.type,
    license: fullPkg.license,
    author: fullPkg.author,
    description: fullPkg.description,
    homepage: fullPkg.homepage,
    engines: fullPkg.engines,
    scripts: {
      start: 'node scripts/start-standalone.mjs',
    },
    cavecms: {
      version,
      commit: gitShortSha(),
      buildTime: new Date().toISOString(),
    },
  }
  writeFileSync(join(stagingDir, 'package.json'), JSON.stringify(slimPkg, null, 2) + '\n')

  // Write VERSION file the CLI reads to know what was unpacked.
  writeFileSync(join(stagingDir, 'VERSION'), `${version}\n`)

  log.ok(`Staging assembled: ${relative(REPO_ROOT, stagingDir)} (${copied} items copied, ${skipped} optional skipped)`)
  return { stagingDir, stagingName }
}

function makeZip(stagingDir, stagingName, version) {
  if (!existsSync(DIST_DIR)) mkdirSync(DIST_DIR, { recursive: true })
  const zipPath = join(DIST_DIR, `cavecms-${version}.zip`)
  if (existsSync(zipPath)) rmSync(zipPath, { force: true })

  // Use `zip -r` from STAGING_PARENT so the zip's top-level entry is
  // `cavecms-X.Y.Z/...` — what every install path (CLI, manual unzip) expects.
  // -q for quiet, -X strips extra macOS metadata, -r recursive.
  const res = spawnSync('zip', ['-r', '-q', '-X', zipPath, stagingName], {
    cwd: STAGING_PARENT,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    log.err(`zip exited ${res.status}`)
    process.exit(res.status ?? 1)
  }
  const sizeMB = (statSync(zipPath).size / (1024 * 1024)).toFixed(2)
  log.ok(`Zip created: dist/cavecms-${version}.zip (${sizeMB} MiB)`)
  return zipPath
}

function writeSha256(zipPath) {
  const buf = readFileSync(zipPath)
  const hash = createHash('sha256').update(buf).digest('hex')
  const shaPath = zipPath + '.sha256'
  // GNU coreutils format: "<hash>  <filename>\n"
  writeFileSync(shaPath, `${hash}  ${relative(DIST_DIR, zipPath)}\n`)
  log.ok(`SHA-256: ${hash.slice(0, 16)}… → ${relative(REPO_ROOT, shaPath)}`)
  return hash
}

function signEd25519(filePath) {
  if (args.skipSign) {
    log.warn(`Skipping signature for ${relative(REPO_ROOT, filePath)} (--skip-sign)`)
    return null
  }
  if (!existsSync(SIGNING_KEY_PATH)) {
    log.warn(`No signing key at ${SIGNING_KEY_PATH} — skipping signature.`)
    log.gray('Generate one with: openssl genpkey -algorithm ed25519 -out ~/.cavecms-release-private.pem')
    log.gray('Then re-run this script for a signed release.')
    return null
  }
  const keyPem = readFileSync(SIGNING_KEY_PATH, 'utf8')
  let privateKey
  try {
    privateKey = createPrivateKey({ key: keyPem, format: 'pem' })
  } catch (err) {
    log.err(`Could not load signing key at ${SIGNING_KEY_PATH}: ${err.message}`)
    process.exit(1)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    log.err(`Key at ${SIGNING_KEY_PATH} is ${privateKey.asymmetricKeyType}, expected ed25519.`)
    log.gray('Regenerate with: openssl genpkey -algorithm ed25519 -out ~/.cavecms-release-private.pem')
    process.exit(1)
  }
  const payload = readFileSync(filePath)
  // Ed25519 in Node accepts a null digest algorithm (PureEdDSA over the raw
  // message), matching openssl's `pkeyutl -sign -rawin`.
  const sig = cryptoSign(null, payload, privateKey)
  const sigB64 = sig.toString('base64')
  const sigPath = filePath + '.sig'
  writeFileSync(sigPath, sigB64 + '\n')
  log.ok(`Signed: ${relative(REPO_ROOT, sigPath)}`)
  return sigB64
}

function updateManifest({ version, sha256, signature, isSecurity }) {
  const manifestPath = join(DIST_DIR, 'manifest.json')
  let manifest
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      log.err(`Existing manifest.json is invalid JSON: ${err.message}`)
      process.exit(1)
    }
  } else {
    manifest = { latestVersion: '', publishedAt: '', releases: [] }
  }
  manifest.releases = Array.isArray(manifest.releases) ? manifest.releases : []

  // Drop any prior entry for the same version (idempotent rebuilds during dev).
  manifest.releases = manifest.releases.filter((r) => r.version !== version)

  const publishedAt = new Date().toISOString()
  const previousLatest = manifest.releases[0]?.version
  const entry = {
    version,
    publishedAt,
    downloadUrl: `https://cavecms.derricksiawor.com/releases/cavecms-${version}.zip`,
    sha256,
    signature: signature ?? null,
    notes: `## ${version}\n\nRelease notes — fill in before publishing.`,
    isSecurity: Boolean(isSecurity),
    ...(previousLatest ? { minPreviousVersion: previousLatest } : {}),
  }
  manifest.releases.unshift(entry)
  manifest.latestVersion = version
  manifest.publishedAt = publishedAt

  // Atomic write: write to .tmp then rename. Closes the TOCTOU where
  // two concurrent build-zip invocations could clobber each other's
  // manifest. The rename itself is atomic on POSIX filesystems.
  const tmpPath = manifestPath + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n')
  // fs.rename is atomic on the same filesystem; cross-fs would copy.
  // Since dist/ is always inside the repo, same fs is guaranteed.
  spawnSync('mv', [tmpPath, manifestPath], { stdio: 'inherit' })
  log.ok(`Updated manifest.json (latestVersion=${version}${signature ? '' : ' — UNSIGNED'})`)
  return manifestPath
}

async function main() {
  log.header('CaveCMS Release — build-zip')

  const version = resolveVersion()
  const commit = gitShortSha()
  console.log(c('gray', 'Version: ') + c('bold', version))
  console.log(c('gray', 'Commit:  ') + commit)
  console.log(c('gray', 'Out:     ') + relative(REPO_ROOT, DIST_DIR))
  console.log('')

  log.step(1, 6, 'Verifying prerequisites…')
  verifyPrereqs()
  log.ok('Prerequisites OK')

  log.step(2, 6, 'Building Next.js standalone…')
  rebuildIfNeeded()
  log.ok('Build ready')

  log.step(3, 6, 'Assembling staging tree…')
  const { stagingDir, stagingName } = assembleStaging(version)

  log.step(4, 6, 'Creating zip archive…')
  const zipPath = makeZip(stagingDir, stagingName, version)
  const sha256 = writeSha256(zipPath)

  log.step(5, 6, 'Signing artifacts…')
  const zipSig = signEd25519(zipPath)

  log.step(6, 6, 'Updating manifest.json…')
  const manifestPath = updateManifest({ version, sha256, signature: zipSig, isSecurity: false })
  if (zipSig) signEd25519(manifestPath)

  const bar = '━'.repeat(63)
  console.log('')
  console.log(c('green', bar))
  console.log(c('green', c('bold', '       Release artifact ready')))
  console.log(c('green', bar))
  console.log('')
  console.log(c('gray', 'Zip:      ') + relative(REPO_ROOT, zipPath))
  console.log(c('gray', 'Manifest: ') + relative(REPO_ROOT, manifestPath))
  console.log(c('gray', 'Version:  ') + version)
  console.log(c('gray', 'SHA-256:  ') + sha256)
  console.log(c('gray', 'Signed:   ') + (zipSig ? c('green', 'yes') : c('yellow', 'no — see warnings above')))
  console.log('')
  console.log(c('gray', 'Next: ') + c('bold', 'pnpm release:publish') + c('gray', ' (uploads to cavecms.derricksiawor.com)'))
  console.log('')
}

main().catch((err) => {
  console.error(c('red', err.stack ?? String(err)))
  process.exit(1)
})
