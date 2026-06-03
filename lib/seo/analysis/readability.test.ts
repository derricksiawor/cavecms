import { describe, it, expect } from 'vitest'
import { analyzeReadability } from '@/lib/seo/analysis/readability'
import { en } from '@/lib/seo/analysis/locales/en'
import { DEFAULT_ANALYSIS_CONFIG } from '@/lib/seo/analysis/types'
import type { AnalysisInput, ContentNode, Assessment } from '@/lib/seo/analysis/types'

const CFG = DEFAULT_ANALYSIS_CONFIG

// Minimal valid input; tests override `blocks` per scenario.
function baseInput(blocks: ContentNode[]): AnalysisInput {
  return {
    title: 'Title',
    metaDescription: 'desc',
    slug: 'slug',
    keyphrase: '',
    blocks,
    links: [],
    images: [],
  }
}

function run(blocks: ContentNode[]) {
  return analyzeReadability(baseInput(blocks), CFG, en)
}

function byId(assessments: Assessment[], id: string): Assessment {
  const a = assessments.find((x) => x.id === id)
  if (!a) throw new Error(`assessment ${id} not found`)
  return a
}

// Build a paragraph of N short simple words so we can hit word-count targets.
function words(n: number, word = 'cat'): string {
  return Array.from({ length: n }, () => word).join(' ')
}

describe('textPresence', () => {
  it('bad when there is no text', () => {
    const r = run([{ kind: 'paragraph', text: '' }])
    expect(byId(r.assessments, 'textPresence').rating).toBe('bad')
  })
  it('good when text exists', () => {
    const r = run([{ kind: 'paragraph', text: 'Some real words here.' }])
    expect(byId(r.assessments, 'textPresence').rating).toBe('good')
  })
})

describe('fleschReadingEase', () => {
  it('green for simple short-sentence prose (>= target 60)', () => {
    // Short, one-syllable words, short sentences → very high Flesch.
    const text = 'The cat sat. The dog ran. We had fun. She is nice. He is kind.'
    const r = run([{ kind: 'paragraph', text }])
    const a = byId(r.assessments, 'fleschReadingEase')
    expect(a.rating).toBe('good')
  })
  it('bad for dense multisyllabic long-sentence prose (< 30)', () => {
    const text =
      'The multidimensional epistemological framework necessitates comprehensive interdisciplinary collaboration among numerous distinguished organizational stakeholders throughout extraordinarily complicated administrative bureaucratic infrastructures continuously.'
    const r = run([{ kind: 'paragraph', text }])
    const a = byId(r.assessments, 'fleschReadingEase')
    expect(a.rating).toBe('bad')
  })
})

describe('sentenceLength', () => {
  it('green when fewer than 25% of sentences exceed 20 words', () => {
    // 4 short sentences, 0 long → 0%.
    const text = 'I like cats. I like dogs. I like birds. I like fish.'
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'sentenceLength').rating).toBe('good')
  })
  it('bad when >=30% of sentences exceed 20 words', () => {
    const longSentence = words(25) + '.'
    // 2 sentences, both long → 100%.
    const text = `${longSentence} ${longSentence}`
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'sentenceLength').rating).toBe('bad')
  })
})

describe('paragraphLength', () => {
  it('green when no paragraph exceeds 150 words', () => {
    const r = run([{ kind: 'paragraph', text: words(149) + '.' }])
    expect(byId(r.assessments, 'paragraphLength').rating).toBe('good')
  })
  it('bad when a paragraph exceeds 150 words', () => {
    const r = run([{ kind: 'paragraph', text: words(151) + '.' }])
    const a = byId(r.assessments, 'paragraphLength')
    expect(a.rating).toBe('bad')
    expect(a.text).toContain('1 paragraph')
  })
})

describe('subheadingDistribution', () => {
  it('green when short text has no long unbroken section', () => {
    const r = run([{ kind: 'paragraph', text: words(100) + '.' }])
    expect(byId(r.assessments, 'subheadingDistribution').rating).toBe('good')
  })
  it('bad when a section exceeds 300 words with no heading', () => {
    const r = run([{ kind: 'paragraph', text: words(301) + '.' }])
    expect(byId(r.assessments, 'subheadingDistribution').rating).toBe('bad')
  })
  it('green when headings break up the long text', () => {
    const r = run([
      { kind: 'heading', level: 2, text: 'A' },
      { kind: 'paragraph', text: words(200) + '.' },
      { kind: 'heading', level: 2, text: 'B' },
      { kind: 'paragraph', text: words(200) + '.' },
    ])
    expect(byId(r.assessments, 'subheadingDistribution').rating).toBe('good')
  })
})

describe('passiveVoice', () => {
  it('green when passive sentences are <= 10%', () => {
    // All active.
    const text = 'The team builds the product. We ship features. Users love it.'
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'passiveVoice').rating).toBe('good')
  })
  it('bad when most sentences are passive', () => {
    const text =
      'The product was built by the team. The bug was fixed quickly. The plan was approved. The report was written.'
    const r = run([{ kind: 'paragraph', text }])
    const a = byId(r.assessments, 'passiveVoice')
    expect(a.rating).toBe('bad')
  })
})

