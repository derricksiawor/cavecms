import { describe, expect, it } from 'vitest'
import {
  ColumnMetaSchema,
  SectionMetaSchema,
  WidgetMetaSchema,
  parseColumnMeta,
  parseSectionMeta,
  parseWidgetMeta,
} from '@/lib/cms/blockMeta'
import {
  hasSpacingOverride,
  spacingClass,
  type SpacingMeta,
} from '@/lib/cms/spacingClasses'
import {
  PADDING_TIER_CLASS,
  SPACING_TIERS,
  isSpacingTier,
  stepTier,
  type SpacingTier,
} from '@/lib/cms/spacingTokens'

// Chunk E foundation tests. Pins the schema's tolerant-read + strict-
// write contract, the spacingClass derivation, the tier scale, and
// the round-trip stability that the API + render layers depend on.

describe('spacingTokens.isSpacingTier', () => {
  it('accepts every declared tier', () => {
    for (const t of SPACING_TIERS) expect(isSpacingTier(t)).toBe(true)
  })
  it('rejects unknown strings + non-strings', () => {
    for (const v of ['', 'huge', 'XL', 0, null, undefined, {}, []]) {
      expect(isSpacingTier(v)).toBe(false)
    }
  })
})

describe('spacingTokens.stepTier', () => {
  it('walks up the scale', () => {
    expect(stepTier('none', 1)).toBe('xs')
    expect(stepTier('xs', 1)).toBe('sm')
    expect(stepTier('xl', 1)).toBe('2xl')
  })
  it('walks down the scale', () => {
    expect(stepTier('2xl', -1)).toBe('xl')
    expect(stepTier('xs', -1)).toBe('none')
  })
  it('clamps at endpoints (no wrap-around)', () => {
    expect(stepTier('none', -1)).toBe('none')
    expect(stepTier('2xl', 1)).toBe('2xl')
  })
})

describe('parseSectionMeta — spacing extension', () => {
  it('reads valid spacing tiers alongside legacy fields', () => {
    const parsed = parseSectionMeta({
      background: 'cream',
      padding: 'md',
      columns: 2,
      paddingTop: 'lg',
      marginBottom: 'xs',
    })
    expect(parsed.background).toBe('cream')
    expect(parsed.padding).toBe('md')
    expect(parsed.columns).toBe(2)
    expect(parsed.paddingTop).toBe('lg')
    expect(parsed.marginBottom).toBe('xs')
  })
  it('drops unknown spacing tier strings silently', () => {
    const parsed = parseSectionMeta({
      background: 'cream',
      padding: 'md',
      columns: 1,
      paddingTop: 'huge', // invalid tier
      paddingBottom: -5, // padding cannot be negative
    })
    expect(parsed.paddingTop).toBeUndefined()
    expect(parsed.paddingBottom).toBeUndefined()
  })
  it('accepts numeric (px) padding in 0..512 and margin in -512..512', () => {
    const parsed = parseSectionMeta({
      background: 'cream',
      padding: 'md',
      columns: 1,
      paddingTop: 24,
      paddingBottom: 0,
      marginBottom: 0,
      marginTop: -32, // negative margin to pull element up
      marginLeft: -8,
    })
    expect(parsed.paddingTop).toBe(24)
    expect(parsed.paddingBottom).toBe(0)
    expect(parsed.marginBottom).toBe(0)
    expect(parsed.marginTop).toBe(-32)
    expect(parsed.marginLeft).toBe(-8)
  })
  it('drops out-of-range px (padding < 0, margin < -512, |v| > 512) and non-integers', () => {
    const parsed = parseSectionMeta({
      background: 'cream',
      padding: 'md',
      columns: 1,
      paddingTop: 513, // over max
      paddingBottom: 12.5, // not integer
      paddingLeft: -1, // padding rejects negative
      marginTop: -513, // margin below min
      marginRight: 513, // margin above max
      marginBottom: -7.5, // non-integer
    })
    expect(parsed.paddingTop).toBeUndefined()
    expect(parsed.paddingBottom).toBeUndefined()
    expect(parsed.paddingLeft).toBeUndefined()
    expect(parsed.marginTop).toBeUndefined()
    expect(parsed.marginRight).toBeUndefined()
    expect(parsed.marginBottom).toBeUndefined()
  })
  it('returns DEFAULT_SECTION_META on non-object', () => {
    const parsed = parseSectionMeta(null)
    expect(parsed.columns).toBe(1)
    expect(parsed.paddingTop).toBeUndefined()
  })
})

