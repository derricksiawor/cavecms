import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readBackupStatus,
  writeBackupStatus,
  clearBackupStatus,
  isBackupStale,
  __setBackupStatusPathForTests,
  readRestoreStatus,
  writeRestoreStatus,
  __setRestoreStatusPathForTests,
  type BackupStatus,
} from '@/lib/backups/statusFile'

let dir: string
let p: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-bkp-'))
  p = join(dir, 'backup-status.json')
  __setBackupStatusPathForTests(p)
  __setRestoreStatusPathForTests(join(dir, 'restore-status.json'))
})
afterEach(() => {
  __setBackupStatusPathForTests(null)
  __setRestoreStatusPathForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('backups/statusFile', () => {
  it('returns null when missing', () => {
    expect(readBackupStatus()).toBeNull()
  })
  it('writes + merges without fromSha/toSha', () => {
    writeBackupStatus({ state: 'running', step: 1, totalSteps: 5, stepLabel: 'Saving your content' })
    const s = readBackupStatus()
    expect(s?.state).toBe('running')
    expect(s?.step).toBe(1)
    expect(s?.totalSteps).toBe(5)
    expect((s as unknown as Record<string, unknown>).fromSha).toBeUndefined()
  })
  it('atomic — no .tmp leftovers', () => {
    writeBackupStatus({ state: 'running', step: 1, totalSteps: 5 })
    writeBackupStatus({ state: 'completed', step: 5, totalSteps: 5, archiveLabel: 'Today, 2:14 PM' })
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([])
  })
  it('isStale true when in-progress + >15min old', () => {
    const s: BackupStatus = {
      state: 'running',
      step: 1,
      totalSteps: 5,
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    }
    expect(isBackupStale(s)).toBe(true)
  })
  it('isStale false when terminal', () => {
    const s: BackupStatus = {
      state: 'completed',
      step: 5,
      totalSteps: 5,
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    }
    expect(isBackupStale(s)).toBe(false)
  })
  it('clear is idempotent', () => {
    writeBackupStatus({ state: 'running', step: 1, totalSteps: 5 })
    clearBackupStatus()
    expect(readBackupStatus()).toBeNull()
    clearBackupStatus()
    expect(readBackupStatus()).toBeNull()
  })
  it('written JSON parseable from disk', () => {
    writeBackupStatus({ state: 'running', step: 2, totalSteps: 5 })
    expect(JSON.parse(readFileSync(p, 'utf8')).state).toBe('running')
  })
  it('restore status is an independent file', () => {
    writeBackupStatus({ state: 'running', step: 1, totalSteps: 5 })
    writeRestoreStatus({ state: 'restoring', step: 3, totalSteps: 7 })
    expect(readBackupStatus()?.state).toBe('running')
    expect(readRestoreStatus()?.state).toBe('restoring')
  })
})
