import { describe, it, expect } from 'vitest'
import {
  parseBlockData,
  blockSchemas,
  FIXED_BLOCK_KEYS_PER_PAGE,
  type BlockType,
} from '@/lib/cms/block-registry'

describe('block registry', () => {
  it('parses an lx_heading block', () => {
    const parsed = parseBlockData('lx_heading', { text: 'A bold opening' })
    if ('text' in parsed && typeof parsed.text === 'string') {
      expect(parsed.text).toBe('A bold opening')
    } else {
      throw new Error('expected lx_heading shape')
    }
  })

  it('rejects unknown block_type', () => {
    expect(() => parseBlockData('mystery', {})).toThrow()
  })

  it('rejects an lx_cover_image missing required image', () => {
    expect(() => parseBlockData('lx_cover_image', {})).toThrow()
  })

  it('rejects an lx_heading with empty text (min 1)', () => {
    expect(() => parseBlockData('lx_heading', { text: '' })).toThrow()
  })

  it('defaults lx_gallery columns + accepts only 2/3/4', () => {
    const ok = parseBlockData('lx_gallery', {
      images: [{ media_id: 1, alt: 'a' }],
      columns: 3,
    })
    expect(ok).toBeTruthy()
    expect(() =>
      parseBlockData('lx_gallery', {
        images: [{ media_id: 1, alt: 'a' }],
        columns: 5,
      }),
    ).toThrow()
  })

  it('exposes blockSchemas as a read-only record of lx_* types', () => {
    const types = Object.keys(blockSchemas)
    expect(types).toContain('lx_heading')
    expect(types).toContain('lx_quote')
    expect(types).toContain('lx_cta_banner')
    expect(types).toContain('lx_gallery')
    expect(types).toContain('contact_form')
  })

  it('FIXED_BLOCK_KEYS_PER_PAGE covers contact only after the legacy purge', () => {
    // Luxury 2.0: home/about/services no longer carry pre-seeded
    // fixed-slot widgets — those pages are block-tree-driven via
    // systemPageBlocks.ts. contact_form remains a fixed slot because
    // the lead route queries by block_key='contact_form'.
    expect(FIXED_BLOCK_KEYS_PER_PAGE.contact).toEqual(['contact_form'])
    expect(FIXED_BLOCK_KEYS_PER_PAGE.home).toBeUndefined()
    expect(FIXED_BLOCK_KEYS_PER_PAGE.about).toBeUndefined()
    expect(FIXED_BLOCK_KEYS_PER_PAGE.services).toBeUndefined()
  })

  it('all FIXED_BLOCK_KEYS values are valid BlockType keys (no stale entries)', () => {
    for (const [page, keys] of Object.entries(FIXED_BLOCK_KEYS_PER_PAGE)) {
      for (const k of keys) {
        expect(blockSchemas[k as BlockType], `${page}.${k}`).toBeDefined()
      }
    }
  })
})
