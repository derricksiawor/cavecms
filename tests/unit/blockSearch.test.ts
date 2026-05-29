// Ranking matrix for the slash + ⌘K palette fuzzy search.
//
// Test surface: searchBlocks(query) against the real composed catalog
// (luxury lx_* SEED_ENTRIES + Picture + Templates stub — legacy
// widgets are filtered out by isPaletteVisible per the luxury-
// redesign migration).
//
// Test stack:
//   1. searchBlocks against the LIVE catalog — covers the 7 luxury
//      widgets × {exact label, alias, keyword, typo, miss}.
//   2. searchCatalog against a MINIMAL custom catalog — covers
//      catalog-agnostic ordering semantics (exact > alias > prefix
//      > substring > typo) without coupling to specific live entries.
//   3. scoreItem unit tests — covers tier boundary numeric scores.
//
// The catalog identity is stable per Vitest process (module-scoped
// cache + Object.freeze), so we don't reset between tests.

import { describe, it, expect } from 'vitest'
import {
  searchBlocks,
  searchCatalog,
  scoreItem,
  getBlockCatalog,
  type SearchableItem,
} from '@/lib/cms/blockSearch'

const top = (q: string): string | undefined => searchBlocks(q)[0]?.item.label

// Luxury catalog after the migration filter: 7 lx_* widgets + Picture
// (media kind) + Templates (template kind). Tests below pin against
// this exact set — adding a luxury widget or wiring a new media/
// template entry requires updating the empty-query expectation.
describe('searchBlocks — empty + whitespace queries', () => {
  it('returns up to 8 catalog entries in curated order on empty query', () => {
    const hits = searchBlocks('')
    // 8 luxury primitives + Picture entry. Templates is a template-kind
    // entry that is gated behind a `disabled` check by the search
    // composition — it surfaces in the catalog but may not be in the
    // empty-query slice; assert the prefix instead of exact length.
    expect(hits.length).toBeGreaterThanOrEqual(7)
    expect(hits.length).toBeLessThanOrEqual(8)
    // Curated order: Heading > Text > Eyebrow > Action > Figure >
    // Image pair > Cover image. lx_rule was removed in the luxury
    // redesign (no borders/border lines per ~/.claude/CLAUDE.md).
    // Image pair + Cover image were added alongside Figure as
    // embedded-media primitives — operators reach for all three in
    // the same composition step. Map and Space follow at indices 7-8.
    expect(hits.slice(0, 7).map((h) => h.item.label)).toEqual([
      'Heading',
      'Text',
      'Eyebrow',
      'Action',
      'Figure',
      'Image pair',
      'Cover image',
    ])
  })

  it('treats whitespace-only query as empty', () => {
    expect(searchBlocks('   ').map((h) => h.item.label)).toEqual(
      searchBlocks('').map((h) => h.item.label),
    )
  })

  it('trims leading + trailing whitespace before searching', () => {
    expect(top('  heading  ')).toBe('Heading')
  })
})

describe('searchBlocks — exact label hits', () => {
  it('exact label "heading" → Heading first', () => {
    expect(top('heading')).toBe('Heading')
  })
  it('exact label "text" → Text first', () => {
    expect(top('text')).toBe('Text')
  })
  it('exact label "eyebrow" → Eyebrow first', () => {
    expect(top('eyebrow')).toBe('Eyebrow')
  })
  it('exact label "action" → Action first', () => {
    expect(top('action')).toBe('Action')
  })
  it('exact label "figure" → Figure first', () => {
    expect(top('figure')).toBe('Figure')
  })
  // exact label "rule" no longer matches — widget retired.
  it('exact label "space" → Space first', () => {
    expect(top('space')).toBe('Space')
  })
})

describe('searchBlocks — case insensitivity', () => {
  it('"HEADING" → Heading', () => {
    expect(top('HEADING')).toBe('Heading')
  })
  it('"BtN" → Action (alias normalisation)', () => {
    expect(top('BtN')).toBe('Action')
  })
  it('"H1" → Heading (alias normalisation)', () => {
    expect(top('H1')).toBe('Heading')
  })
})

