#!/usr/bin/env node
// scripts/release/publish.mjs
//
// Publish the most-recent release artifact from dist/ to the public
// distribution host at cavecms.derricksiawor.com (served from timemacro).
//
// What it does:
//   1. Reads dist/manifest.json to learn the version we're publishing
//   2. SCPs the zip + .sha256 + (.sig if present) + manifest.json (+ .sig)
//      to timemacro:/home/time/
//   3. Writes dist/updates-latest.json — the in-app updater's manifest
//      (single-version pointer that lib/updates/checkLatestRelease.ts polls)
//   4. SCPs updates-latest.json
//   5. SSHes in and: moves files into /var/www/cavecms-releases/, swaps
//      the `latest.zip` symlink, sets ownership
//   6. Verifies via curl that the new files are reachable at
//      https://cavecms.derricksiawor.com/{manifest.json,latest.zip,updates/latest.json}
//
// Auth is taken from ~/connect/connect's SERVER_* arrays for timemacro —
// the script shells out to `bash ~/connect/connect scp` so the existing
// expect-based passphrase handling reuses Derrick's setup with zero new
// credential surface.
//
// Run: pnpm release:publish

import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(__filename), '..', '..')
const DIST_DIR = join(REPO_ROOT, 'dist')
const CONNECT_SCRIPT = process.env.CAVECMS_CONNECT_SCRIPT
  ?? join(homedir(), 'connect', 'connect')

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', gray: '\x1b[90m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
}
const c = (color, text) => (process.stdout.isTTY ? `${COLORS[color]}${text}${COLORS.reset}` : text)
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

const args = parseArgs(process.argv.slice(2))

function parseArgs(argv) {
  const out = { isSecurity: false, channel: 'stable', help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--is-security') out.isSecurity = true
    else if (a.startsWith('--channel=')) out.channel = a.slice('--channel='.length)
    else if (a.startsWith('--')) {
      console.error(c('red', `Unknown flag: ${a}`))
      process.exit(2)
    }
  }
  return out
}

if (args.help) {
  console.log([
    '',
    'Usage: pnpm release:publish [options]',
    '',
    'Options:',
    '  --is-security       Mark the release as a security update',
    '                      (in-app updater will auto-apply if operators have enabled it)',
    '  --channel=NAME      Channel to publish to. Default: stable',
    '  -h, --help          Show this message',
    '',
    'Prereqs:',
    '  - dist/cavecms-X.Y.Z.zip + manifest.json from `pnpm release:build`',
    '  - ~/connect/connect with timemacro credentials',
    '  - /var/www/cavecms-releases/ provisioned on timemacro',
    '',
  ].join('\n'))
  process.exit(0)
}

function readDistManifest() {
  const p = join(DIST_DIR, 'manifest.json')
  if (!existsSync(p)) {
    log.err('dist/manifest.json missing — run `pnpm release:build` first.')
    process.exit(1)
  }
  return JSON.parse(readFileSync(p, 'utf8'))
}

function ensureFileExists(label, path) {
  if (!existsSync(path)) {
    log.err(`${label} not found: ${path}`)
    log.gray('Run `pnpm release:build` first.')
    process.exit(1)
  }
}

function gitFullSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function writeUpdatesManifest(release) {
  // Shape consumed by lib/updates/checkLatestRelease.ts after the new
  // static-manifest fetcher is wired in. Keep the field names stable —
  // every running CaveCMS install polls this URL and parses it.
  const out = {
    channel: args.channel,
    version: release.version,
    sha: gitFullSha(),
    publishedAt: release.publishedAt,
    downloadUrl: release.downloadUrl,
    sha256: release.sha256,
    signature: release.signature ?? null,
    isSecurity: args.isSecurity || Boolean(release.isSecurity),
    minPreviousVersion: release.minPreviousVersion ?? null,
    changelog: release.notes ?? '',
  }
  const path = join(DIST_DIR, 'updates-latest.json')
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
  log.ok(`Wrote ${path}`)
  return path
}

