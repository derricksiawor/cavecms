import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getCurrentVersion } from '@/lib/updates/getCurrentVersion'

const ORIG_COMMIT = process.env.CAVECMS_COMMIT
const ORIG_TS = process.env.CAVECMS_RELEASE_TS

describe('getCurrentVersion', () => {
  beforeEach(() => {
    delete process.env.CAVECMS_COMMIT
    delete process.env.CAVECMS_RELEASE_TS
  })
  afterEach(() => {
    if (ORIG_COMMIT === undefined) delete process.env.CAVECMS_COMMIT
    else process.env.CAVECMS_COMMIT = ORIG_COMMIT
    if (ORIG_TS === undefined) delete process.env.CAVECMS_RELEASE_TS
    else process.env.CAVECMS_RELEASE_TS = ORIG_TS
  })

  it('returns sha + ts when env is set', () => {
    process.env.CAVECMS_COMMIT = 'abc1234'
    process.env.CAVECMS_RELEASE_TS = '2026-05-25T00:00:00Z'
    const v = getCurrentVersion()
    expect(v.sha).toBe('abc1234')
    expect(v.ts).toBe('2026-05-25T00:00:00Z')
  })

  it('returns dev marker when env missing', () => {
    const v = getCurrentVersion()
    expect(v.sha).toBe('dev')
    expect(v.ts).toBeNull()
  })

  it("treats CAVECMS_COMMIT='unknown' (lib/env default) as dev marker", () => {
    process.env.CAVECMS_COMMIT = 'unknown'
    const v = getCurrentVersion()
    expect(v.sha).toBe('dev')
  })
})
