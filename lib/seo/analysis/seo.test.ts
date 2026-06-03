import { describe, it, expect } from 'vitest'
import { analyzeSeo } from '@/lib/seo/analysis/seo'
import { DEFAULT_ANALYSIS_CONFIG } from '@/lib/seo/analysis/types'
import type {
  AnalysisInput,
  ContentNode,
  LinkNode,
  ImageNode,
  Assessment,
} from '@/lib/seo/analysis/types'

const CFG = DEFAULT_ANALYSIS_CONFIG

function byId(assessments: Assessment[], id: string): Assessment {
  const a = assessments.find((x) => x.id === id)
  if (!a) throw new Error(`assessment ${id} not found`)
  return a
}

function has(assessments: Assessment[], id: string): boolean {
  return assessments.some((x) => x.id === id)
}

// A "fully green" input we then mutate per test to drive a single check red.
function goodInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  const blocks: ContentNode[] = [
    { kind: 'heading', level: 1, text: 'Content Marketing Strategy' },
    {
      kind: 'paragraph',
      text:
        'Content marketing is the discipline of creating valuable material. ' +
        'A strong content marketing strategy helps brands grow steadily over time. ' +
        wordFiller(280),
    },
    { kind: 'heading', level: 2, text: 'Why content marketing works' },
    { kind: 'paragraph', text: 'It builds trust with your audience.' },
  ]
  const links: LinkNode[] = [
    { href: '/about', text: 'about', internal: true },
    { href: 'https://example.com', text: 'source', internal: false },
  ]
  const images: ImageNode[] = [{ src: '/a.jpg', alt: 'a content marketing chart' }]
  return {
    title: 'Content Marketing Strategy: A Practical Guide for Teams',
    metaDescription:
      'Learn how a content marketing strategy drives growth. This practical guide covers planning, creation, and measurement for busy modern teams today now.',
    slug: 'content-marketing-strategy',
    keyphrase: 'content marketing',
    blocks,
    links,
    images,
    ...overrides,
  }
}

// Filler of simple words to push the body over the 300-word minimum.
function wordFiller(n: number): string {
  return Array.from({ length: n }, () => 'word').join(' ') + '.'
}

function run(overrides: Partial<AnalysisInput> = {}) {
  return analyzeSeo(goodInput(overrides), CFG)
}

describe('no keyphrase', () => {
  it('returns a single keyphraseSet bad assessment and skips keyphrase checks', () => {
    const r = analyzeSeo(goodInput({ keyphrase: '' }), CFG)
    expect(r.assessments).toHaveLength(1)
    expect(byId(r.assessments, 'keyphraseSet').rating).toBe('bad')
    expect(r.rating).toBe('bad')
    // keyphrase-dependent checks must NOT be present.
    expect(has(r.assessments, 'keyphraseInTitle')).toBe(false)
    expect(has(r.assessments, 'keyphraseDensity')).toBe(false)
  })

  it('treats whitespace-only keyphrase as unset', () => {
    const r = analyzeSeo(goodInput({ keyphrase: '   ' }), CFG)
    expect(r.assessments).toHaveLength(1)
    expect(byId(r.assessments, 'keyphraseSet')).toBeDefined()
  })
})

describe('keyphraseInTitle', () => {
  it('good (bonus) when keyphrase is at the start of the title', () => {
    const r = run({ title: 'Content marketing changes everything' })
    expect(byId(r.assessments, 'keyphraseInTitle').rating).toBe('good')
  })
  it('ok when keyphrase is present but not at the start', () => {
    const r = run({ title: 'A guide to content marketing' })
    expect(byId(r.assessments, 'keyphraseInTitle').rating).toBe('ok')
  })
  it('bad when keyphrase is absent from the title', () => {
    const r = run({ title: 'A guide to gardening' })
    expect(byId(r.assessments, 'keyphraseInTitle').rating).toBe('bad')
  })
})

