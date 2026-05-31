import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  isValidArchiveBasename,
  listBackups,
  trashArchive,
  resolveBackupDir,
} from '@/lib/backups/store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-store-'))
  vi.stubEnv('CAVECMS_BACKUP_DIR', dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('isValidArchiveBasename', () => {
  it('accepts a canonical name', () => {
    expect(isValidArchiveBasename('cavecms-backup-20260531-120000-abc1234.tar.gz')).toBe(true)
    expect(isValidArchiveBasename('cavecms-backup-20260531-120000-abc1234.tar.gz.age')).toBe(true)
  })
  it('rejects path traversal + absolute + wrong shape', () => {
    expect(isValidArchiveBasename('../etc/passwd')).toBe(false)
    expect(isValidArchiveBasename('/etc/passwd')).toBe(false)
    expect(isValidArchiveBasename('cavecms-backup-x.tar.gz')).toBe(false)
    expect(isValidArchiveBasename('evil.tar.gz')).toBe(false)
    expect(isValidArchiveBasename('cavecms-backup-20260531-120000-abc1234.zip')).toBe(false)
  })
})

describe('resolveBackupDir', () => {
  it('honours CAVECMS_BACKUP_DIR', () => {
    expect(resolveBackupDir()).toBe(dir)
  })
})

describe('listBackups', () => {
  it('returns entries newest-first with manifest version', () => {
    // Build a real tar archive with a manifest.
    const stage = mkdtempSync(join(tmpdir(), 'cavecms-stage-'))
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ cavecms: { version: '0.1.66' }, env: { included: false } }))
    writeFileSync(join(stage, 'database.sql.gz'), 'x')
    const name = 'cavecms-backup-20260531-120000-abc1234.tar.gz'
    execFileSync('tar', ['-C', stage, '-czf', join(dir, name), 'manifest.json', 'database.sql.gz'])
    rmSync(stage, { recursive: true, force: true })

    const list = listBackups()
    expect(list.length).toBe(1)
    expect(list[0]!.file).toBe(name)
    expect(list[0]!.version).toBe('0.1.66')
    expect(list[0]!.encrypted).toBe(false)
  })
  it('ignores non-archive files', () => {
    writeFileSync(join(dir, 'random.txt'), 'x')
    expect(listBackups().length).toBe(0)
  })
})

describe('trashArchive', () => {
  it('moves the file into a .trash-<stamp> dir (never deletes)', () => {
    const name = 'cavecms-backup-20260531-120000-abc1234.tar.gz'
    writeFileSync(join(dir, name), 'data')
    trashArchive(name, '20260531-130000')
    expect(existsSync(join(dir, name))).toBe(false)
    const trash = readdirSync(dir).find((f) => f.startsWith('.trash-'))
    expect(trash).toBeTruthy()
    expect(existsSync(join(dir, trash!, name))).toBe(true)
  })
  it('refuses an invalid name', () => {
    expect(() => trashArchive('../evil', '20260531-130000')).toThrow()
  })
})