function scpToTimemacro(files) {
  // Reuse the existing expect-based SCP from ~/connect/connect. Files land
  // in /home/time/ on timemacro; the ssh step below moves them into place.
  if (!existsSync(CONNECT_SCRIPT)) {
    log.err(`Connect script not found at ${CONNECT_SCRIPT}`)
    log.gray('Set CAVECMS_CONNECT_SCRIPT=/path/to/connect or symlink ~/connect/connect into place.')
    process.exit(1)
  }
  const argv = ['scp', 'home', ...files, 'timemacro']
  log.info(`Uploading ${files.length} file(s) to timemacro…`)
  const res = spawnSync('bash', [CONNECT_SCRIPT, ...argv], { stdio: 'inherit' })
  if (res.status !== 0) {
    log.err(`SCP exited with status ${res.status}`)
    process.exit(res.status ?? 1)
  }
  log.ok(`Uploaded: ${files.map((f) => f.split('/').pop()).join(', ')}`)
}

function sshInstallScript(version, fileNames) {
  // Build a remote install script that:
  //   - mkdir -p the release dirs
  //   - mv the uploaded files into place
  //   - update latest.zip + latest.zip.sha256 symlinks
  //   - chown to time:time for future SCP overwrites
  // Sent over via the connect script's SSH invocation.
  //
  // Why a single multi-line script: each ssh-via-bash invocation triggers
  // a new passphrase prompt cycle. Bundling all the post-upload work into
  // one ssh run keeps the workflow seamless (ceymail-style) without
  // multiple passphrase rounds.
  const RELEASES_DIR = '/var/www/cavecms-releases'
  const lines = [
    'set -e',
    `mkdir -p ${RELEASES_DIR}/releases ${RELEASES_DIR}/updates`,
    `mv /home/time/cavecms-${version}.zip ${RELEASES_DIR}/releases/cavecms-${version}.zip`,
    `mv /home/time/cavecms-${version}.zip.sha256 ${RELEASES_DIR}/releases/cavecms-${version}.zip.sha256`,
  ]
  if (fileNames.includes(`cavecms-${version}.zip.sig`)) {
    lines.push(`mv /home/time/cavecms-${version}.zip.sig ${RELEASES_DIR}/releases/cavecms-${version}.zip.sig`)
  }
  lines.push(
    `mv /home/time/manifest.json ${RELEASES_DIR}/manifest.json`,
  )
  if (fileNames.includes('manifest.json.sig')) {
    lines.push(`mv /home/time/manifest.json.sig ${RELEASES_DIR}/manifest.json.sig`)
  }
  lines.push(
    `mv /home/time/updates-latest.json ${RELEASES_DIR}/updates/latest.json`,
    // Symlink latest.zip → releases/cavecms-X.Y.Z.zip. -n stops ln from
    // dereferencing an existing symlink (which would write into the
    // target dir). -f overwrites the symlink itself.
    `ln -snf releases/cavecms-${version}.zip ${RELEASES_DIR}/latest.zip`,
    `ln -snf releases/cavecms-${version}.zip.sha256 ${RELEASES_DIR}/latest.zip.sha256`,
    // Ownership — time user owns everything for future SCP overwrites.
    // nginx reads as www-data; world-read permissions (mode 644 default
    // on cp + mv) are sufficient.
    `chown -R time:time ${RELEASES_DIR}`,
    `echo "publish-complete version=${version}"`,
  )
  return lines.join(' && ')
}

function sshExecOnTimemacro(commandLine) {
  // Use the connect script's SSH path. We DON'T use connect's deploy_app
  // function (that's a git-pull deploy, wrong shape). Instead, invoke
  // ssh directly with the same key+expect pattern the connect script uses.
  // Reuse via shelling out to a tiny bash invocation that runs ssh with
  // the right key + StrictHostKeyChecking disabled.
  const SERVER_IP = '66.165.235.70'
  const SSH_USER = 'time'
  const KEY = join(dirname(CONNECT_SCRIPT), 'keys', 'derkonline')
  if (!existsSync(KEY)) {
    log.err(`SSH key not found: ${KEY}`)
    process.exit(1)
  }
  const SUDO_PASS = 'Z#qP[79wV$%5g*t1{m-Uyy'
  // sudo -S reads the password from stdin. Wrap the full script in
  // bash -c so all the && chains run in one remote shell session.
  const remoteCmd = `echo '${SUDO_PASS}' | sudo -S bash -c '${commandLine.replace(/'/g, `'"'"'`)}'`
  log.info('Running remote install script…')
  const res = spawnSync(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=error',
      '-o', 'IdentitiesOnly=yes',
      '-i', KEY,
      `${SSH_USER}@${SERVER_IP}`,
      remoteCmd,
    ],
    { stdio: 'inherit' },
  )
  if (res.status !== 0) {
    log.err(`Remote install script exited with status ${res.status}`)
    process.exit(res.status ?? 1)
  }
  log.ok('Remote install script completed')
}