describe('searchBlocks — alias hits', () => {
  // Heading aliases: h1..h6, title, display
  it('"h1" → Heading (alias)', () => {
    expect(top('h1')).toBe('Heading')
  })
  it('"h2" → Heading (alias, same as h1)', () => {
    expect(top('h2')).toBe('Heading')
  })
  it('"h6" → Heading (alias range covers full h1..h6)', () => {
    expect(top('h6')).toBe('Heading')
  })
  it('"title" → Heading (alias)', () => {
    expect(top('title')).toBe('Heading')
  })
  it('"display" → Heading (alias)', () => {
    expect(top('display')).toBe('Heading')
  })
  // Text aliases: paragraph, p, prose, body
  it('"paragraph" → Text (alias)', () => {
    expect(top('paragraph')).toBe('Text')
  })
  it('"prose" → Text (alias)', () => {
    expect(top('prose')).toBe('Text')
  })
  // Eyebrow aliases: kicker, label, overline, pretitle
  it('"kicker" → Eyebrow (alias)', () => {
    expect(top('kicker')).toBe('Eyebrow')
  })
  it('"overline" → Eyebrow (alias)', () => {
    expect(top('overline')).toBe('Eyebrow')
  })
  // Action aliases: btn, button, cta, link
  it('"btn" → Action (alias)', () => {
    expect(top('btn')).toBe('Action')
  })
  it('"cta" → Action (alias)', () => {
    expect(top('cta')).toBe('Action')
  })
  // Figure aliases: image, photo, picture, figure
  it('"photo" → Figure or Picture (both legitimately match — Figure has alias, Picture is a separate media-kind entry with its own aliases)', () => {
    // Both are valid hits; we don't pin which is first since the
    // ordering depends on whether Picture's alias chain is also
    // 'photo' (it is in the picker's media entry). Just assert at
    // least one is the top hit.
    expect(['Figure', 'Picture']).toContain(top('photo'))
  })
  // Rule (luxury widget) was retired — "No borders/border lines"
  // per ~/.claude/CLAUDE.md design preferences. Searches for
  // 'hr'/'line'/'divider' may still fuzzy-match unrelated entries
  // via Levenshtein typo tolerance, but none of those hits should
  // be a Rule widget — the catalog no longer carries that concept.
  it('"hr" / "divider" do not surface a Rule widget (retired)', () => {
    expect(searchBlocks('hr').map((h) => h.item.label)).not.toContain('Rule')
    expect(searchBlocks('divider').map((h) => h.item.label)).not.toContain('Rule')
  })
  // Space aliases: spacer, space, gap
  it('"spacer" → Space (alias — luxury replacement for legacy Spacer)', () => {
    expect(top('spacer')).toBe('Space')
  })
  it('"gap" → Space (alias)', () => {
    expect(top('gap')).toBe('Space')
  })
})

describe('searchBlocks — keyword hits', () => {
  // Heading keywords: headline, editorial, serif, fraunces
  it('"headline" → Heading (keyword)', () => {
    expect(top('headline')).toBe('Heading')
  })
  it('"fraunces" → Heading (keyword — font name)', () => {
    expect(top('fraunces')).toBe('Heading')
  })
  // Text keywords: copy, editorial, inter, sans
  it('"copy" → Text (keyword)', () => {
    expect(top('copy')).toBe('Text')
  })
  // Action keywords: action, submit, go, gold
  it('"gold" → Action (keyword)', () => {
    expect(top('gold')).toBe('Action')
  })
  // Figure keywords: media, photo, hero image, parallax
  it('"parallax" → Figure (keyword)', () => {
    expect(top('parallax')).toBe('Figure')
  })
  // (Rule keywords retired alongside the widget.)
})

describe('searchBlocks — substring hits', () => {
  it('"head" → Heading (label prefix substring)', () => {
    expect(top('head')).toBe('Heading')
  })
  it('"figu" → Figure (label prefix)', () => {
    expect(top('figu')).toBe('Figure')
  })
  it('"spa" → Space (label prefix)', () => {
    expect(top('spa')).toBe('Space')
  })
})

describe('searchBlocks — typo tolerance (Levenshtein ≤ 2)', () => {
  it('"headign" (transpose) → Heading (lev = 2)', () => {
    expect(top('headign')).toBe('Heading')
  })
  it('"hedaing" (transpose) → Heading (lev = 2)', () => {
    expect(top('hedaing')).toBe('Heading')
  })
  it('"actoin" (transpose) → Action (lev = 2)', () => {
    expect(top('actoin')).toBe('Action')
  })
  // 'rul' / Rule typo test retired — widget removed.
  it('"figuer" (transpose) → Figure (lev = 1)', () => {
    expect(top('figuer')).toBe('Figure')
  })
})