describe('keyphraseInMetaDescription', () => {
  it('good when present', () => {
    expect(byId(run().assessments, 'keyphraseInMetaDescription').rating).toBe('good')
  })
  it('bad when absent', () => {
    const r = run({ metaDescription: 'A description about something else entirely.' })
    expect(byId(r.assessments, 'keyphraseInMetaDescription').rating).toBe('bad')
  })
})

describe('keyphraseInSlug', () => {
  it('good when all content words are in the slug', () => {
    expect(byId(run().assessments, 'keyphraseInSlug').rating).toBe('good')
  })
  it('bad when a content word is missing from the slug', () => {
    const r = run({ slug: 'marketing-tips' }) // missing "content"
    expect(byId(r.assessments, 'keyphraseInSlug').rating).toBe('bad')
  })
})

describe('keyphraseInIntroduction', () => {
  it('good when keyphrase is in the first paragraph', () => {
    expect(byId(run().assessments, 'keyphraseInIntroduction').rating).toBe('good')
  })
  it('bad when the intro paragraph omits the keyphrase', () => {
    const blocks: ContentNode[] = [
      { kind: 'heading', level: 1, text: 'Content Marketing' },
      { kind: 'paragraph', text: 'An opening paragraph about nothing in particular here. ' + wordFiller(300) },
      { kind: 'paragraph', text: 'content marketing appears only later.' },
    ]
    const r = run({ blocks })
    expect(byId(r.assessments, 'keyphraseInIntroduction').rating).toBe('bad')
  })
})

describe('keyphraseInSubheadings', () => {
  it('good when an H2/H3 contains a content word', () => {
    expect(byId(run().assessments, 'keyphraseInSubheadings').rating).toBe('good')
  })
  it('bad when subheadings exist but none contain the keyphrase', () => {
    const blocks: ContentNode[] = [
      { kind: 'heading', level: 1, text: 'Content Marketing' },
      { kind: 'paragraph', text: 'content marketing intro. ' + wordFiller(300) },
      { kind: 'heading', level: 2, text: 'Unrelated section title' },
    ]
    const r = run({ blocks })
    expect(byId(r.assessments, 'keyphraseInSubheadings').rating).toBe('bad')
  })
})

describe('keyphraseDensity', () => {
  it('good within the recommended range', () => {
    // goodInput uses "content marketing" a handful of times across ~300 words.
    expect(byId(run().assessments, 'keyphraseDensity').rating).toBe('good')
  })
  it('bad (over-optimised) when density exceeds the max', () => {
    // Many repeats of the keyphrase in a short body → high density.
    const blocks: ContentNode[] = [
      { kind: 'paragraph', text: Array.from({ length: 20 }, () => 'content marketing').join(' ') + '.' },
    ]
    const r = run({ blocks })
    const a = byId(r.assessments, 'keyphraseDensity')
    expect(a.rating).toBe('bad')
    expect(a.text.toLowerCase()).toContain('over')
  })
  it('bad when the keyphrase never appears in the body', () => {
    const blocks: ContentNode[] = [{ kind: 'paragraph', text: wordFiller(300) }]
    const r = run({ blocks })
    expect(byId(r.assessments, 'keyphraseDensity').rating).toBe('bad')
  })
  it('ok when density is non-zero but below the minimum', () => {
    // One occurrence in 500 words → 0.2% < 0.5% min.
    const blocks: ContentNode[] = [
      { kind: 'paragraph', text: 'content marketing ' + wordFiller(499) },
    ]
    const r = run({ blocks })
    expect(byId(r.assessments, 'keyphraseDensity').rating).toBe('ok')
  })
})

describe('keyphraseLength', () => {
  it('good for a 2-content-word keyphrase', () => {
    expect(byId(run().assessments, 'keyphraseLength').rating).toBe('good')
  })
  it('ok (warn) when the keyphrase has more than 4 content words', () => {
    const r = run({ keyphrase: 'best content marketing strategy guide framework' })
    expect(byId(r.assessments, 'keyphraseLength').rating).toBe('ok')
  })
  it('bad when the keyphrase is only function words', () => {
    const r = run({ keyphrase: 'the of and' })
    expect(byId(r.assessments, 'keyphraseLength').rating).toBe('bad')
  })
})

