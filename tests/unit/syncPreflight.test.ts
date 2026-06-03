import { describe, it, expect } from 'vitest'
import { validateBundle } from '@/lib/sync/preflight'
import { canonicalContentHash } from '@/lib/sync/contentHash'
import { toContentGraph } from '@/lib/sync/contentGraph'
import type { SyncBundleT, PageBundleT } from '@/lib/sync/bundleTypes'

function validBundle(): SyncBundleT {
  const pages: PageBundleT[] = [
    {
      slug: 'home',
      title: 'Home',
      isHome: true,
      system: false,
      published: true,
      seoTitle: null,
      seoDescription: null,
      ogImageKey: null,
      heroImageKey: null,
      sections: [
        {
          kind: 'section',
          meta: { columns: 1, background: 'cream', padding: 'lg' },
          columns: [
            {
              kind: 'column',
              widgets: [
                {
                  kind: 'widget',
                  blockType: 'lx_text',
                  data: {
                    body_richtext: '<p>hi</p>',
                    size: 'body-md',
                    alignment: 'left',
                    tone: 'ivory',
                    maxWidth: 'wide',
                    animation: 'fade-in',
                  },
                },
                {
                  kind: 'widget',
                  blockType: 'lx_cover_image',
                  data: { image: { alt: 'hero' } },
                  _mediaRefs: { image: 'k1' },
                },
              ],
            },
          ],
        },
      ],
    },
  ]
  const base = {
    pages,
    posts: [],
    projects: [],
    settings: { social_links: [] },
  }
  const contentHash = canonicalContentHash(toContentGraph(base))
  return {
    manifest: {
      formatVersion: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      sourceUrl: 'http://localhost:3040',
      baselineContentHash: null,
      contentHash,
      counts: { pages: 1, posts: 0, projects: 0, media: 1, settings: 1 },
    },
    ...base,
    media: [
      {
        bundleKey: 'k1',
        originalName: 'hero.jpg',
        mime: 'image/jpeg',
        alt: 'hero',
        width: 1600,
        height: 900,
        byteSize: 123,
        kind: 'image',
        files: { md: 'media/files/k1-md.webp' },
      },
    ],
  }
}

describe('validateBundle', () => {
  it('passes a fully valid bundle', () => {
    const r = validateBundle(validBundle())
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.summary).toEqual({ pages: 1, posts: 0, projects: 0, media: 1, settings: 1 })
  })

  it('rejects a settings key outside the allowlist', () => {
    const b = validBundle()
    b.settings = { ...b.settings, smtp_config: { host: 'x' } }
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.ok).toBe(false)
    expect(r.errors).toContainEqual(
      expect.objectContaining({ scope: 'settings', ref: 'smtp_config', reason: 'settings_key_not_allowed' }),
    )
  })

  it('rejects two home pages', () => {
    const b = validBundle()
    b.pages.push({ ...b.pages[0]!, slug: 'home2', isHome: true, sections: [] })
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'multiple_home')).toBe(true)
  })

  it('rejects an invalid block (bad data shape)', () => {
    const b = validBundle()
    // body_richtext must be a string; a number fails the Zod schema.
    ;(b.pages[0]!.sections[0]!.columns[0]!.widgets[0]!.data as Record<string, unknown>).body_richtext = 123
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'block_invalid')).toBe(true)
  })

  it('rejects an unresolved media ref', () => {
    const b = validBundle()
    b.media = [] // drop the entry k1 still references
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'media_unresolved')).toBe(true)
  })

  it('rejects a content-hash mismatch', () => {
    const b = validBundle()
    b.manifest.contentHash = 'deadbeef'
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'hash_mismatch')).toBe(true)
  })

  it('rejects an empty bundle (would wipe the target)', () => {
    const b = validBundle()
    b.pages = []
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'empty_bundle')).toBe(true)
  })

  it('rejects a bundle with no home page', () => {
    const b = validBundle()
    b.pages[0]!.isHome = false
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'no_home_page')).toBe(true)
  })

  it('rejects a forged literal media_id in widget data', () => {
    const b = validBundle()
    // legit data never carries media_id — a literal one is forged
    ;(b.pages[0]!.sections[0]!.columns[0]!.widgets[1]!.data.image as Record<string, unknown>).media_id = 4242
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'media_id_not_allowed')).toBe(true)
  })

  it('rejects duplicate page slugs', () => {
    const b = validBundle()
    b.pages.push({ ...b.pages[0]!, isHome: false, sections: [] }) // same slug 'home'
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'duplicate_slug')).toBe(true)
  })

  it('rejects an unpublished home page (would blank the public site)', () => {
    const b = validBundle()
    b.pages[0]!.published = false
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'home_unpublished')).toBe(true)
  })

  it('rejects a NON-system page that claims a route-reserved slug', () => {
    const b = validBundle()
    b.pages.push({ ...b.pages[0]!, slug: 'admin', isHome: false, system: false, sections: [] })
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'slug_reserved' && e.ref === 'admin')).toBe(true)
  })

  it('ALLOWS a SYSTEM page on an intentional reserved slug (contact)', () => {
    const b = validBundle()
    b.pages.push({ ...b.pages[0]!, slug: 'contact', isHome: false, system: true, sections: [] })
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'slug_reserved')).toBe(false)
  })

  it('rejects a non-system page that claims the target login path', () => {
    const b = validBundle()
    b.pages.push({ ...b.pages[0]!, slug: 'secretlogin', isHome: false, system: false, sections: [] })
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b, { loginPath: 'secretlogin' })
    expect(r.errors.some((e) => e.reason === 'slug_reserved' && e.ref === 'secretlogin')).toBe(true)
  })

  it('passes a section with a LIFTED backgroundImage media ref (_metaMediaRefs)', () => {
    const b = validBundle()
    // lifted form: media_id stripped from meta, recorded in _metaMediaRefs
    b.pages[0]!.sections[0]!.meta = {
      columns: 1,
      background: 'cream',
      padding: 'lg',
      backgroundImage: { alt: 'bg' },
    }
    b.pages[0]!.sections[0]!._metaMediaRefs = { backgroundImage: 'k1' }
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('rejects a FORGED literal media_id inside section meta', () => {
    const b = validBundle()
    b.pages[0]!.sections[0]!.meta = { backgroundImage: { media_id: 4242, alt: 'bg' } }
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'section_meta_media_id_not_allowed')).toBe(true)
  })

  it('rejects an unresolved section-meta media ref', () => {
    const b = validBundle()
    b.pages[0]!.sections[0]!.meta = { backgroundImage: { alt: 'bg' } }
    b.pages[0]!.sections[0]!._metaMediaRefs = { backgroundImage: 'nonexistent-key' }
    b.manifest.contentHash = canonicalContentHash(
      toContentGraph({ pages: b.pages, posts: b.posts, projects: b.projects, settings: b.settings }),
    )
    const r = validateBundle(b)
    expect(r.errors.some((e) => e.reason === 'media_unresolved')).toBe(true)
  })
})
