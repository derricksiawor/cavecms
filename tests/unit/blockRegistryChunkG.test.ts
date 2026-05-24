import { describe, it, expect } from 'vitest'
import { parseBlockData } from '@/lib/cms/block-registry'

// Focused tests for the Chunk G widget schemas. The blockSeeds CI pin
// already round-trips every seed payload; these tests cover the
// adversarial / boundary inputs that the seed alone can't exercise -
// rejecting bad data, accepting good data with optional fields, and
// confirming the URL-allowlist refines actually fire.

describe('block registry - Chunk G - alert', () => {
  it('accepts a minimal alert', () => {
    expect(() =>
      parseBlockData('alert', { variant: 'info', title: 'Heads up' }),
    ).not.toThrow()
  })

  it('defaults variant + dismissible when omitted', () => {
    const parsed = parseBlockData('alert', { title: 'No variant' }) as {
      variant: string
      dismissible: boolean
      body_richtext: string
    }
    expect(parsed.variant).toBe('info')
    expect(parsed.dismissible).toBe(false)
    expect(parsed.body_richtext).toBe('')
  })

  it('rejects an empty title (min 1)', () => {
    expect(() => parseBlockData('alert', { title: '' })).toThrow()
  })

  it('rejects unknown variant', () => {
    expect(() =>
      parseBlockData('alert', { title: 'ok', variant: 'critical' }),
    ).toThrow()
  })
})

describe('block registry - Chunk G - social_icons', () => {
  it('accepts a single-item profile list', () => {
    expect(() =>
      parseBlockData('social_icons', {
        items: [{ platform: 'instagram', url: 'https://instagram.com/handle' }],
      }),
    ).not.toThrow()
  })

  it('rejects an empty items array', () => {
    expect(() =>
      parseBlockData('social_icons', { items: [] }),
    ).toThrow()
  })

  it('rejects unknown platform', () => {
    expect(() =>
      parseBlockData('social_icons', {
        items: [{ platform: 'mastodon', url: 'https://mastodon.social/u' }],
      }),
    ).toThrow()
  })

  it('rejects http:// URL (https only)', () => {
    expect(() =>
      parseBlockData('social_icons', {
        items: [{ platform: 'instagram', url: 'http://instagram.com/x' }],
      }),
    ).toThrow()
  })

  it('rejects javascript: URL', () => {
    expect(() =>
      parseBlockData('social_icons', {
        items: [{ platform: 'instagram', url: 'javascript:alert(1)' }],
      }),
    ).toThrow()
  })

  it('rejects userinfo smuggle in URL', () => {
    expect(() =>
      parseBlockData('social_icons', {
        items: [
          {
            platform: 'instagram',
            url: 'https://evil.com@instagram.com/handle',
          },
        ],
      }),
    ).toThrow()
  })
})

describe('block registry - Chunk G - star_rating', () => {
  it('accepts a half-star value', () => {
    expect(() => parseBlockData('star_rating', { value: 3.5 })).not.toThrow()
  })

  it('accepts 0 and 5', () => {
    expect(() => parseBlockData('star_rating', { value: 0 })).not.toThrow()
    expect(() => parseBlockData('star_rating', { value: 5 })).not.toThrow()
  })

  it('rejects below 0 and above 5', () => {
    expect(() => parseBlockData('star_rating', { value: -0.5 })).toThrow()
    expect(() => parseBlockData('star_rating', { value: 5.5 })).toThrow()
  })

  it('accepts optional label + review_count', () => {
    expect(() =>
      parseBlockData('star_rating', {
        value: 4.5,
        label: 'Client rating',
        review_count: 412,
      }),
    ).not.toThrow()
  })
})

