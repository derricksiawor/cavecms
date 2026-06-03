import { describe, it, expect } from 'vitest'
import {
  derivePostStatus,
  isPostStatusFilter,
  POST_STATUS_FILTERS,
  statusFilterSql,
  statusBucketCaseSql,
  statusCountSumsSql,
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

  it('published=1 + null published_at → draft (F7: not publicly visible)', () => {
    // A published=1 row with NO publish timestamp fails the public gate
    // (published_at IS NOT NULL), so it is NOT live and must read as draft —
    // aligned with publicPostGateSql + the admin status SQL.
    expect(
      derivePostStatus({ published: 1, published_at: null, deleted_at: null }, NOW),
    ).toBe('draft')
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

  it('a malformed published_at on a published row falls back to draft (F7: not live)', () => {
    // A malformed timestamp can't satisfy `published_at <= NOW(3)`, so the post
    // isn't publicly visible → draft, not published.
    expect(
      derivePostStatus(
        { published: 1, published_at: 'not-a-date', deleted_at: null },
        NOW,
      ),
    ).toBe('draft')
  })
})

// Reconstruct the literal SQL text from a drizzle `sql` fragment's queryChunks.
// StringChunk carries literal SQL in `.value` (string[]); sql.raw(...) nests as
// a child SQL object whose own chunks we recurse into; bound params (if any)
// become '?'. Lets us assert the SHAPE of the admin status fragments without a DB.
function sqlText(fragment: unknown): string {
  let out = ''
  for (const c of (fragment as { queryChunks?: unknown[] }).queryChunks ?? []) {
    const ctor = (c as { constructor?: { name?: string } })?.constructor?.name
    if (ctor === 'StringChunk') {
      out += ((c as { value: string[] }).value).join('')
    } else if (ctor === 'SQL') {
      out += sqlText(c) // sql.raw(...) / nested fragment
    } else if (ctor === 'Param') {
      out += '?'
    }
  }
  return out
}

describe('admin status SQL fragments (single source of truth — F5/F7)', () => {
  it('statusFilterSql published requires published_at IS NOT NULL (F7 alignment)', () => {
    const t = sqlText(statusFilterSql('published', 'p'))
    expect(t).toContain('p.published = 1')
    expect(t).toContain('p.published_at IS NOT NULL')
    expect(t).toContain('p.published_at <= NOW(3)')
  })

  it('statusFilterSql draft includes the null-published_at branch (F7)', () => {
    const t = sqlText(statusFilterSql('draft', 'p'))
    // draft = published=0 OR published_at IS NULL (a published=1/NULL-ts row).
    expect(t).toContain('p.published = 0')
    expect(t).toContain('p.published_at IS NULL')
    expect(t).toContain('p.deleted_at IS NULL')
  })

  it('statusFilterSql scheduled is the future-published window', () => {
    const t = sqlText(statusFilterSql('scheduled', 'p'))
    expect(t).toContain('p.published = 1')
    expect(t).toContain('p.published_at IS NOT NULL')
    expect(t).toContain('p.published_at > NOW(3)')
  })

  it('statusFilterSql trash + all', () => {
    expect(sqlText(statusFilterSql('trash', 'p'))).toContain('p.deleted_at IS NOT NULL')
    expect(sqlText(statusFilterSql('all', 'p'))).toContain('p.deleted_at IS NULL')
  })

  it('respects the alias argument (no leading dot when alias is empty)', () => {
    expect(sqlText(statusFilterSql('all', 'x'))).toContain('x.deleted_at IS NULL')
    expect(sqlText(statusFilterSql('all', ''))).toContain('deleted_at IS NULL')
  })

  it('statusBucketCaseSql buckets a null-published_at published=1 row as draft (0)', () => {
    const t = sqlText(statusBucketCaseSql('p'))
    // The NULL-timestamp WHEN maps to 0 (draft) before the published ELSE 2.
    expect(t).toContain('WHEN p.published_at IS NULL THEN 0')
    expect(t).toContain('WHEN p.deleted_at IS NOT NULL THEN 3')
    expect(t).toContain('ELSE 2')
  })

  it('statusCountSumsSql draft SUM includes the null-published_at branch + aliases match counts shape', () => {
    const t = sqlText(statusCountSumsSql('p'))
    expect(t).toContain('AS all_active')
    expect(t).toContain('AS draft')
    expect(t).toContain('AS scheduled')
    expect(t).toContain('AS published_')
    expect(t).toContain('AS trash')
    // The draft SUM must count the null-published_at published=1 rows (F7).
    expect(t).toContain('p.published_at IS NULL')
    // The published SUM must require a non-null, arrived timestamp.
    expect(t).toContain('p.published_at IS NOT NULL AND p.published_at <= NOW(3)')
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
