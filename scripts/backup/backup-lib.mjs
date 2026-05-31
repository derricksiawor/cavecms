#!/usr/bin/env node
// scripts/backup/backup-lib.mjs
//
// Zero-dependency backup-archive validator + compat gate. Bundled into the
// per-install state dir (alongside cavecms-cli.mjs) so offline `cavecms
// restore` can validate an archive before any destructive op. Also invoked by
// the restore orchestrator (scripts/cavecms-restore.sh) as a child process.
//
// SHARES the `formatVersion: 1` manifest contract with lib/backups/manifest.ts
// (the in-app TS validator). Keep the two in lockstep on any format change.
//
// Uses only node builtins (crypto, child_process tar, fs, os, path) — no npm
// deps — so it runs against ANY install from its sealed env.production.
//
// CLI:
//   node backup-lib.mjs validate <archive.tar.gz>
//   node backup-lib.mjs compat   <archive.tar.gz> --install-version X --install-fingerprint Y [--install-migration-index N] [--backup-migration-index N]
//   node backup-lib.mjs manifest <archive.tar.gz>     # print the manifest JSON

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  rmSync,
  createReadStream,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ALLOWED_ENTRIES = new Set([
  'manifest.json',
  'database.sql.gz',
  'uploads.tar.gz',
  'env.production',
])

const BACKUP_FLOOR_VERSION = '0.1.55'
const MIGRATION_0024_BOUNDARY = 23