describe('parseColumnMeta — spacing extension', () => {
  it('preserves width when paired with spacing', () => {
    const parsed = parseColumnMeta({ width: 6, paddingLeft: 'sm' })
    expect(parsed.width).toBe(6)
    expect(parsed.paddingLeft).toBe('sm')
  })
  it('strips invalid width but keeps valid spacing', () => {
    const parsed = parseColumnMeta({ width: 99, marginTop: 'md' })
    expect(parsed.width).toBeUndefined()
    expect(parsed.marginTop).toBe('md')
  })
  it('returns {} on non-object', () => {
    expect(parseColumnMeta(undefined)).toEqual({})
    expect(parseColumnMeta('string')).toEqual({})
  })
})

describe('parseWidgetMeta', () => {
  it('reads spacing tiers from a widget meta blob', () => {
    const parsed = parseWidgetMeta({
      paddingTop: 'lg',
      paddingBottom: 'xs',
      marginTop: '2xl',
    })
    expect(parsed.paddingTop).toBe('lg')
    expect(parsed.paddingBottom).toBe('xs')
    expect(parsed.marginTop).toBe('2xl')
  })
  it('drops non-spacing fields silently', () => {
    const parsed = parseWidgetMeta({
      paddingTop: 'md',
      background: 'near-black', // foreign field
      width: 6, // foreign field
    })
    expect(parsed.paddingTop).toBe('md')
    expect((parsed as Record<string, unknown>)['background']).toBeUndefined()
    expect((parsed as Record<string, unknown>)['width']).toBeUndefined()
  })
  it('returns {} on null / undefined / non-object', () => {
    expect(parseWidgetMeta(null)).toEqual({})
    expect(parseWidgetMeta(undefined)).toEqual({})
    expect(parseWidgetMeta(42)).toEqual({})
    expect(parseWidgetMeta('x')).toEqual({})
  })
})

describe('SectionMetaSchema — strict write boundary', () => {
  // Section meta REQUIRES the three core fields (columns/background/
  // padding) — every test that needs a passing payload includes them.
  const core = {
    columns: 1 as const,
    background: 'cream' as const,
    padding: 'md' as const,
  }
  it('accepts every spacing axis on top of the required core fields', () => {
    const r = SectionMetaSchema.safeParse({
      ...core,
      paddingTop: 'lg',
      paddingRight: 'sm',
      paddingBottom: 'md',
      paddingLeft: 'none',
      marginTop: 'xl',
      marginRight: '2xl',
      marginBottom: 'xs',
      marginLeft: 'sm',
    })
    expect(r.success).toBe(true)
  })
  it('rejects unknown tier value', () => {
    const r = SectionMetaSchema.safeParse({ ...core, paddingTop: 'huge' })
    expect(r.success).toBe(false)
  })
  it('rejects unknown top-level key (.strict)', () => {
    const r = SectionMetaSchema.safeParse({ ...core, tampered: true })
    expect(r.success).toBe(false)
  })
  it('rejects payload missing core fields (no silent wipe)', () => {
    // Probe sending {} would otherwise wipe persisted background/
    // padding/columns to JSON {} — Chunk E review M-H.
    expect(SectionMetaSchema.safeParse({}).success).toBe(false)
    expect(
      SectionMetaSchema.safeParse({ background: 'cream' }).success,
    ).toBe(false)
  })
})

describe('ColumnMetaSchema — strict write boundary', () => {
  it('accepts width + spacing together', () => {
    const r = ColumnMetaSchema.safeParse({ width: 6, paddingTop: 'md' })
    expect(r.success).toBe(true)
  })
  it('rejects unknown top-level key', () => {
    const r = ColumnMetaSchema.safeParse({ width: 6, background: 'cream' })
    expect(r.success).toBe(false)
  })
})

