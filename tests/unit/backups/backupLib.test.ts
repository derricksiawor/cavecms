import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
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

// Build a VALID inner uploads.tar.gz (one empty dir) at dir/uploads.tar.gz.
function writeUploadsTar(withSymlink = false): { sha: string; size: number } {
  const src = join(dir, '_up')
  mkdirSync(join(src, 'originals'), { recursive: true })
  if (withSymlink) symlinkSync('/etc', join(src, 'originals', 'escape'))
  const up = join(dir, 'uploads.tar.gz')
  execFileSync('tar', ['-C', src, '-czf', up, 'originals'])
  rmSync(src, { recursive: true, force: true })
  return { sha: shaOf(up), size: statSync(up).size }
}

function buildArchive(name: string, over: object = {}, extraFiles: string[] = [], withSymlink = false): string {
  const dbData = Buffer.from('hello-db')
  writeFileSync(join(dir, 'database.sql.gz'), dbData)
  const up = writeUploadsTar(withSymlink)
  const dbSha = shaOf(join(dir, 'database.sql.gz'))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(makeManifest(dbSha, up.sha, dbData.length, up.size, over)),
  )
  const tgz = join(dir, name)
  execFileSync('tar', [
    '-C',
    dir,
    '-czf',
    tgz,
    'manifest.json',
    'database.sql.gz',
    'uploads.tar.gz',
    ...extraFiles,
  ])
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
  it('accepts a well-formed archive', async () => {
    const r = await validateArchive(buildArchive('a.tar.gz'))
    expect(r.ok).toBe(true)
    expect(r.manifest.formatVersion).toBe(1)
  })
  it('rejects a checksum mismatch', async () => {
    const tgz = buildArchive('b.tar.gz', {
      database: {
        name: 'c',
        engine: 'mariadb',
        serverVersion: '10.11',
        schemaFingerprint: 'b'.repeat(64),
        migratorEncoding: 'drizzle-hash',
        file: 'database.sql.gz',
        sha256: 'f'.repeat(64),
        sizeBytes: 8,
      },
    })
    expect((await validateArchive(tgz)).ok).toBe(false)
  })
  it('rejects an unknown extra entry', async () => {
    writeFileSync(join(dir, 'evil.sh'), 'rm -rf /')
    const tgz = buildArchive('c.tar.gz', {}, ['evil.sh'])
    expect((await validateArchive(tgz)).ok).toBe(false)
  })
  it('rejects a symlink entry inside the uploads tar (traversal defence)', async () => {
    const tgz = buildArchive('d.tar.gz', {}, [], true)
    const r = await validateArchive(tgz)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/unsafe entry|traversal/i)
  })
})
