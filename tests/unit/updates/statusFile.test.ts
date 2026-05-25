import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readStatus,
  writeStatus,
  isStale,
  clearStatus,
  __setStatusPathForTests,
  type UpdateStatus,
} from '@/lib/updates/statusFile'

let dir: string
let statusPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-status-'))
  statusPath = join(dir, 'update-status.json')
  __setStatusPathForTests(statusPath)
})

afterEach(() => {
  __setStatusPathForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('statusFile', () => {
  it('readStatus returns null when file missing', () => {
    expect(readStatus()).toBeNull()
  })

  it('writeStatus creates a new file with merged defaults', () => {
    writeStatus({ state: 'preflight', step: 0, totalSteps: 6 })
    const s = readStatus()
    expect(s?.state).toBe('preflight')
    expect(s?.step).toBe(0)
    expect(s?.totalSteps).toBe(6)
    expect(s?.startedAt).toBeTypeOf('string')
    expect(s?.updatedAt).toBeTypeOf('string')
  })

  it('writeStatus merges with existing fields (does not clobber)', () => {
    writeStatus({
      state: 'preflight',
      step: 0,
      totalSteps: 6,
      fromSha: 'aaa',
      toSha: 'bbb',
    })
    writeStatus({ state: 'updating', step: 2 })
    const s = readStatus()
    expect(s?.state).toBe('updating')
    expect(s?.step).toBe(2)
    expect(s?.fromSha).toBe('aaa')
    expect(s?.toSha).toBe('bbb')
    expect(s?.totalSteps).toBe(6)
  })

  it('writeStatus is atomic — no .tmp.* files left behind', () => {
    writeStatus({ state: 'preflight', step: 0, totalSteps: 6 })
    writeStatus({ state: 'updating', step: 2 })
    writeStatus({ state: 'completed', step: 6 })
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })

  it('isStale: false when state is terminal', () => {
    const s: UpdateStatus = {
      state: 'completed',
      step: 6,
      totalSteps: 6,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }
    expect(isStale(s)).toBe(false)
  })

  it('isStale: false when in-progress but updated recently', () => {
    const s: UpdateStatus = {
      state: 'updating',
      step: 2,
      totalSteps: 6,
      startedAt: new Date(Date.now() - 30 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 5 * 1000).toISOString(),
    }
    expect(isStale(s)).toBe(false)
  })

  it('isStale: true when in-progress and updatedAt > 15 min old', () => {
    const s: UpdateStatus = {
      state: 'updating',
      step: 2,
      totalSteps: 6,
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    }
    expect(isStale(s)).toBe(true)
  })

  it('isStale handles malformed updatedAt as stale', () => {
    const s: UpdateStatus = {
      state: 'updating',
      step: 2,
      totalSteps: 6,
      startedAt: 'bogus',
      updatedAt: 'bogus',
    }
    expect(isStale(s)).toBe(true)
  })

  it('clearStatus removes the file (idempotent if missing)', () => {
    writeStatus({ state: 'preflight', step: 0, totalSteps: 6 })
    clearStatus()
    expect(readStatus()).toBeNull()
    clearStatus()
    expect(readStatus()).toBeNull()
  })

  it('readStatus returns null on malformed JSON (does not throw)', () => {
    writeFileSync(statusPath, '{ not json', 'utf8')
    expect(readStatus()).toBeNull()
  })

  it('readStatus returns null on schema mismatch', () => {
    writeFileSync(statusPath, JSON.stringify({ banana: true }), 'utf8')
    expect(readStatus()).toBeNull()
  })

  it('written JSON is parseable directly from disk', () => {
    writeStatus({
      state: 'preflight',
      step: 0,
      totalSteps: 6,
      fromSha: 'aa',
      toSha: 'bb',
    })
    const parsed = JSON.parse(readFileSync(statusPath, 'utf8'))
    expect(parsed.state).toBe('preflight')
    expect(parsed.toSha).toBe('bb')
  })
})
