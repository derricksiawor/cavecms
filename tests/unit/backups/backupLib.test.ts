import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error — zero-dep .mjs runtime tool, no type declarations
import { validateArchive, hasZipSlip } from '../../../scripts/backup/backup-lib.mjs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-blib-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function shaOf(path: string): string {
  return execFileSync('shasum', ['-a', '256', path]).toString().split(' ')[0] ?? ''
}

function makeManifest(dbSha: string, upSha: string, dbLen: number, upLen: number, over: object = {}) {
  return {
    formatVersion: 1,
    kind: 'cavecms-backup',
    createdAt: '2026-05-31T00:00:00Z',
    cavecms: { version: '0.1.60', commit: 'a'.repeat(40) },
    database: {
      name: 'c',
      engine: 'mariadb',
      serverVersion: '10.11',
      schemaFingerprint: 'b'.repeat(64),
      migratorEncoding: 'drizzle-hash',
      file: 'database.sql.gz',
      sha256: dbSha,
      sizeBytes: dbLen,
    },
    uploads: { file: 'uploads.tar.gz', sha256: upSha, sizeBytes: upLen, fileCount: 1 },
    env: { included: false },
    encryption: { scheme: 'none' },
    ...over,
  }
}

function buildArchive(name: string, manifest: object): string {
  const data = Buffer.from('hello')
  writeFileSync(join(dir, 'database.sql.gz'), data)
  writeFileSync(join(dir, 'uploads.tar.gz'), data)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  const tgz = join(dir, name)
  execFileSync('tar', ['-C', dir, '-czf', tgz, 'manifest.json', 'database.sql.gz', 'uploads.tar.gz'])
  return tgz
}

describe('backup-lib zip-slip', () => {
  it('flags ../ entries', () => {
    expect(hasZipSlip(['manifest.json', '../etc/passwd'])).toBe(true)
  })
  it('flags absolute entries', () => {
    expect(hasZipSlip(['/etc/passwd'])).toBe(true)
  })
  it('passes clean entries', () => {
    expect(hasZipSlip(['manifest.json', 'database.sql.gz', 'uploads.tar.gz'])).toBe(false)
  })
})

describe('backup-lib validateArchive', () => {
  it('accepts a well-formed archive', () => {
    writeFileSync(join(dir, 'database.sql.gz'), Buffer.from('hello'))
    const dbSha = shaOf(join(dir, 'database.sql.gz'))
    const tgz = buildArchive('a.tar.gz', makeManifest(dbSha, dbSha, 5, 5))
    const r = validateArchive(tgz)
    expect(r.ok).toBe(true)
    expect(r.manifest.formatVersion).toBe(1)
  })
  it('rejects a checksum mismatch', () => {
    const tgz = buildArchive('b.tar.gz', makeManifest('f'.repeat(64), 'f'.repeat(64), 5, 5))
    expect(validateArchive(tgz).ok).toBe(false)
  })
  it('rejects an unknown extra entry', () => {
    writeFileSync(join(dir, 'database.sql.gz'), Buffer.from('hello'))
    writeFileSync(join(dir, 'uploads.tar.gz'), Buffer.from('hello'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(makeManifest(shaOf(join(dir, 'database.sql.gz')), shaOf(join(dir, 'database.sql.gz')), 5, 5)))
    writeFileSync(join(dir, 'evil.sh'), 'rm -rf /')
    const tgz = join(dir, 'c.tar.gz')
    execFileSync('tar', ['-C', dir, '-czf', tgz, 'manifest.json', 'database.sql.gz', 'uploads.tar.gz', 'evil.sh'])
    expect(validateArchive(tgz).ok).toBe(false)
  })
})