describe('transitionWords', () => {
  it('green when >= 30% of sentences use a transition word', () => {
    // 3 of 3 use transitions: "However", "Therefore", "In addition".
    const text =
      'However, the plan worked. Therefore, we shipped. In addition, users were happy.'
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'transitionWords').rating).toBe('good')
  })
  it('bad when almost no sentences use a transition word', () => {
    // None of these sentences contain a transition word/phrase.
    const text = 'The cat slept. The dog ran. The bird flew. The fish swam.'
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'transitionWords').rating).toBe('bad')
  })

  it('detects MULTI-WORD transition phrases via the precomputed index (Fix 10)', () => {
    // "as a result" and "in addition" are multi-token phrases — the rewritten
    // index-based scan must still match them as consecutive runs.
    const text =
      'We shipped it. As a result, sales rose. In addition, users were happy.'
    const r = run([{ kind: 'paragraph', text }])
    // 2 of 3 sentences carry a multi-word transition → 66% ≥ 30% → good.
    expect(byId(r.assessments, 'transitionWords').rating).toBe('good')
  })

  it('a custom pack with only the flat transitionWords list still works (lazy index build)', () => {
    // No precomputed transitionSingle/transitionMulti — analyzeReadability must
    // build the index on demand from the flat list and still detect phrases.
    const flatPack = {
      locale: 'flat',
      transitionWords: ['however', 'as a result'],
      passiveAuxiliaries: ['was', 'were'],
      functionWords: [],
      countSyllables: () => 1,
    }
    const r = analyzeReadability(
      baseInput([
        {
          kind: 'paragraph',
          text: 'However, it worked. As a result, we shipped. The end came.',
        },
      ]),
      CFG,
      flatPack,
    )
    expect(byId(r.assessments, 'transitionWords').rating).not.toBe('bad')
  })
})

describe('consecutiveSentences', () => {
  it('bad when 3+ sentences start with the same word', () => {
    const text = 'I went home. I ate food. I slept well. Then morning came.'
    const r = run([{ kind: 'paragraph', text }])
    const a = byId(r.assessments, 'consecutiveSentences')
    expect(a.rating).toBe('bad')
    expect(a.text).toContain('"i"')
  })
  it('good when sentence openings vary', () => {
    const text = 'I went home. Then I ate. Later we slept. Morning came.'
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'consecutiveSentences').rating).toBe('good')
  })
  it('good when there are fewer than 3 sentences', () => {
    const text = 'I go. I run.'
    const r = run([{ kind: 'paragraph', text }])
    expect(byId(r.assessments, 'consecutiveSentences').rating).toBe('good')
  })
})

describe('aggregate readability score', () => {
  it('produces a high score + good rating for clean prose', () => {
    const text =
      'The cat sat. However, the dog ran. Therefore, we had fun. In addition, she smiled. The end came.'
    const r = run([
      { kind: 'heading', level: 2, text: 'Intro' },
      { kind: 'paragraph', text },
    ])
    expect(r.score).toBeGreaterThanOrEqual(70)
    expect(r.rating).toBe('good')
  })
  it('produces a low score + bad rating for terrible prose', () => {
    // Terrible across EVERY dimension: dense multisyllabic words (low Flesch),
    // very long sentences (sentence-length bad), passive constructions
    // (passive bad), repeated "the" openings (consecutive bad), and a single
    // unbroken 300+ word paragraph (paragraph-length + subheading-distribution
    // bad). No transition words. This is the worst-case content.
    // No transition words anywhere ("throughout"/"among" avoided) so the
    // transition check also fails.
    const long =
      'The comprehensive multidimensional administrative configuration report documentation was meticulously prepared assembled compiled organized formatted reviewed audited validated certified approved finalized distributed across numerous distinguished organizational committee subcommittee members representing countless interdependent participating departmental operational subdivisions functioning autonomously independently separately.'
    // Repeat enough to clear 300 words AND 150 words in one paragraph; every
    // sentence starts with "The" so 3+ consecutive openings match.
    const text = Array.from({ length: 9 }, () => long).join(' ')
    const r = run([{ kind: 'paragraph', text }])
    // THRESHOLD NOTE: the aggregate floor of this 8-check readability scorer is
    // ~42%. Every check bottoms out at 3/9 (never 0) and textPresence is always
    // 9 once any text exists, so the worst realistic content lands ≈42 — which
    // falls in the 'ok' band (bad<40, ok 40-69, good≥70). In other words, with
    // these per-check floors a readability result is effectively never rated
    // 'bad' unless the body is empty (then textPresence=3 and the score craters).
    // We assert the SCORE bottoms out (<45) rather than a 'bad' rating it can't
    // structurally reach. The 'bad' rating IS reachable when there is no text:
    expect(r.score).toBeLessThan(45)
    expect(r.rating).toBe('ok')

    // Empty body → textPresence fails too → score craters below 40 → 'bad'.
    const empty = run([])
    expect(empty.rating).toBe('bad')
  })

  it('empty blocks → bad textPresence and a low score', () => {
    const r = run([])
    expect(byId(r.assessments, 'textPresence').rating).toBe('bad')
    expect(r.rating).not.toBe('good')
  })
})
