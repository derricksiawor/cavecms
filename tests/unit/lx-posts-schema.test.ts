import { describe, it, expect } from 'vitest'
import { parseBlockData, type BlockData } from '@/lib/cms/block-registry'

// Schema + back-compat coverage for the expanded lx_posts (Posts widget).
// The block carries a top-level z.preprocess that rewrites the legacy
// mode/layout vocabulary into the new source/template fields; these tests
// pin that mapping AND the new field bounds so a regression surfaces here
// rather than as a broken /blog index or a silently-dropped operator
// choice.

function parse(data: unknown): BlockData<'lx_posts'> {
  return parseBlockData('lx_posts', data) as BlockData<'lx_posts'>
}

describe('lx_posts schema — new fields + defaults', () => {
  it('applies sensible defaults on an empty payload', () => {
    const d = parse({})
    expect(d.template).toBe('grid')
    expect(d.source).toBe('latest')
    expect(d.limit).toBe(6)
    expect(d.columns).toBe(3)
    expect(d.offset).toBe(0)
    expect(d.orderBy).toBe('date')
    expect(d.orderDir).toBe('desc')
    expect(d.pagination).toBe('auto')
    expect(d.cardStyle).toBe('soft')
    expect(d.spacing).toBe('comfortable')
    expect(d.imageAspect).toBe('16:9')
    expect(d.showImage).toBe(true)
    expect(d.showExcerpt).toBe(true)
    expect(d.titleClamp).toBe(2)
    expect(d.excerptClamp).toBe(3)
  })

  it('accepts every template enum and rejects an unknown one', () => {
    for (const t of ['grid', 'cards', 'list', 'magazine', 'carousel']) {
      expect(parse({ template: t }).template).toBe(t)
    }
    expect(() => parse({ template: 'masonry' })).toThrow()
  })

  it('accepts every source enum and rejects an unknown one', () => {
    for (const s of ['current', 'latest', 'category', 'tag', 'author', 'manual', 'related']) {
      expect(parse({ source: s }).source).toBe(s)
    }
    expect(() => parse({ source: 'everything' })).toThrow()
  })

  it('widens columns to 1..4 (legacy 2/3 still valid)', () => {
    for (const c of [1, 2, 3, 4]) {
      expect(parse({ columns: c }).columns).toBe(c)
    }
    expect(() => parse({ columns: 5 })).toThrow()
    expect(() => parse({ columns: 0 })).toThrow()
  })

  it('bounds limit 1..24, offset 0..100, intervalMs 2000..12000', () => {
    expect(parse({ limit: 24 }).limit).toBe(24)
    expect(() => parse({ limit: 25 })).toThrow()
    expect(() => parse({ limit: 0 })).toThrow()
    expect(parse({ offset: 100 }).offset).toBe(100)
    expect(() => parse({ offset: 101 })).toThrow()
    expect(parse({ intervalMs: 2000 }).intervalMs).toBe(2000)
    expect(() => parse({ intervalMs: 1999 })).toThrow()
    expect(() => parse({ intervalMs: 12001 })).toThrow()
  })

  it('caps manualPostIds at 24 and requires positive ints', () => {
    expect(parse({ source: 'manual', manualPostIds: [1, 2, 3] }).manualPostIds).toEqual([1, 2, 3])
    const tooMany = Array.from({ length: 25 }, (_, i) => i + 1)
    expect(() => parse({ source: 'manual', manualPostIds: tooMany })).toThrow()
    expect(() => parse({ source: 'manual', manualPostIds: [0] })).toThrow()
    expect(() => parse({ source: 'manual', manualPostIds: [-1] })).toThrow()
  })

  it('validates category/tag slug shape', () => {
    expect(parse({ source: 'category', category: 'announcements' }).category).toBe('announcements')
    expect(() => parse({ source: 'category', category: 'Bad Slug' })).toThrow()
    expect(() => parse({ source: 'tag', tag: 'has space' })).toThrow()
  })

  it('requires authorId to be a positive int', () => {
    expect(parse({ source: 'author', authorId: 7 }).authorId).toBe(7)
    expect(() => parse({ source: 'author', authorId: 0 })).toThrow()
    expect(() => parse({ source: 'author', authorId: 1.5 })).toThrow()
  })

  it('clamps titleClamp 0..4 and excerptClamp 0..6', () => {
    expect(parse({ titleClamp: 0 }).titleClamp).toBe(0)
    expect(parse({ titleClamp: 4 }).titleClamp).toBe(4)
    expect(() => parse({ titleClamp: 5 })).toThrow()
    expect(parse({ excerptClamp: 6 }).excerptClamp).toBe(6)
    expect(() => parse({ excerptClamp: 7 })).toThrow()
  })
})

describe('lx_posts schema — BACK-COMPAT (#8) legacy mode/layout mapping', () => {
  it("legacy mode:'recent' → source:'latest'", () => {
    const d = parse({ mode: 'recent', limit: 3, layout: 'grid', columns: 3, showExcerpt: true, showDate: true })
    expect(d.source).toBe('latest')
    expect(d.template).toBe('grid')
    expect(d.limit).toBe(3)
    expect(d.columns).toBe(3)
  })

  it("legacy mode:'loop' → source:'current'", () => {
    const d = parse({ mode: 'loop', layout: 'grid', columns: 3, showExcerpt: true, showDate: true, showReadingTime: true, animation: 'fade-in' })
    expect(d.source).toBe('current')
    expect(d.template).toBe('grid')
  })

  it("legacy layout:'list' → template:'list'", () => {
    const d = parse({ mode: 'loop', layout: 'list' })
    expect(d.template).toBe('list')
    expect(d.source).toBe('current')
  })

  it('a NEW payload carrying source/template is NOT overwritten by legacy fields', () => {
    // Belt-and-suspenders: even if a stray mode/layout rode along, an
    // explicit new field wins (the preprocess only fills an ABSENT field).
    const d = parse({ source: 'category', template: 'magazine', mode: 'recent', layout: 'list', category: 'news' })
    expect(d.source).toBe('category')
    expect(d.template).toBe('magazine')
  })

  it('the legacy seed payload (systemPageBlocks /blog loop) still parses', () => {
    // Exact shape from db/seeds/systemPageBlocks.ts.
    const d = parse({ mode: 'loop', layout: 'grid', columns: 3, showExcerpt: true, showDate: true, showReadingTime: true, animation: 'fade-in' })
    expect(d.source).toBe('current')
    expect(d.template).toBe('grid')
    expect(d.showReadingTime).toBe(true)
  })

  it('the legacy blockSeeds default ({}) still parses', () => {
    const d = parse({})
    expect(d.source).toBe('latest')
    expect(d.template).toBe('grid')
  })
})