describe('WidgetMetaSchema — strict write boundary', () => {
  it('accepts spacing-only payload', () => {
    const r = WidgetMetaSchema.safeParse({
      paddingTop: 'lg',
      marginLeft: 'xs',
    })
    expect(r.success).toBe(true)
  })
  it('accepts empty payload', () => {
    expect(WidgetMetaSchema.safeParse({}).success).toBe(true)
  })
  it('rejects any non-spacing key (.strict gate)', () => {
    expect(
      WidgetMetaSchema.safeParse({ background: 'cream' }).success,
    ).toBe(false)
    expect(WidgetMetaSchema.safeParse({ width: 6 }).success).toBe(false)
    expect(
      WidgetMetaSchema.safeParse({ paddingTop: 'lg', tampered: 1 }).success,
    ).toBe(false)
  })
  it('rejects invalid tier value', () => {
    expect(
      WidgetMetaSchema.safeParse({ paddingTop: 'huge' }).success,
    ).toBe(false)
  })
})

describe('spacingClass derivation', () => {
  it('returns empty string for null / undefined / empty', () => {
    expect(spacingClass(null)).toBe('')
    expect(spacingClass(undefined)).toBe('')
    expect(spacingClass({})).toBe('')
  })
  it('emits !-important utility for each set axis', () => {
    const meta: SpacingMeta = { paddingTop: 'lg', marginBottom: 'xs' }
    const cls = spacingClass(meta)
    expect(cls).toContain('!pt-16')
    expect(cls).toContain('!mb-2')
  })
  it('omits unset axes', () => {
    const cls = spacingClass({ paddingTop: 'md' })
    expect(cls).toBe('!pt-8')
  })
  it('uses the tier registry lookup (no stringification)', () => {
    // Every emitted class string MUST match the registry's static
    // literal. A regression that switches to `${prefix}${tier}` would
    // silently drop classes from Tailwind's JIT pass.
    const cls = spacingClass({
      paddingTop: 'none',
      paddingRight: 'xs',
      paddingBottom: 'sm',
      paddingLeft: 'md',
    })
    expect(cls).toContain(PADDING_TIER_CLASS.top.none)
    expect(cls).toContain(PADDING_TIER_CLASS.right.xs)
    expect(cls).toContain(PADDING_TIER_CLASS.bottom.sm)
    expect(cls).toContain(PADDING_TIER_CLASS.left.md)
  })
})

describe('hasSpacingOverride', () => {
  it('false for null / empty', () => {
    expect(hasSpacingOverride(null)).toBe(false)
    expect(hasSpacingOverride({})).toBe(false)
  })
  it('true when any axis is set', () => {
    expect(hasSpacingOverride({ paddingTop: 'none' })).toBe(true)
    expect(hasSpacingOverride({ marginLeft: '2xl' })).toBe(true)
  })
})

describe('round-trip: schema → parser → spacingClass', () => {
  it('preserves a full per-side blob through the boundary', () => {
    const input = {
      paddingTop: 'lg' as SpacingTier,
      paddingRight: 'sm' as SpacingTier,
      paddingBottom: 'md' as SpacingTier,
      paddingLeft: 'xs' as SpacingTier,
      marginTop: 'xl' as SpacingTier,
      marginRight: '2xl' as SpacingTier,
      marginBottom: 'none' as SpacingTier,
      marginLeft: 'sm' as SpacingTier,
    }
    const validated = WidgetMetaSchema.parse(input)
    // JSON.stringify round-trip emulates DB store + fetch.
    const persisted = JSON.parse(JSON.stringify(validated))
    const reparsed = parseWidgetMeta(persisted)
    const cls = spacingClass(reparsed)
    // All 8 utility classes appear in the rendered className.
    expect(cls).toContain('!pt-16')
    expect(cls).toContain('!pr-4')
    expect(cls).toContain('!pb-8')
    expect(cls).toContain('!pl-2')
    expect(cls).toContain('!mt-24')
    expect(cls).toContain('!mr-32')
    expect(cls).toContain('!mb-0')
    expect(cls).toContain('!ml-4')
  })
})