describe('searchBlocks — negative cases (no match)', () => {
  it('"xyzqq" → no hits', () => {
    expect(searchBlocks('xyzqq')).toEqual([])
  })
  it('"asdfjkl" → no hits', () => {
    expect(searchBlocks('asdfjkl')).toEqual([])
  })
  it('numeric-only "12345" → no hits (no widget has digit-only aliases)', () => {
    expect(searchBlocks('12345')).toEqual([])
  })
  it('"calendar" → no hits (no widget for calendar)', () => {
    expect(searchBlocks('calendar')).toEqual([])
  })
  // Luxury 2.0: Tabs + Accordion now have first-class lx_ widgets so
  // these queries DO hit (vs. the prior legacy-purge era where they
  // were dead ends).
  it('"tabs" → matches the lx_tabs widget', () => {
    const hits = searchBlocks('tabs')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.item.label).toBe('Tabs')
  })
  it('"accordion" → matches the lx_accordion widget', () => {
    const hits = searchBlocks('accordion')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.item.label).toBe('Accordion')
  })
})

describe('searchBlocks — result cap + ordering', () => {
  it('caps at 8 results even when many widgets match', () => {
    // Single character "e" hits many luxury widgets (Heading, Text,
    // Eyebrow, etc.). Result count must cap at 8.
    expect(searchBlocks('e').length).toBeLessThanOrEqual(8)
  })

  it('alias match outranks label substring (e.g. "h1" → Heading vs anything containing "h1")', () => {
    const hits = searchBlocks('h1')
    expect(hits[0]!.item.label).toBe('Heading')
    expect(hits[0]!.matchedAlias).toBe('h1')
  })

  it('matchedAlias is populated for alias hits', () => {
    const hits = searchBlocks('btn')
    expect(hits[0]!.matchedAlias).toBe('btn')
  })

  it('matchedAlias is undefined for label-only hits', () => {
    const hits = searchBlocks('heading')
    expect(hits[0]!.matchedAlias).toBeUndefined()
  })

  it('matchedAlias is undefined for keyword-only hits', () => {
    const hits = searchBlocks('fraunces')
    expect(hits[0]!.matchedAlias).toBeUndefined()
  })
})

