import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pushToCloud } from '../../../scripts/backup/cloud-push.mjs'

let dir: string

function buildArchive(name: string, manifest: Record<string, unknown>): string {
  const stage = mkdtempSync(join(tmpdir(), 'cavecms-stage-'))
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(stage, 'database.sql.gz'), 'db')
  writeFileSync(join(stage, 'uploads.tar.gz'), 'up')
  const archivePath = join(dir, name)
  execFileSync('tar', ['-C', stage, '-czf', archivePath, 'manifest.json', 'database.sql.gz', 'uploads.tar.gz'])
  rmSync(stage, { recursive: true, force: true })
  return archivePath
}

const MANIFEST = {
  formatVersion: 1,
  createdAt: '2026-06-01T00:00:00Z',
  cavecms: { version: '0.1.81', commit: 'abc1234' },
  database: { migrationCount: 26, schemaFingerprint: 'fp', migratorEncoding: 'drizzle-hash' },
  env: { included: false },
}

// A fake destination that records what it was asked to do.
function fakeDestFactory(record: {
  uploads: Array<{ name: string; path: string; bytes: Buffer }>
  deleted: string[]
  listReturns?: Array<{ remoteId: string; name: string; sizeBytes: number; createdAt: string }>
}) {
  return (opts: { folderId?: string; onRotate?: (rt: string) => void }) => {
    return {
      provider: 'gdrive',
      getRefreshToken: () => 'RT',
      getFolderId: () => opts.folderId ?? 'NEWFOLDER',
      ensureFolder: async () => 'NEWFOLDER',
      upload: async (path: string, name: string) => {
        // Capture bytes now — cloud-push unlinks temp blobs after upload.
        record.uploads.push({ name, path, bytes: readFileSync(path) })
        // Simulate a rotation so writeback is exercised.
        opts.onRotate?.('RT-rotated')
        return { remoteId: `id-${name}` }
      },
      list: async () => record.listReturns ?? [],
      download: async () => ({ destPath: '' }),
      delete: async (id: string) => {
        record.deleted.push(id)
      },
      quota: async () => null,
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-push-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('pushToCloud', () => {
  it('uploads the plain archive + a sidecar carrying manifest-derived metadata', async () => {
    const archive = buildArchive('cavecms-backup-20260601-000000-abc1234.tar.gz', MANIFEST)
    const credsFile = join(dir, 'creds.json')
    writeFileSync(credsFile, JSON.stringify({ provider: 'gdrive', clientId: 'c', refreshToken: 'RT0' }))
    const record = { uploads: [] as Array<{ name: string; path: string; bytes: Buffer }>, deleted: [] as string[] }

    const out = await pushToCloud({
      archivePath: archive,
      env: { CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile },
      createDest: fakeDestFactory(record),
    })

    expect(out.encrypted).toBe(false)
    expect(out.remoteName).toBe('cavecms-backup-20260601-000000-abc1234.tar.gz')
    // Two uploads: the archive blob + the sidecar.
    expect(record.uploads.map((u) => u.name)).toEqual([
      'cavecms-backup-20260601-000000-abc1234.tar.gz',
      'cavecms-backup-20260601-000000-abc1234.tar.gz.meta.json',
    ])
    // Creds file wiped.
    expect(existsSync(credsFile)).toBe(false)
    // Local copy kept by default.
    expect(existsSync(archive)).toBe(true)
  })

  it('encrypts the blob when a passphrase is supplied (remote name .enc, ciphertext differs)', async () => {
    const archive = buildArchive('cavecms-backup-20260601-000001-abc1234.tar.gz', MANIFEST)
    const plain = readFileSync(archive)
    const credsFile = join(dir, 'creds.json')
    writeFileSync(
      credsFile,
      JSON.stringify({ provider: 'gdrive', clientId: 'c', refreshToken: 'RT0', passphrase: 'secret' }),
    )
    const record = { uploads: [] as Array<{ name: string; path: string; bytes: Buffer }>, deleted: [] as string[] }

    const out = await pushToCloud({
      archivePath: archive,
      env: { CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile },
      createDest: fakeDestFactory(record),
    })

    expect(out.encrypted).toBe(true)
    expect(out.remoteName).toBe('cavecms-backup-20260601-000001-abc1234.tar.gz.enc')
    // The uploaded blob is the encrypted temp file — its bytes differ from plaintext.
    const blob = record.uploads.find((u) => u.name.endsWith('.enc'))!
    expect(blob.bytes.equals(plain)).toBe(false)
  })

  it('writes back a rotated refresh token + new folder id', async () => {
    const archive = buildArchive('cavecms-backup-20260601-000002-abc1234.tar.gz', MANIFEST)
    const credsFile = join(dir, 'creds.json')
    const outFile = join(dir, 'creds-out.json')
    writeFileSync(credsFile, JSON.stringify({ provider: 'gdrive', clientId: 'c', refreshToken: 'RT0' }))
    const record = { uploads: [] as Array<{ name: string; path: string; bytes: Buffer }>, deleted: [] as string[] }

    await pushToCloud({
      archivePath: archive,
      env: { CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile, CAVECMS_BACKUP_CLOUD_CREDS_OUT: outFile },
      createDest: fakeDestFactory(record),
    })

    const written = JSON.parse(readFileSync(outFile, 'utf8'))
    expect(written.refreshToken).toBe('RT-rotated')
    expect(written.folderId).toBe('NEWFOLDER')
  })

  it('applies remote retention, deleting the oldest archives beyond the keep count', async () => {
    const archive = buildArchive('cavecms-backup-20260601-000003-abc1234.tar.gz', MANIFEST)
    const credsFile = join(dir, 'creds.json')
    writeFileSync(credsFile, JSON.stringify({ provider: 'gdrive', clientId: 'c', refreshToken: 'RT0' }))
    const record = {
      uploads: [] as Array<{ name: string; path: string; bytes: Buffer }>,
      deleted: [] as string[],
      listReturns: [
        { remoteId: 'a3', name: 'cavecms-backup-20260601-000003-abc1234.tar.gz', sizeBytes: 3, createdAt: '2026-06-03' },
        { remoteId: 'a2', name: 'cavecms-backup-20260601-000002-abc1234.tar.gz', sizeBytes: 2, createdAt: '2026-06-02' },
        { remoteId: 'a1', name: 'cavecms-backup-20260601-000001-abc1234.tar.gz', sizeBytes: 1, createdAt: '2026-06-01' },
      ],
    }

    await pushToCloud({
      archivePath: archive,
      env: { CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile, CAVECMS_BACKUP_REMOTE_RETENTION: '2' },
      createDest: fakeDestFactory(record),
    })

    // Keep newest 2 → the oldest (a1) is deleted.
    expect(record.deleted).toContain('a1')
    expect(record.deleted).not.toContain('a3')
  })

  it('deletes the local archive when CAVECMS_BACKUP_KEEP_LOCAL=0', async () => {
    const archive = buildArchive('cavecms-backup-20260601-000004-abc1234.tar.gz', MANIFEST)
    const credsFile = join(dir, 'creds.json')
    writeFileSync(credsFile, JSON.stringify({ provider: 'gdrive', clientId: 'c', refreshToken: 'RT0' }))
    const record = { uploads: [] as Array<{ name: string; path: string; bytes: Buffer }>, deleted: [] as string[] }

    await pushToCloud({
      archivePath: archive,
      env: { CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile, CAVECMS_BACKUP_KEEP_LOCAL: '0' },
      createDest: fakeDestFactory(record),
    })

    expect(existsSync(archive)).toBe(false)
  })
})
