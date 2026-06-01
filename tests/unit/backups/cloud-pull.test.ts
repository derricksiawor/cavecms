import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { pullFromCloud } from '../../../scripts/backup/cloud-pull.mjs'
import { encryptFile } from '../../../scripts/backup/cloud/passphraseCipher.mjs'

let dir: string

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Fake destination: download(remoteId) copies a pre-registered source file to
// destPath; list() returns the registered entries.
function fakeDestFactory(files: Record<string, string>, entries: Array<{ remoteId: string; name: string }>) {
  return () => ({
    provider: 'gdrive',
    getRefreshToken: () => 'RT',
    getFolderId: () => 'F',
    ensureFolder: async () => 'F',
    upload: async () => ({ remoteId: 'x' }),
    list: async () => entries.map((e) => ({ ...e, sizeBytes: 0, createdAt: '2026-06-01' })),
    download: async (remoteId: string, destPath: string) => {
      copyFileSync(files[remoteId]!, destPath)
      return { destPath }
    },
    delete: async () => {},
    quota: async () => null,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-pull-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeCreds(extra: Record<string, unknown> = {}): string {
  const p = join(dir, 'creds.json')
  writeFileSync(p, JSON.stringify({ provider: 'gdrive', clientId: 'c', refreshToken: 'RT', ...extra }))
  return p
}

describe('pullFromCloud', () => {
  it('downloads a plain archive, verifies sha256, and returns its path', async () => {
    const archive = join(dir, 'cavecms-backup-x.tar.gz')
    writeFileSync(archive, Buffer.from('plain-archive-bytes'))
    const blobSha = sha256(archive)
    const sidecar = join(dir, 'sidecar.json')
    writeFileSync(sidecar, JSON.stringify({ archive: 'cavecms-backup-x.tar.gz', sha256: blobSha, encrypted: false }))
    const credsFile = writeCreds()
    const out = join(dir, 'pull-out.txt')

    const r = await pullFromCloud({
      env: {
        CAVECMS_RESTORE_PROVIDER: 'gdrive',
        CAVECMS_RESTORE_REMOTE_ID: 'BLOB',
        CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile,
        CAVECMS_RESTORE_DOWNLOAD_DIR: dir,
        CAVECMS_RESTORE_PULL_OUT: out,
      },
      createDest: fakeDestFactory(
        { BLOB: archive, SIDE: sidecar },
        [
          { remoteId: 'BLOB', name: 'cavecms-backup-x.tar.gz' },
          { remoteId: 'SIDE', name: 'cavecms-backup-x.tar.gz.meta.json' },
        ],
      ),
    })

    expect(r.encrypted).toBe(false)
    expect(readFileSync(r.archivePath).toString()).toBe('plain-archive-bytes')
    expect(readFileSync(out, 'utf8')).toBe(r.archivePath)
    // creds wiped.
    expect(existsSync(credsFile)).toBe(false)
  })

  it('rejects a checksum mismatch before returning anything', async () => {
    const archive = join(dir, 'cavecms-backup-y.tar.gz')
    writeFileSync(archive, Buffer.from('bytes'))
    const sidecar = join(dir, 'sidecar.json')
    writeFileSync(sidecar, JSON.stringify({ sha256: 'deadbeef', encrypted: false }))
    const credsFile = writeCreds()

    await expect(
      pullFromCloud({
        env: {
          CAVECMS_RESTORE_PROVIDER: 'gdrive',
          CAVECMS_RESTORE_REMOTE_ID: 'BLOB',
          CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile,
          CAVECMS_RESTORE_DOWNLOAD_DIR: dir,
        },
        createDest: fakeDestFactory(
          { BLOB: archive, SIDE: sidecar },
          [
            { remoteId: 'BLOB', name: 'cavecms-backup-y.tar.gz' },
            { remoteId: 'SIDE', name: 'cavecms-backup-y.tar.gz.meta.json' },
          ],
        ),
      }),
    ).rejects.toThrow(/checksum mismatch/)
  })

  it('decrypts a passphrase-encrypted archive back to the original bytes', async () => {
    const original = join(dir, 'cavecms-backup-z.tar.gz')
    const plaintext = Buffer.from('the-real-archive-contents-1234567890')
    writeFileSync(original, plaintext)
    // Produce the encrypted blob + its enc meta.
    const encBlob = join(dir, 'cavecms-backup-z.tar.gz.enc')
    const meta = await encryptFile({ srcPath: original, destPath: encBlob, passphrase: 'pw123' })
    const blobSha = sha256(encBlob)
    const sidecar = join(dir, 'sidecar.json')
    writeFileSync(
      sidecar,
      JSON.stringify({ sha256: blobSha, encrypted: true, enc: { scheme: 'aesgcm-scrypt', ...meta } }),
    )
    const credsFile = writeCreds({ passphrase: 'pw123' })

    const r = await pullFromCloud({
      env: {
        CAVECMS_RESTORE_PROVIDER: 'gdrive',
        CAVECMS_RESTORE_REMOTE_ID: 'BLOB',
        CAVECMS_BACKUP_CLOUD_CREDS_FILE: credsFile,
        CAVECMS_RESTORE_DOWNLOAD_DIR: dir,
      },
      createDest: fakeDestFactory(
        { BLOB: encBlob, SIDE: sidecar },
        [
          { remoteId: 'BLOB', name: 'cavecms-backup-z.tar.gz.enc' },
          { remoteId: 'SIDE', name: 'cavecms-backup-z.tar.gz.enc.meta.json' },
        ],
      ),
    })

    expect(r.encrypted).toBe(true)
    expect(r.archivePath.endsWith('.tar.gz')).toBe(true)
    expect(readFileSync(r.archivePath).equals(plaintext)).toBe(true)
  })
})
