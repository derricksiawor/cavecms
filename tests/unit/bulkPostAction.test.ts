import { describe, it, expect } from 'vitest'
import {
  BULK_POST_ACTIONS,
  isBulkPostAction,
  MAX_BULK_POST_IDS,
  normalizeBulkIds,
  roleCanRunBulkAction,
  rolesForBulkAction,
  bulkActionNeedsTaxonomy,
} from '@/lib/cms/bulkPostActions'

// Phase 8 bulk-action policy (spec §10). The role gating + id-bounding logic of
// /api/cms/posts/bulk is pure; lock it down so a future action addition can't
// silently widen who may publish/trash or let an unbounded id list through.

describe('bulk action set', () => {
  it('recognises every declared action', () => {
    for (const a of BULK_POST_ACTIONS) expect(isBulkPostAction(a)).toBe(true)
  })
  it('rejects unknown actions', () => {
    expect(isBulkPostAction('delete')).toBe(false)
    expect(isBulkPostAction('publishAll')).toBe(false)
    expect(isBulkPostAction('')).toBe(false)
    expect(isBulkPostAction(undefined)).toBe(false)
  })
})

describe('role gating', () => {
  it('publish / unpublish / trash are admin-only', () => {
    for (const a of ['publish', 'unpublish', 'trash'] as const) {
      expect(rolesForBulkAction(a)).toEqual(['admin'])
      expect(roleCanRunBulkAction(a, 'admin')).toBe(true)
      expect(roleCanRunBulkAction(a, 'editor')).toBe(false)
      expect(roleCanRunBulkAction(a, 'viewer')).toBe(false)
    }
  })
  it('taxonomy assign is editor + admin (mirrors single-post taxonomy gate)', () => {
    for (const a of ['assignCategories', 'addTags'] as const) {
      expect(roleCanRunBulkAction(a, 'admin')).toBe(true)
      expect(roleCanRunBulkAction(a, 'editor')).toBe(true)
      expect(roleCanRunBulkAction(a, 'viewer')).toBe(false)
    }
  })
})

describe('taxonomy payload requirement', () => {
  it('maps assign actions to their axis', () => {
    expect(bulkActionNeedsTaxonomy('assignCategories')).toBe('category')
    expect(bulkActionNeedsTaxonomy('addTags')).toBe('tag')
  })
  it('state actions need no taxonomy payload', () => {
    expect(bulkActionNeedsTaxonomy('publish')).toBeNull()
    expect(bulkActionNeedsTaxonomy('unpublish')).toBeNull()
    expect(bulkActionNeedsTaxonomy('trash')).toBeNull()
  })
})

describe('normalizeBulkIds', () => {
  it('de-dupes preserving first-seen order', () => {
    const { ids } = normalizeBulkIds([3, 1, 3, 2, 1])
    expect(ids).toEqual([3, 1, 2])
  })
  it('drops non-positive-ints and non-numbers', () => {
    const { ids } = normalizeBulkIds([1, 0, -2, 2.5, '3', null, undefined, 4])
    expect(ids).toEqual([1, 4])
  })
  it('flags a batch over the cap as tooMany (without truncating)', () => {
    const big = Array.from({ length: MAX_BULK_POST_IDS + 1 }, (_, i) => i + 1)
    const { ids, tooMany } = normalizeBulkIds(big)
    expect(tooMany).toBe(true)
    expect(ids.length).toBe(MAX_BULK_POST_IDS + 1)
  })
  it('a batch exactly at the cap is allowed', () => {
    const exact = Array.from({ length: MAX_BULK_POST_IDS }, (_, i) => i + 1)
    const { tooMany } = normalizeBulkIds(exact)
    expect(tooMany).toBe(false)
  })
  it('an empty / all-invalid batch yields no ids', () => {
    expect(normalizeBulkIds([]).ids).toEqual([])
    expect(normalizeBulkIds([0, -1, 'x', null]).ids).toEqual([])
  })
})
