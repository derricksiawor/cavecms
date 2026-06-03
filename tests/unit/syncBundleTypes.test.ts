import { describe, it, expect } from 'vitest'
import {
  SyncBundle,
  PUSH_SETTING_KEYS,
  BUNDLE_FORMAT_VERSION,
} from '@/lib/sync/bundleTypes'

const minimalManifest = {
  formatVersion: BUNDLE_FORMAT_VERSION,
  createdAt: '2026-06-01T00:00:00.000Z',
  sourceUrl: 'http://localhost:3040',
  baselineContentHash: null,
  contentHash: 'abc',
  counts: { pages: 0, posts: 0, projects: 0, media: 0, settings: 0 },
}

describe('bundleTypes', () => {
  it('exposes exactly the 8 token-writable push setting keys, in order', () => {
    expect([...PUSH_SETTING_KEYS]).toEqual([
      'contact_info',
      'social_links',
      'default_seo',
      'footer',
      'site_header',
      'organization_json_ld',
      'theme_palette',
      'mobile_cta',
    ])
  })

  it('rejects a bundle with the wrong formatVersion', () => {
    const r = SyncBundle.safeParse({
      manifest: { ...minimalManifest, formatVersion: 2 },
      pages: [],
      posts: [],
      projects: [],
      settings: {},
      media: [],
    })
    expect(r.success).toBe(false)
  })

  it('accepts a minimal valid bundle', () => {
    const r = SyncBundle.safeParse({
      manifest: minimalManifest,
      pages: [],
      posts: [],
      projects: [],
      settings: {},
      media: [],
    })
    expect(r.success).toBe(true)
  })

  it('accepts a page with a media-ref-bearing widget tree', () => {
    const r = SyncBundle.safeParse({
      manifest: minimalManifest,
      pages: [
        {
          slug: 'home',
          title: 'Home',
          isHome: true,
          system: false,
          published: true,
          seoTitle: null,
          seoDescription: null,
          ogImageKey: null,
          heroImageKey: 'abc123def4567890',
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
                      blockType: 'lx_cover_image',
                      data: { title: 'A', image: { alt: 'hero' } },
                      _mediaRefs: { image: 'abc123def4567890' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      posts: [],
      projects: [],
      settings: {},
      media: [
        {
          bundleKey: 'abc123def4567890',
          originalName: 'hero.jpg',
          mime: 'image/jpeg',
          alt: 'hero',
          width: 1600,
          height: 900,
          byteSize: 12345,
          kind: 'image',
          files: { thumb: 'media/files/abc123def4567890-thumb.webp' },
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('rejects a media entry with an invalid kind', () => {
    const r = SyncBundle.safeParse({
      manifest: minimalManifest,
      pages: [],
      posts: [],
      projects: [],
      settings: {},
      media: [
        {
          bundleKey: 'k',
          originalName: 'x',
          mime: 'image/jpeg',
          alt: '',
          width: null,
          height: null,
          byteSize: 1,
          kind: 'video',
          files: {},
        },
      ],
    })
    expect(r.success).toBe(false)
  })
})