describe('block registry - Chunk G - stats_row', () => {
  it('accepts a single-item solo counter', () => {
    expect(() =>
      parseBlockData('stats_row', {
        items: [{ value: 100, label: 'Properties' }],
        layout: 'solo',
      }),
    ).not.toThrow()
  })

  it('rejects 7 items (max 6)', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      value: i,
      label: `Item ${i}`,
    }))
    expect(() => parseBlockData('stats_row', { items, layout: '4up' })).toThrow()
  })

  it('rejects empty label on an item', () => {
    expect(() =>
      parseBlockData('stats_row', {
        items: [{ value: 100, label: '' }],
      }),
    ).toThrow()
  })

  it('rejects NaN value', () => {
    expect(() =>
      parseBlockData('stats_row', {
        items: [{ value: NaN, label: 'x' }],
      }),
    ).toThrow()
  })

  it('rejects negative duration_ms', () => {
    expect(() =>
      parseBlockData('stats_row', {
        items: [{ value: 1, label: 'x', duration_ms: -100 }],
      }),
    ).toThrow()
  })
})

describe('block registry - Chunk G - testimonial', () => {
  it('accepts a minimal testimonial', () => {
    expect(() =>
      parseBlockData('testimonial', { quote: 'They were great.' }),
    ).not.toThrow()
  })

  it('rejects an empty quote', () => {
    expect(() => parseBlockData('testimonial', { quote: '' })).toThrow()
  })

  it('accepts optional image + project_id + role', () => {
    expect(() =>
      parseBlockData('testimonial', {
        quote: 'Excellent service.',
        attribution: 'Jane Doe',
        role: 'Buyer',
        image: { media_id: 42, alt: 'Jane' },
        project_id: 7,
      }),
    ).not.toThrow()
  })

  it('rejects negative project_id', () => {
    expect(() =>
      parseBlockData('testimonial', {
        quote: 'x',
        project_id: -1,
      }),
    ).toThrow()
  })
})

describe('block registry - Chunk G - video_embed', () => {
  it('accepts a valid YouTube embed URL', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
      }),
    ).not.toThrow()
  })

  it('accepts a valid Vimeo player URL', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'https://player.vimeo.com/video/76979871',
      }),
    ).not.toThrow()
  })

  it('rejects a youtube.com/watch URL', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }),
    ).toThrow()
  })

  it('rejects an evil.com URL with embed-shaped path', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'https://evil.com/embed/dQw4w9WgXcQ',
      }),
    ).toThrow()
  })

  it('rejects a javascript: URL', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'javascript:alert(1)',
      }),
    ).toThrow()
  })

  it('rejects a userinfo-smuggled URL', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'https://evil.com@www.youtube.com/embed/dQw4w9WgXcQ',
      }),
    ).toThrow()
  })

  it('rejects a URL over 500 chars', () => {
    expect(() =>
      parseBlockData('video_embed', {
        url: 'https://www.youtube.com/embed/' + 'a'.repeat(600),
      }),
    ).toThrow()
  })
})

// Boundary tests added by Chunk G review-loop round 1. Each pins a
// schema invariant that a future schema rewrite could silently break.
describe('block registry - Chunk G - boundary pins', () => {
  it('rejects social_icons with 8 items (max 7)', () => {
    const items = Array.from({ length: 8 }, () => ({
      platform: 'instagram' as const,
      url: 'https://instagram.com/handle',
    }))
    expect(() => parseBlockData('social_icons', { items })).toThrow()
  })

  it('rejects stats_row with empty items (min 1)', () => {
    expect(() =>
      parseBlockData('stats_row', { items: [], layout: '3up' }),
    ).toThrow()
  })

  it('rejects stats_row duration_ms over 10000', () => {
    expect(() =>
      parseBlockData('stats_row', {
        items: [{ value: 1, label: 'x', duration_ms: 10001 }],
      }),
    ).toThrow()
  })

  it('rejects testimonial.image.media_id <= 0', () => {
    expect(() =>
      parseBlockData('testimonial', {
        quote: 'ok',
        image: { media_id: 0, alt: 'x' },
      }),
    ).toThrow()
    expect(() =>
      parseBlockData('testimonial', {
        quote: 'ok',
        image: { media_id: -1, alt: 'x' },
      }),
    ).toThrow()
  })

  it('rejects star_rating Infinity and NaN', () => {
    expect(() =>
      parseBlockData('star_rating', { value: Number.POSITIVE_INFINITY }),
    ).toThrow()
    expect(() => parseBlockData('star_rating', { value: NaN })).toThrow()
  })
})