// ---------------------------------------------------------------------------
// tar helpers (gzip auto-detected by tar's -z)
// ---------------------------------------------------------------------------
export function listTarEntries(tgz) {
  const out = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

export function hasZipSlip(entries) {
  for (const raw of entries) {
    const e = String(raw)
    if (e.startsWith('/')) return true
    if (e.startsWith('~')) return true
    // any path component equal to '..'
    if (e.split('/').some((seg) => seg === '..')) return true
    // backslash / drive-letter style absolute (defensive)
    if (/^[A-Za-z]:[\\/]/.test(e)) return true
  }
  return false
}

export function parseManifestEntry(tgz) {
  const raw = execFileSync('tar', ['-xzO', '-f', tgz, 'manifest.json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(raw)
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

function sha256FileSync(path) {
  // Sync variant for the validate path. readFileSync buffers the whole file;
  // backup payloads validated this way are bounded by the archive the operator
  // chose to restore, and the restore orchestrator has already disk-checked.
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ---------------------------------------------------------------------------
// Manifest shape validation — mirrors lib/backups/manifest.ts ManifestSchema.
// Plain JS (no Zod) so this file stays zero-dep.
// ---------------------------------------------------------------------------
const SHA256_RE = /^[a-f0-9]{64}$/i
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/
const COMMIT_RE = /^[0-9a-f]{7,64}$/i

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

export function validateManifestShape(m) {
  const errs = []
  if (!isObj(m)) return ['manifest is not an object']
  if (m.formatVersion !== 1) errs.push('formatVersion must be 1')
  if (m.kind !== 'cavecms-backup') errs.push('kind must be cavecms-backup')
  if (typeof m.createdAt !== 'string') errs.push('createdAt missing')
  if (!isObj(m.cavecms) || !SEMVER_RE.test(m.cavecms?.version ?? '')) errs.push('cavecms.version invalid')
  if (!isObj(m.cavecms) || !COMMIT_RE.test(m.cavecms?.commit ?? '')) errs.push('cavecms.commit invalid')
  const d = m.database
  if (!isObj(d)) errs.push('database missing')
  else {
    if (typeof d.name !== 'string' || !d.name) errs.push('database.name invalid')
    if (typeof d.serverVersion !== 'string') errs.push('database.serverVersion invalid')
    if (!SHA256_RE.test(d.schemaFingerprint ?? '')) errs.push('database.schemaFingerprint invalid')
    if (d.migratorEncoding !== 'drizzle-hash' && d.migratorEncoding !== 'filename')
      errs.push('database.migratorEncoding invalid')
    if (d.file !== 'database.sql.gz') errs.push('database.file invalid')
    if (!SHA256_RE.test(d.sha256 ?? '')) errs.push('database.sha256 invalid')
    if (!Number.isInteger(d.sizeBytes)) errs.push('database.sizeBytes invalid')
  }
  const u = m.uploads
  if (!isObj(u)) errs.push('uploads missing')
  else {
    if (u.file !== 'uploads.tar.gz') errs.push('uploads.file invalid')
    if (!SHA256_RE.test(u.sha256 ?? '')) errs.push('uploads.sha256 invalid')
    if (!Number.isInteger(u.sizeBytes)) errs.push('uploads.sizeBytes invalid')
    if (!Number.isInteger(u.fileCount)) errs.push('uploads.fileCount invalid')
  }
  if (!isObj(m.env) || typeof m.env.included !== 'boolean') errs.push('env.included invalid')
  if (!isObj(m.encryption) || (m.encryption.scheme !== 'none' && m.encryption.scheme !== 'age'))
    errs.push('encryption.scheme invalid')
  return errs
}

// ---------------------------------------------------------------------------
// validateArchive — untrusted-input gate run BEFORE any destructive op.
// 1) list entries, refuse zip-slip + unknown entries
// 2) parse + shape-check manifest
// 3) extract to a scratch dir + verify each payload's sha256 vs manifest
// ---------------------------------------------------------------------------
export function validateArchive(tgz, opts = {}) {
  if (!existsSync(tgz)) return { ok: false, error: `archive not found: ${tgz}` }
  let entries
  try {
    entries = listTarEntries(tgz)
  } catch (err) {
    return { ok: false, error: `cannot read archive: ${err?.message ?? err}` }
  }
  if (entries.length === 0) return { ok: false, error: 'archive is empty' }
  if (hasZipSlip(entries)) return { ok: false, error: 'archive contains unsafe paths' }
  const normalized = entries.map((e) => e.replace(/\/$/, ''))
  for (const e of normalized) {
    if (!ALLOWED_ENTRIES.has(e)) return { ok: false, error: `unexpected entry in archive: ${e}` }
  }
  if (!normalized.includes('manifest.json')) return { ok: false, error: 'manifest.json missing' }

  let manifest
  try {
    manifest = parseManifestEntry(tgz)
  } catch (err) {
    return { ok: false, error: `manifest.json unreadable: ${err?.message ?? err}` }
  }
  const shapeErrs = validateManifestShape(manifest)
  if (shapeErrs.length) return { ok: false, error: `manifest invalid: ${shapeErrs.join('; ')}` }

  // Extract to a scratch dir and verify payload checksums.
  const scratch = opts.extractDir ?? mkdtempSync(join(tmpdir(), 'cavecms-validate-'))
  const cleanup = !opts.extractDir
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', scratch, 'database.sql.gz', 'uploads.tar.gz'], {
      maxBuffer: 0x7fffffff,
    })
    const dbActual = sha256FileSync(join(scratch, 'database.sql.gz'))
    if (dbActual !== String(manifest.database.sha256).toLowerCase()) {
      return { ok: false, error: 'database.sql.gz checksum mismatch' }
    }
    const upActual = sha256FileSync(join(scratch, 'uploads.tar.gz'))
    if (upActual !== String(manifest.uploads.sha256).toLowerCase()) {
      return { ok: false, error: 'uploads.tar.gz checksum mismatch' }
    }
  } catch (err) {
    return { ok: false, error: `extract/verify failed: ${err?.message ?? err}` }
  } finally {
    if (cleanup) {
      try {
        rmSync(scratch, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
  return { ok: true, manifest }
}

// ---------------------------------------------------------------------------
// compat gate — mirrors lib/backups/manifest.ts evaluateCompat.
// ---------------------------------------------------------------------------
function compareSemver(a, b) {
  const norm = (v) => (String(v).split(/[-+]/)[0] || '0').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pa = norm(a)
  const pb = norm(b)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}

export function evaluateCompat(manifest, ctx) {
  const warnings = []
  const v = manifest.cavecms.version
  if (compareSemver(v, BACKUP_FLOOR_VERSION) < 0)
    return { refuse: true, reason: `This backup is too old to restore (made before ${BACKUP_FLOOR_VERSION}).`, warnings }
  if (compareSemver(v, ctx.installVersion) > 0)
    return {
      refuse: true,
      reason:
        'This backup was made on a newer version of CaveCMS. Update this site to the latest version first, then restore.',
      warnings,
    }
  if (manifest.database.migratorEncoding !== 'drizzle-hash')
    return { refuse: true, reason: "This backup uses an incompatible migration format and can't be restored here.", warnings }
  const idx = ctx.backupMigrationIndex ?? manifest.database.migrationCount
  if (typeof idx === 'number' && idx < MIGRATION_0024_BOUNDARY) {
    warnings.push(
      'This backup predates a content-block format change. A few older content sections ' +
        '(hero, services intro, about history, stats row, star rating, alert) can’t be brought back, ' +
        'and featured-project ordering may need to be re-selected.',
    )
  }
  return { refuse: false, warnings }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
function parseFlag(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function isMain() {
  try {
    return process.argv[1] && process.argv[1].endsWith('backup-lib.mjs')
  } catch {
    return false
  }
}

if (isMain()) {
  const [, , cmd, archive, ...rest] = process.argv
  const fail = (msg) => {
    console.error(msg)
    process.exit(1)
  }
  if (!cmd || !archive) fail('usage: backup-lib.mjs <validate|compat|manifest> <archive> [flags]')
  if (cmd === 'manifest') {
    try {
      console.log(JSON.stringify(parseManifestEntry(archive)))
      process.exit(0)
    } catch (err) {
      fail(`manifest read failed: ${err?.message ?? err}`)
    }
  } else if (cmd === 'validate') {
    const r = validateArchive(archive)
    console.log(JSON.stringify(r.ok ? { ok: true } : { ok: false, error: r.error }))
    process.exit(r.ok ? 0 : 1)
  } else if (cmd === 'compat') {
    const r = validateArchive(archive)
    if (!r.ok) {
      console.log(JSON.stringify({ refuse: true, reason: r.error, warnings: [] }))
      process.exit(1)
    }
    const v = evaluateCompat(r.manifest, {
      installVersion: parseFlag(rest, '--install-version') ?? '0.0.0',
      installFingerprint: parseFlag(rest, '--install-fingerprint') ?? '',
      installMigrationIndex: rest.includes('--install-migration-index')
        ? Number(parseFlag(rest, '--install-migration-index'))
        : undefined,
      backupMigrationIndex: rest.includes('--backup-migration-index')
        ? Number(parseFlag(rest, '--backup-migration-index'))
        : undefined,
    })
    console.log(JSON.stringify(v))
    process.exit(v.refuse ? 1 : 0)
  } else {
    fail(`unknown command: ${cmd}`)
  }
}

// expose async hasher for callers that prefer streaming (unused by validate)
export { sha256File }
