import { describe, it, expect } from 'vitest'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'

describe('collectMediaPaths', () => {
  it('finds media_id at top + array nesting', () => {
    const out = collectMediaPaths({
      image: { media_id: 7, alt: 'a' },
      gallery: [
        { media_id: 8, alt: 'g0' },
        { media_id: 9, alt: 'g1' },
      ],
    })
    expect(out).toEqual([
      { mediaId: 7, field: 'image' },
      { mediaId: 8, field: 'gallery[0]' },
      { mediaId: 9, field: 'gallery[1]' },
    ])
  })

  it('returns empty array when no media_id is present', () => {
    expect(collectMediaPaths({ title: 'x', body_richtext: 'y' })).toEqual([])
  })

  it('handles deep nesting (object inside array inside object)', () => {
    const out = collectMediaPaths({
      sections: [
        { hero: { image: { media_id: 11, alt: 'a' } } },
        { hero: { image: { media_id: 12, alt: 'b' } } },
      ],
    })
    expect(out).toEqual([
      { mediaId: 11, field: 'sections[0].hero.image' },
      { mediaId: 12, field: 'sections[1].hero.image' },
    ])
  })

  it('ignores non-numeric media_id values', () => {
    expect(
      collectMediaPaths({ image: { media_id: '7', alt: 'a' } }),
    ).toEqual([])
    expect(
      collectMediaPaths({ image: { media_id: null, alt: 'a' } }),
    ).toEqual([])
  })

  it('survives null + undefined + primitive inputs', () => {
    expect(collectMediaPaths(null)).toEqual([])
    expect(collectMediaPaths(undefined)).toEqual([])
    expect(collectMediaPaths(42)).toEqual([])
    expect(collectMediaPaths('x')).toEqual([])
  })

  it('keeps stable ordering — insertion order of the input object', () => {
    const out = collectMediaPaths({
      a: { media_id: 1, alt: '' },
      b: { media_id: 2, alt: '' },
      c: { media_id: 3, alt: '' },
    })
    expect(out.map((p) => p.mediaId)).toEqual([1, 2, 3])
  })
})