describe('functionWordsInKeyphrase', () => {
  it('good when the keyphrase has meaningful words', () => {
    expect(byId(run().assessments, 'functionWordsInKeyphrase').rating).toBe('good')
  })
  it('bad when the keyphrase is ONLY function words', () => {
    const r = run({ keyphrase: 'the and of' })
    expect(byId(r.assessments, 'functionWordsInKeyphrase').rating).toBe('bad')
  })
})

describe('textLength', () => {
  it('good at or above the minWords target', () => {
    expect(byId(run().assessments, 'textLength').rating).toBe('good')
  })
  it('bad well below the minimum', () => {
    const blocks: ContentNode[] = [{ kind: 'paragraph', text: 'content marketing only.' }]
    const r = run({ blocks })
    expect(byId(r.assessments, 'textLength').rating).toBe('bad')
  })
  it('uses the higher cornerstone target', () => {
    // ~300 words clears minWords (300) but NOT cornerstoneMinWords (900).
    const blocks: ContentNode[] = [
      { kind: 'paragraph', text: 'content marketing ' + wordFiller(310) },
    ]
    const normal = analyzeSeo(goodInput({ blocks, cornerstone: false }), CFG)
    const corner = analyzeSeo(goodInput({ blocks, cornerstone: true }), CFG)
    expect(byId(normal.assessments, 'textLength').rating).toBe('good')
    expect(byId(corner.assessments, 'textLength').rating).not.toBe('good')
    expect(byId(corner.assessments, 'textLength').text).toContain('900')
  })
})

describe('keyphraseInImageAlt', () => {
  it('good when an image alt contains a content word', () => {
    expect(byId(run().assessments, 'keyphraseInImageAlt').rating).toBe('good')
  })
  it('bad when images exist but none use the keyphrase', () => {
    const r = run({ images: [{ src: '/x.jpg', alt: 'a sunset over the hills' }] })
    expect(byId(r.assessments, 'keyphraseInImageAlt').rating).toBe('bad')
  })
  it('good when there are no images at all', () => {
    const r = run({ images: [] })
    expect(byId(r.assessments, 'keyphraseInImageAlt').rating).toBe('good')
  })
})

describe('internalLinks / outboundLinks', () => {
  it('good when at least one internal and one outbound link exist', () => {
    expect(byId(run().assessments, 'internalLinks').rating).toBe('good')
    expect(byId(run().assessments, 'outboundLinks').rating).toBe('good')
  })
  it('bad when there are no internal links', () => {
    const r = run({ links: [{ href: 'https://x.com', text: 'x', internal: false }] })
    expect(byId(r.assessments, 'internalLinks').rating).toBe('bad')
    expect(byId(r.assessments, 'outboundLinks').rating).toBe('good')
  })
  it('bad when there are no outbound links', () => {
    const r = run({ links: [{ href: '/x', text: 'x', internal: true }] })
    expect(byId(r.assessments, 'outboundLinks').rating).toBe('bad')
    expect(byId(r.assessments, 'internalLinks').rating).toBe('good')
  })
  it('both bad when there are no links', () => {
    const r = run({ links: [] })
    expect(byId(r.assessments, 'internalLinks').rating).toBe('bad')
    expect(byId(r.assessments, 'outboundLinks').rating).toBe('bad')
  })
})

describe('singleH1', () => {
  it('good with exactly one H1', () => {
    expect(byId(run().assessments, 'singleH1').rating).toBe('good')
  })
  it('ok with zero H1s', () => {
    const blocks: ContentNode[] = [
      { kind: 'heading', level: 2, text: 'content marketing' },
      { kind: 'paragraph', text: 'content marketing body ' + wordFiller(300) },
    ]
    expect(byId(run({ blocks }).assessments, 'singleH1').rating).toBe('ok')
  })
  it('bad with two H1s', () => {
    const blocks: ContentNode[] = [
      { kind: 'heading', level: 1, text: 'content marketing one' },
      { kind: 'heading', level: 1, text: 'content marketing two' },
      { kind: 'paragraph', text: 'content marketing body ' + wordFiller(300) },
    ]
    expect(byId(run({ blocks }).assessments, 'singleH1').rating).toBe('bad')
  })
})