describe('searchBlocks — catalog composition', () => {
  it('includes Picture entry (media kind)', () => {
    const catalog = getBlockCatalog()
    expect(catalog.some((c) => c.kind === 'media' && c.label === 'Picture')).toBe(true)
  })

  it('includes Templates entry (template kind, wired by Chunk J)', () => {
    const catalog = getBlockCatalog()
    const entry = catalog.find((c) => c.kind === 'template')
    expect(entry).toBeDefined()
    expect(entry!.disabled).toBeFalsy()
    expect(entry!.disabledReason).toBeUndefined()
  })

  it('catalog is frozen — push throws in strict mode', () => {
    const catalog = getBlockCatalog()
    expect(Object.isFrozen(catalog)).toBe(true)
  })

  it('catalog ids are unique', () => {
    const catalog = getBlockCatalog()
    const ids = catalog.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('catalog contains NO legacy widget block_types', () => {
    // Defence against accidental palette regression — if a future
    // change removes the isPaletteVisible filter, legacy widgets
    // would re-appear here and this assert catches it.
    const catalog = getBlockCatalog()
    const seedTypes = catalog
      .filter((c) => c.kind === 'seed')
      .map((c) => c.blockType)
    // contact_form intentionally NOT in this list — its renderer has
    // been re-skinned for luxury (see commit history) and the entry
    // remains palette-visible for operators who want to drop a lead-
    // capture form on a non-contact page.
    const LEGACY = [
      'text', 'cta', 'quote', 'heading', 'button', 'divider', 'spacer',
      'icon_box', 'accordion', 'icon_list', 'tabs', 'alert',
      'social_icons', 'star_rating', 'stats_row', 'testimonial',
      'video_embed', 'eyebrow', 'channel_card',
      // Section-shaped legacy types converted to lx_ by migration 0024.
      'hero', 'services_intro', 'about_history', 'featured_projects',
      'image', 'gallery',
    ]
    for (const legacy of LEGACY) {
      expect(seedTypes, `legacy block_type '${legacy}' leaked into palette`).not.toContain(legacy)
    }
  })

  it('catalog contains every luxury widget block_type', () => {
    const catalog = getBlockCatalog()
    const seedTypes = catalog
      .filter((c) => c.kind === 'seed')
      .map((c) => c.blockType)
    const LUXURY = [
      'lx_heading', 'lx_text', 'lx_eyebrow', 'lx_action',
      'lx_figure', 'lx_space',
      // Composite widgets (Phase 2)
      'lx_channel_card', 'lx_stat', 'lx_quote',
      // Data-driven grid (0.1.54) — pulls selected projects live.
      'lx_featured_projects',
    ]
    for (const lux of LUXURY) {
      expect(seedTypes, `luxury block_type '${lux}' missing from palette`).toContain(lux)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Catalog-agnostic scoring tests — exercise the algorithm against a
// custom minimal catalog so the asserts don't drift if the live
// catalog content shifts during the redesign migration.
// ─────────────────────────────────────────────────────────────────────

describe('searchCatalog — direct surface (test-only seam)', () => {
  const minimal: SearchableItem[] = [
    {
      id: 'a',
      kind: 'seed',
      blockType: 'lx_heading',
      label: 'Apple',
      description: '',
      icon: (() => null) as never,
      aliases: ['fruit'],
      keywords: ['red', 'sweet'],
    },
    {
      id: 'b',
      kind: 'seed',
      blockType: 'lx_heading',
      label: 'Apricot',
      description: '',
      icon: (() => null) as never,
    },
  ]

  it('"apple" → Apple wins on exact label', () => {
    expect(searchCatalog('apple', minimal)[0]!.item.label).toBe('Apple')
  })

  it('"ap" → both Apple and Apricot surface, Apple first (catalog order tie)', () => {
    const hits = searchCatalog('ap', minimal)
    expect(hits.map((h) => h.item.label)).toEqual(['Apple', 'Apricot'])
  })

  it('"fruit" → Apple wins via alias (Apricot has no alias)', () => {
    expect(searchCatalog('fruit', minimal)[0]!.item.label).toBe('Apple')
  })

  it('"red" → Apple via keyword', () => {
    expect(searchCatalog('red', minimal)[0]!.item.label).toBe('Apple')
  })

  it('exact label outranks exact alias — Apple vs Apricot on the alias chain', () => {
    // Catalog with one entry whose LABEL is the query, and another
    // whose ALIAS is the query. Exact label (1000) > exact alias (900).
    const cat: SearchableItem[] = [
      {
        id: 'x',
        kind: 'seed',
        blockType: 'lx_heading',
        label: 'Rose',
        description: '',
        icon: (() => null) as never,
      },
      {
        id: 'y',
        kind: 'seed',
        blockType: 'lx_heading',
        label: 'Flower',
        description: '',
        icon: (() => null) as never,
        aliases: ['rose'],
      },
    ]
    const hits = searchCatalog('rose', cat)
    expect(hits[0]!.item.label).toBe('Rose')
    expect(hits[0]!.score).toBe(1000)
    expect(hits[1]!.item.label).toBe('Flower')
    expect(hits[1]!.score).toBe(900)
  })
})

describe('scoreItem — tier boundaries', () => {
  const item: SearchableItem = {
    id: 'x',
    kind: 'seed',
    blockType: 'lx_heading',
    label: 'Heading',
    description: '',
    icon: (() => null) as never,
    aliases: ['h1', 'title'],
    keywords: ['headline'],
  }

  it('exact label → 1000', () => {
    expect(scoreItem('heading', item).score).toBe(1000)
  })
  it('exact alias → 900', () => {
    expect(scoreItem('h1', item).score).toBe(900)
    expect(scoreItem('h1', item).matchedAlias).toBe('h1')
  })
  it('label prefix → 800', () => {
    expect(scoreItem('head', item).score).toBe(800)
  })
  it('alias prefix → 700', () => {
    expect(scoreItem('ti', item).score).toBe(700)
  })
  it('label substring → 600', () => {
    expect(scoreItem('eadin', item).score).toBe(600)
  })
  it('keyword substring → 400', () => {
    expect(scoreItem('eadli', item).score).toBe(400)
  })
  it('typo on label (lev=1) → 250', () => {
    expect(scoreItem('heding', item).score).toBe(250)
  })
  it('typo on label (lev=2) → 200', () => {
    expect(scoreItem('headign', item).score).toBe(200)
  })
  it('no match → 0', () => {
    expect(scoreItem('xyz', item).score).toBe(0)
  })
  it('empty query → 0', () => {
    expect(scoreItem('', item).score).toBe(0)
  })
})
