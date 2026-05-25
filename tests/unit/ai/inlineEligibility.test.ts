import { describe, it, expect } from 'vitest'
import {
  INLINE_AI_BLOCK_TYPES,
  INLINE_AI_FIELDS_BY_BLOCK,
  isInlineAiEligible,
  getInlineFieldsForBlock,
  supportsSuggest,
  resolveFieldValues,
  mergeFieldValues,
  countEmptyFields,
  isMostlyEmpty,
} from '@/lib/ai/inlineEligibility'
import { blockSchemas } from '@/lib/cms/block-registry'

describe('INLINE_AI_BLOCK_TYPES', () => {
  it('only contains known block-registry types', () => {
    const registered = new Set(Object.keys(blockSchemas))
    for (const type of INLINE_AI_BLOCK_TYPES) {
      expect(registered.has(type)).toBe(true)
    }
  })

  it('excludes structural-only blocks (no text fields)', () => {
    const structuralOnly = ['image', 'gallery', 'divider', 'spacer', 'social_icons', 'star_rating', 'video_embed', 'lx_space', 'lx_image_pair', 'lx_cover_image', 'lx_map']
    for (const type of structuralOnly) {
      expect(isInlineAiEligible(type)).toBe(false)
    }
  })

  it('every eligible block has at least one text field', () => {
    for (const type of INLINE_AI_BLOCK_TYPES) {
      const fields = getInlineFieldsForBlock(type)
      expect(fields.length).toBeGreaterThan(0)
    }
  })

  it('every block has at most one primary field', () => {
    for (const type of INLINE_AI_BLOCK_TYPES) {
      const fields = INLINE_AI_FIELDS_BY_BLOCK[type]!
      const primaries = fields.filter((f) => f.primary)
      expect(primaries.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('isInlineAiEligible', () => {
  it('returns true for known eligible types', () => {
    expect(isInlineAiEligible('lx_heading')).toBe(true)
    expect(isInlineAiEligible('hero')).toBe(true)
    expect(isInlineAiEligible('accordion')).toBe(true)
  })

  it('returns false for sections + columns + unknown types', () => {
    expect(isInlineAiEligible('section')).toBe(false)
    expect(isInlineAiEligible('column')).toBe(false)
    expect(isInlineAiEligible('unknown_type_xyz')).toBe(false)
    expect(isInlineAiEligible('image')).toBe(false)
  })
})

describe('supportsSuggest', () => {
  it('true for blocks with a short primary scalar', () => {
    expect(supportsSuggest('lx_heading')).toBe(true) // text, max title
    expect(supportsSuggest('heading')).toBe(true)
    expect(supportsSuggest('button')).toBe(true)
    expect(supportsSuggest('lx_eyebrow')).toBe(true)
  })

  it('false for blocks with no primary field (item-only)', () => {
    expect(supportsSuggest('accordion')).toBe(false)
    expect(supportsSuggest('tabs')).toBe(false)
    expect(supportsSuggest('stats_row')).toBe(false)
    expect(supportsSuggest('icon_list')).toBe(false)
  })

  it('false for blocks whose primary is a long-form richtext', () => {
    expect(supportsSuggest('text')).toBe(false) // body_richtext primary, long
    expect(supportsSuggest('lx_text')).toBe(false)
  })
})

describe('resolveFieldValues', () => {
  it('reads flat scalars', () => {
    const data = { text: 'Welcome', level: 'h1' }
    const out = resolveFieldValues('lx_heading', data)
    expect(out).toEqual([
      {
        path: 'text',
        kind: 'plain',
        maxLength: 220,
        primary: true,
        value: 'Welcome',
      },
    ])
  })

  it('reads nested scalars', () => {
    const data = {
      title: 'Hi',
      subtitle: 'sub',
      image: { media_id: 1, alt: 'a' },
      cta: { text: 'Go', href: '/x', openInNew: false },
    }
    const out = resolveFieldValues('hero', data)
    const paths = out.map((f) => f.path).sort()
    expect(paths).toEqual(['cta.text', 'subtitle', 'title'])
    expect(out.find((f) => f.path === 'cta.text')!.value).toBe('Go')
  })

  it('expands `items[]` into per-index concrete paths', () => {
    const data = {
      items: [
        { title: 'a', body_richtext: '<p>A</p>' },
        { title: 'b', body_richtext: '<p>B</p>' },
      ],
    }
    const out = resolveFieldValues('accordion', data)
    const paths = out.map((f) => f.path).sort()
    expect(paths).toEqual([
      'items[0].body_richtext',
      'items[0].title',
      'items[1].body_richtext',
      'items[1].title',
    ])
    const t0 = out.find((f) => f.path === 'items[0].title')
    expect(t0?.value).toBe('a')
  })

  it('returns empty array for non-object data', () => {
    expect(resolveFieldValues('lx_heading', null)).toEqual([])
    expect(resolveFieldValues('lx_heading', undefined)).toEqual([])
    expect(resolveFieldValues('lx_heading', 'string')).toEqual([])
  })

  it('handles missing nested keys gracefully', () => {
    const data = { title: 'T' } // hero with no cta
    const out = resolveFieldValues('hero', data)
    // cta.text should resolve to '' (missing)
    const cta = out.find((f) => f.path === 'cta.text')
    expect(cta?.value).toBe('')
  })
})

describe('mergeFieldValues', () => {
  it('writes a flat scalar without mutating the input', () => {
    const original = { text: 'old' }
    const next = mergeFieldValues(original, { text: 'new' }) as { text: string }
    expect(next.text).toBe('new')
    expect(original.text).toBe('old')
  })

  it('writes a nested scalar', () => {
    const original = { cta: { text: 'a', href: '/x' } }
    const next = mergeFieldValues(original, { 'cta.text': 'b' }) as {
      cta: { text: string; href: string }
    }
    expect(next.cta.text).toBe('b')
    expect(next.cta.href).toBe('/x')
  })

  it('writes into an indexed array element', () => {
    const original = { items: [{ title: 'a' }, { title: 'b' }] }
    const next = mergeFieldValues(original, { 'items[1].title': 'B' }) as {
      items: Array<{ title: string }>
    }
    expect(next.items[1]!.title).toBe('B')
    expect(next.items[0]!.title).toBe('a')
  })

  it('drops prototype-pollution keys', () => {
    const original = { text: 'x' }
    const next = mergeFieldValues(original, {
      __proto__: 'evil',
      text: 'safe',
    } as Record<string, string>) as { text: string }
    expect(next.text).toBe('safe')
    expect(({} as Record<string, unknown>)['__proto__']).not.toBe('evil')
  })

  it('drops paths that don\'t exist on the source', () => {
    const original = { text: 'x' }
    const next = mergeFieldValues(original, {
      'cta.text': 'invented',
      text: 'kept',
    }) as { text: string; cta?: unknown }
    expect(next.text).toBe('kept')
    expect(next.cta).toBeUndefined()
  })

  it('drops paths whose segments don\'t match the safe pattern', () => {
    const original = { items: [{ title: 'a' }] }
    // Bracket index out of bounds, malformed paths
    const next = mergeFieldValues(original, {
      'items[99].title': 'invented',
      'evil; DROP TABLE': 'sql',
    } as Record<string, string>) as { items: Array<{ title: string }> }
    expect(next.items[0]!.title).toBe('a')
    expect(next.items.length).toBe(1)
  })
})

describe('countEmptyFields + isMostlyEmpty', () => {
  it('counts empty/whitespace-only text fields', () => {
    expect(countEmptyFields('lx_heading', { text: '' })).toBe(1)
    expect(countEmptyFields('lx_heading', { text: '   ' })).toBe(1)
    expect(countEmptyFields('lx_heading', { text: 'Welcome' })).toBe(0)
  })

  it('isMostlyEmpty true when all primaries are blank', () => {
    expect(isMostlyEmpty('lx_heading', { text: '' })).toBe(true)
    expect(isMostlyEmpty('lx_heading', { text: 'x' })).toBe(false)
  })

  it('isMostlyEmpty true on item-only blocks when ALL items are blank', () => {
    expect(
      isMostlyEmpty('accordion', {
        items: [{ title: '', body_richtext: '' }],
      }),
    ).toBe(true)
    expect(
      isMostlyEmpty('accordion', {
        items: [{ title: 'a', body_richtext: '' }],
      }),
    ).toBe(false)
  })

  it('isMostlyEmpty false when there are no resolvable fields at all', () => {
    expect(isMostlyEmpty('lx_heading', null)).toBe(false)
  })
})