describe('titleWidth', () => {
  it('good in the ~40-60 char range', () => {
    expect(byId(run().assessments, 'titleWidth').rating).toBe('good')
  })
  it('bad when too long (>60 chars)', () => {
    const r = run({ title: 'Content marketing ' + 'x'.repeat(60) })
    expect(byId(r.assessments, 'titleWidth').rating).toBe('bad')
  })
  it('ok when too short (<30 chars)', () => {
    const r = run({ title: 'Content marketing' }) // 17 chars
    expect(byId(r.assessments, 'titleWidth').rating).toBe('ok')
  })
})

describe('metaDescriptionLength', () => {
  it('good in the 120-156 char range', () => {
    expect(byId(run().assessments, 'metaDescriptionLength').rating).toBe('good')
  })
  it('bad when empty', () => {
    const r = run({ metaDescription: '' })
    expect(byId(r.assessments, 'metaDescriptionLength').rating).toBe('bad')
  })
  it('bad when over 160 chars', () => {
    const r = run({ metaDescription: 'content marketing ' + 'y'.repeat(160) })
    expect(byId(r.assessments, 'metaDescriptionLength').rating).toBe('bad')
  })
  it('ok when present but short (1-119 chars)', () => {
    const r = run({ metaDescription: 'content marketing is great' })
    expect(byId(r.assessments, 'metaDescriptionLength').rating).toBe('ok')
  })
})

describe('aggregate seo score', () => {
  it('a fully-optimised page scores high + good', () => {
    const r = run()
    expect(r.score).toBeGreaterThanOrEqual(70)
    expect(r.rating).toBe('good')
  })
  it('a poorly-optimised page scores low (floors in the ok band)', () => {
    // THRESHOLD NOTE: every check bottoms out at 3/9 (never 0), and two checks
    // measure the KEYPHRASE ITSELF (keyphraseLength, functionWordsInKeyphrase) —
    // a well-formed keyphrase keeps those green even on an otherwise terrible
    // page. So with a valid keyphrase the SEO aggregate floors around ~44 and
    // lands in the 'ok' band, NOT 'bad'. We assert the score bottoms out (<50)
    // here; the unambiguously-'bad' overall rating is reachable via the
    // no-keyphrase path (asserted in the 'no keyphrase' suite).
    const r = analyzeSeo(
      {
        title: 'A gardening title that is deliberately far too long to fit nicely here',
        metaDescription: '',
        slug: 'gardening',
        keyphrase: 'content marketing',
        blocks: [
          { kind: 'heading', level: 1, text: 'one' },
          { kind: 'heading', level: 1, text: 'two' }, // two H1s → singleH1 bad
          { kind: 'paragraph', text: 'A tiny bit of unrelated text.' },
        ],
        links: [],
        images: [{ src: '/x.jpg', alt: 'a flower' }],
      },
      CFG,
    )
    expect(r.score).toBeLessThan(50)
    expect(r.rating).toBe('ok')
    // Spot-check that the page-level failures DID register as bad:
    expect(byId(r.assessments, 'keyphraseInTitle').rating).toBe('bad')
    expect(byId(r.assessments, 'metaDescriptionLength').rating).toBe('bad')
    expect(byId(r.assessments, 'singleH1').rating).toBe('bad')
    expect(byId(r.assessments, 'titleWidth').rating).toBe('bad')
  })

  it('multi-word keyphrase occurrence counting feeds density correctly', () => {
    // "content marketing" must be counted as a consecutive 2-gram, not as two
    // separate single-word hits. 5 occurrences in 100 words → 5% > 3% max → bad.
    const body = Array.from({ length: 5 }, () => 'content marketing').join(' ') + ' ' + wordFiller(90)
    const r = run({ blocks: [{ kind: 'paragraph', text: body }] })
    const a = byId(r.assessments, 'keyphraseDensity')
    expect(a.rating).toBe('bad') // over-optimised, not "absent"
    expect(a.text.toLowerCase()).toContain('over')
  })
})