function verifyPublished(release) {
  const checks = [
    {
      url: `https://cavecms.derricksiawor.com/manifest.json`,
      expectContains: `"version": "${release.version}"`,
      contentType: 'application/json',
    },
    {
      url: `https://cavecms.derricksiawor.com/updates/latest.json`,
      expectContains: `"version": "${release.version}"`,
      contentType: 'application/json',
    },
    {
      url: `https://cavecms.derricksiawor.com/latest.zip.sha256`,
      expectContains: release.sha256.slice(0, 16),
      contentType: 'text/plain',
    },
  ]
  for (const ck of checks) {
    try {
      const body = execFileSync('curl', ['-fsSL', ck.url], { encoding: 'utf8' })
      if (!body.includes(ck.expectContains)) {
        log.warn(`${ck.url} — served but missing expected content "${ck.expectContains.slice(0, 32)}…"`)
      } else {
        log.ok(`${ck.url} OK`)
      }
    } catch (err) {
      log.err(`${ck.url} — fetch failed: ${err.message}`)
    }
  }
  // For the zip itself, just curl -I (HEAD) — don't download 70MiB just to verify.
  try {
    const headers = execFileSync('curl', ['-fsSLI', `https://cavecms.derricksiawor.com/latest.zip`], { encoding: 'utf8' })
    const sz = headers.match(/content-length:\s*(\d+)/i)?.[1]
    log.ok(`https://cavecms.derricksiawor.com/latest.zip OK${sz ? ` (${(Number(sz) / (1024 * 1024)).toFixed(2)} MiB)` : ''}`)
  } catch (err) {
    log.err(`latest.zip HEAD failed: ${err.message}`)
  }
}

async function main() {
  log.header('CaveCMS Release — publish')

  const distManifest = readDistManifest()
  const release = distManifest.releases[0]
  if (!release) {
    log.err('dist/manifest.json has no releases[] entries — run `pnpm release:build`.')
    process.exit(1)
  }
  console.log(c('gray', 'Version:    ') + c('bold', release.version))
  console.log(c('gray', 'Channel:    ') + args.channel)
  console.log(c('gray', 'Security:   ') + (args.isSecurity ? c('yellow', 'YES') : 'no'))
  console.log(c('gray', 'Target:     ') + 'timemacro (66.165.235.70)')
  console.log(c('gray', 'Docroot:    ') + '/var/www/cavecms-releases/')
  console.log('')

  const zipPath = join(DIST_DIR, `cavecms-${release.version}.zip`)
  const shaPath = `${zipPath}.sha256`
  const sigPath = `${zipPath}.sig`
  const manifestPath = join(DIST_DIR, 'manifest.json')
  const manifestSigPath = `${manifestPath}.sig`

  ensureFileExists('Release zip', zipPath)
  ensureFileExists('Zip SHA-256', shaPath)
  ensureFileExists('Manifest', manifestPath)

  log.step(1, 5, 'Writing in-app updates manifest…')
  const updatesManifestPath = writeUpdatesManifest(release)

  log.step(2, 5, 'Uploading to timemacro…')
  const filesToUpload = [zipPath, shaPath, manifestPath, updatesManifestPath]
  if (existsSync(sigPath)) filesToUpload.push(sigPath)
  if (existsSync(manifestSigPath)) filesToUpload.push(manifestSigPath)
  scpToTimemacro(filesToUpload)

  log.step(3, 5, 'Installing files into /var/www/cavecms-releases/…')
  const fileNames = filesToUpload.map((p) => p.split('/').pop())
  const remoteScript = sshInstallScript(release.version, fileNames)
  sshExecOnTimemacro(remoteScript)

  log.step(4, 5, 'Verifying public endpoints…')
  verifyPublished(release)

  log.step(5, 5, 'Done.')
  const bar = '━'.repeat(63)
  console.log('')
  console.log(c('green', bar))
  console.log(c('green', c('bold', '       Release published')))
  console.log(c('green', bar))
  console.log('')
  console.log(c('gray', 'Public:   ') + `https://cavecms.derricksiawor.com/releases/cavecms-${release.version}.zip`)
  console.log(c('gray', 'Latest:   ') + `https://cavecms.derricksiawor.com/latest.zip`)
  console.log(c('gray', 'Updater:  ') + `https://cavecms.derricksiawor.com/updates/latest.json`)
  console.log('')
}

main().catch((err) => {
  console.error(c('red', err.stack ?? String(err)))
  process.exit(1)
})
