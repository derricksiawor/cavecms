import { describe, it, expect } from 'vitest'
import {
  derivePostStatus,
  isPostStatusFilter,
  POST_STATUS_FILTERS,
} from '@/lib/cms/postStatus'

// Phase 8 status model (spec §3.1). derivePostStatus is the single source of
// truth the public gate, the admin list, and the editor pill all read — lock it
// down here so a future tweak to the rules can't silently flip a post's status
// across surfaces.

const NOW = new Date('2026-06-03T12:00:00.000Z')
const FUTURE = new Date('2026-06-04T12:00:00.000Z').toISOString()
const PAST = new Date('2026-06-02T12:00:00.000Z').toISOString()

describe('derivePostStatus', () => {
  it('trash wins over everything (deleted_at set)', () => {
    expect(
      derivePostStatus(
        { published: 1, published_at: PAST, deleted_at: new Date() },
        NOW,
      ),
    ).toBe('trash')
    // Even a future-dated, published row is trash if soft-deleted.
    expect(
      derivePostStatus(
        { published: 1, published_at: FUTURE, deleted_at: '2026-06-03' },
        NOW,
      ),
    ).toBe('trash')
  })

  it('published=0 → draft (regardless of published_at)', () => {
    expect(
      derivePostStatus({ published: 0, published_at: null, deleted_at: null }, NOW),
    ).toBe('draft')
    // A stale future published_at on an unpublished row is still a draft.
    expect(
      derivePostStatus({ published: 0, published_at: FUTURE, deleted_at: null }, NOW),
    ).toBe('draft')
  })

  it('published=1 + future published_at → scheduled', () => {
    expect(
      derivePostStatus({ published: 1, published_at: FUTURE, deleted_at: null }, NOW),
    ).toBe('scheduled')
  })

  it('published=1 + past published_at → published', () => {
    expect(
      derivePostStatus({ published: 1, published_at: PAST, deleted_at: null }, NOW),
    ).toBe('published')
  })

  it('published=1 + published_at exactly now → published (not scheduled)', () => {
    expect(
      derivePostStatus(
        { published: 1, published_at: NOW, deleted_at: null },
        NOW,
      ),
    ).toBe('published')
  })

  it('published=1 + null published_at → published (defensive: treat as live)', () => {
    expect(
      derivePostStatus({ published: 1, published_at: null, deleted_at: null }, NOW),
    ).toBe('published')
  })

  it('accepts boolean published + Date published_at', () => {
    expect(
      derivePostStatus(
        { published: true, published_at: new Date(FUTURE), deleted_at: null },
        NOW,
      ),
    ).toBe('scheduled')
    expect(
      derivePostStatus(
        { published: false, published_at: new Date(PAST), deleted_at: null },
        NOW,
      ),
    ).toBe('draft')
  })

  it('a malformed published_at on a published row falls back to published', () => {
    expect(
      derivePostStatus(
        { published: 1, published_at: 'not-a-date', deleted_at: null },
        NOW,
      ),
    ).toBe('published')
  })
})

describe('isPostStatusFilter', () => {
  it('accepts every declared filter', () => {
    for (const f of POST_STATUS_FILTERS) {
      expect(isPostStatusFilter(f)).toBe(true)
    }
  })
  it('rejects anything else', () => {
    expect(isPostStatusFilter('archived')).toBe(false)
    expect(isPostStatusFilter('')).toBe(false)
    expect(isPostStatusFilter(undefined)).toBe(false)
    expect(isPostStatusFilter(3)).toBe(false)
  })
})
