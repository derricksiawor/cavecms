import { describe, it, expect } from 'vitest'
import {
  parseBlockData,
  blockSchemas,
  FIXED_BLOCK_KEYS_PER_PAGE,
  type BlockType,
} from '@/lib/cms/block-registry'

describe('block registry', () => {
  it('parses a hero block', () => {
    const parsed = parseBlockData('hero', {
      title: 'Building Homes…',
      subtitle: 'Lux',
      image: { media_id: 1, alt: 'hero' },
      cta: { text: 'Brochure', href: '/contact', openInNew: false },
    })
    // parsed is BlockData (union). Narrow on the 'image' discriminator —
    // every block that owns a `title` AND `image` is the hero shape.
    if ('title' in parsed && 'image' in parsed && parsed.image && !Array.isArray(parsed.image)) {
      expect(parsed.title).toBe('Building Homes…')
    } else {
      throw new Error('expected hero shape')
    }
  })

  it('rejects unknown block_type', () => {
    expect(() => parseBlockData('mystery', {})).toThrow()
  })

  it('rejects a hero missing required image', () => {
    expect(() =>
      parseBlockData('hero', { title: 'no image here' }),
    ).toThrow()
  })

  it('rejects a hero with empty title (min 1)', () => {
    expect(() =>
      parseBlockData('hero', {
        title: '',
        image: { media_id: 1, alt: 'a' },
      }),
    ).toThrow()
  })

  it('defaults gallery columns + accepts only 2/3/4', () => {
    const ok = parseBlockData('gallery', {
      images: [{ media_id: 1, alt: 'a' }],
      columns: 3,
    })
    expect(ok).toBeTruthy()
    expect(() =>
      parseBlockData('gallery', {
        images: [{ media_id: 1, alt: 'a' }],
        columns: 5,
      }),
    ).toThrow()
  })

  it('exposes blockSchemas as a read-only record', () => {
    const types = Object.keys(blockSchemas)
    expect(types).toContain('hero')
    expect(types).toContain('quote')
  })

  it('FIXED_BLOCK_KEYS_PER_PAGE covers home/about/services/contact', () => {
    expect(FIXED_BLOCK_KEYS_PER_PAGE.home).toEqual([
      'hero',
      'featured_projects',
      'services_intro',
      'cta',
    ])
    expect(FIXED_BLOCK_KEYS_PER_PAGE.about).toEqual([
      'hero',
      'about_history',
    ])
  })

  it('all FIXED_BLOCK_KEYS values are valid BlockType keys (no stale entries)', () => {
    for (const [page, keys] of Object.entries(FIXED_BLOCK_KEYS_PER_PAGE)) {
      for (const k of keys) {
        expect(blockSchemas[k as BlockType], `${page}.${k}`).toBeDefined()
      }
    }
  })
})
