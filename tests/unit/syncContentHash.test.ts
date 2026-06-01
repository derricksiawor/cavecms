import { describe, it, expect } from 'vitest'
import {
  canonicalContentHash,
  mediaBundleKey,
  type ContentGraph,
} from '@/lib/sync/contentHash'

function baseGraph(): ContentGraph {
  return {
    pages: [
      {
        slug: 'a',
        title: 'A',
        isHome: true,
        system: false,
        published: true,
        seoTitle: null,
        seoDescription: null,
        ogImageKey: null,
        heroImageKey: null,
        sections: [],
      },
      {
        slug: 'b',
        title: 'B',
        isHome: false,
        system: false,
        published: true,
        seoTitle: null,
        seoDescription: null,
        ogImageKey: null,
        heroImageKey: null,
        sections: [],
      },
    ],
    posts: [],
    projects: [],
    settings: {},
  }
}

describe('canonicalContentHash', () => {
  it('is order-independent across pages', () => {
    const g1 = baseGraph()
    const g2 = baseGraph()
    g2.pages.reverse()
    expect(canonicalContentHash(g1)).toBe(canonicalContentHash(g2))
  })

  it('is order-independent across settings keys', () => {
    const g1 = baseGraph()
    g1.settings = { footer: { a: 1 }, site_header: { b: 2 } }
    const g2 = baseGraph()
    g2.settings = { site_header: { b: 2 }, footer: { a: 1 } }
    expect(canonicalContentHash(g1)).toBe(canonicalContentHash(g2))
  })

  it('changes when a block data field changes', () => {
    const g1 = baseGraph()
    const g2 = baseGraph()
    g2.pages[0]!.sections = [
      {
        kind: 'section',
        meta: {},
        columns: [
          {
            kind: 'column',
            widgets: [{ kind: 'widget', blockType: 'lx_text', data: { text: 'x' } }],
          },
        ],
      },
    ]
    expect(canonicalContentHash(g1)).not.toBe(canonicalContentHash(g2))
  })

  it('changes when a settings value changes', () => {
    const g1 = baseGraph()
    g1.settings = { footer: { tagline: 'one' } }
    const g2 = baseGraph()
    g2.settings = { footer: { tagline: 'two' } }
    expect(canonicalContentHash(g1)).not.toBe(canonicalContentHash(g2))
  })

  it('two graphs differing only in media bundleKey-equal refs hash equal', () => {
    // Same image referenced by its bundleKey on both sides — identical hash,
    // even though the underlying media_id would differ per install.
    const make = (key: string): ContentGraph => {
      const g = baseGraph()
      g.pages[0]!.heroImageKey = key
      return g
    }
    expect(canonicalContentHash(make('k1'))).toBe(canonicalContentHash(make('k1')))
    expect(canonicalContentHash(make('k1'))).not.toBe(
      canonicalContentHash(make('k2')),
    )
  })
})

describe('mediaBundleKey', () => {
  it('is stable for the same identity tuple', () => {
    const a = mediaBundleKey({ originalName: 'h.jpg', byteSize: 10, width: 4, height: 2, mime: 'image/jpeg' })
    const b = mediaBundleKey({ originalName: 'h.jpg', byteSize: 10, width: 4, height: 2, mime: 'image/jpeg' })
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('differs when any identity field differs', () => {
    const base = { originalName: 'h.jpg', byteSize: 10, width: 4, height: 2, mime: 'image/jpeg' }
    expect(mediaBundleKey(base)).not.toBe(mediaBundleKey({ ...base, byteSize: 11 }))
    expect(mediaBundleKey(base)).not.toBe(mediaBundleKey({ ...base, width: 5 }))
    expect(mediaBundleKey(base)).not.toBe(
      mediaBundleKey({ ...base, originalName: 'g.jpg' }),
    )
  })

  it('treats null dimensions (e.g. PDFs) consistently', () => {
    const a = mediaBundleKey({ originalName: 'b.pdf', byteSize: 9, width: null, height: null, mime: 'application/pdf' })
    const b = mediaBundleKey({ originalName: 'b.pdf', byteSize: 9, width: null, height: null, mime: 'application/pdf' })
    expect(a).toBe(b)
  })
})
