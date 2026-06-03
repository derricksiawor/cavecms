import { describe, it, expect } from 'vitest'
import { diffIdSets, MAX_TERMS_PER_POST } from '@/lib/cms/syncPostTaxonomy'

// Pure diff logic underpinning the junction sync. The DB-bound syncPostTaxonomy
// is exercised in the customer-journey verification; here we lock down the
// add/remove/unchanged computation that decides which junction rows are
// inserted/deleted (and therefore which archives get cache-busted).

describe('diffIdSets', () => {
  it('computes adds for ids in desired but not current', () => {
    const { toAdd, toRemove, unchanged } = diffIdSets([1, 2], [1, 2, 3])
    expect(toAdd.sort()).toEqual([3])
    expect(toRemove).toEqual([])
    expect(unchanged.sort()).toEqual([1, 2])
  })

  it('computes removes for ids in current but not desired', () => {
    const { toAdd, toRemove, unchanged } = diffIdSets([1, 2, 3], [1])
    expect(toAdd).toEqual([])
    expect(toRemove.sort()).toEqual([2, 3])
    expect(unchanged).toEqual([1])
  })

  it('handles a full swap (no overlap)', () => {
    const { toAdd, toRemove, unchanged } = diffIdSets([1, 2], [3, 4])
    expect(toAdd.sort()).toEqual([3, 4])
    expect(toRemove.sort()).toEqual([1, 2])
    expect(unchanged).toEqual([])
  })

  it('is a no-op when sets are equal (order-independent)', () => {
    const { toAdd, toRemove, unchanged } = diffIdSets([3, 1, 2], [2, 3, 1])
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual([])
    expect(unchanged.sort()).toEqual([1, 2, 3])
  })

  it('clears everything when desired is empty', () => {
    const { toAdd, toRemove } = diffIdSets([1, 2, 3], [])
    expect(toAdd).toEqual([])
    expect(toRemove.sort()).toEqual([1, 2, 3])
  })

  it('adds everything when current is empty', () => {
    const { toAdd, toRemove } = diffIdSets([], [1, 2, 3])
    expect(toAdd.sort()).toEqual([1, 2, 3])
    expect(toRemove).toEqual([])
  })

  it('exposes a sane per-post cap', () => {
    expect(MAX_TERMS_PER_POST).toBeGreaterThanOrEqual(10)
    expect(MAX_TERMS_PER_POST).toBeLessThanOrEqual(200)
  })
})
