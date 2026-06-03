import { describe, it, expect } from 'vitest'
import { runAnalysis, localeRegistry } from '@/lib/seo/analysis/index'
import { en } from '@/lib/seo/analysis/locales/en'
import { DEFAULT_ANALYSIS_CONFIG } from '@/lib/seo/analysis/types'
import type { AnalysisInput, LocaleRulePack, ContentNode } from '@/lib/seo/analysis/types'

function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  const blocks: ContentNode[] = [
    { kind: 'heading', level: 1, text: 'Hello' },
    { kind: 'paragraph', text: 'The cat sat. However, the dog ran. Therefore, we had fun.' },
  ]
  return {
    title: 'Hello',
    metaDescription: 'desc',
    slug: 'hello',
    keyphrase: '',
    blocks,
    links: [],
    images: [],
    ...overrides,
  }
}

describe('runAnalysis', () => {
  it('returns both seo and readability results', () => {
    const r = runAnalysis(input())
    expect(r.seo).toBeDefined()
    expect(r.readability).toBeDefined()
    expect(typeof r.seo.score).toBe('number')
    expect(typeof r.readability.score).toBe('number')
    expect(Array.isArray(r.seo.assessments)).toBe(true)
    expect(Array.isArray(r.readability.assessments)).toBe(true)
  })

  it('defaults to DEFAULT_ANALYSIS_CONFIG when no config is passed', () => {
    // With the default config + no keyphrase, seo collapses to keyphraseSet.
    const r = runAnalysis(input({ keyphrase: '' }))
    expect(r.seo.assessments).toHaveLength(1)
    expect(r.seo.assessments.map((a) => a.id)).toContain('keyphraseSet')
  })

  it('honours an explicit config override', () => {
    // Raise the minWords bar absurdly high so the short body fails textLength.
    const withKeyphrase = input({ keyphrase: 'hello' })
    const tight = { ...DEFAULT_ANALYSIS_CONFIG, minWords: 100000 }
    const r = runAnalysis(withKeyphrase, tight)
    const textLength = r.seo.assessments.find((a) => a.id === 'textLength')
    expect(textLength?.rating).toBe('bad')
  })
})

describe('locale resolution', () => {
  it('registers the English pack', () => {
    expect(localeRegistry.en).toBe(en)
  })

  it('falls back to English for an unknown locale', () => {
    // 'xx' is not registered; runAnalysis must not throw and should still score.
    const r = runAnalysis(input({ locale: 'xx' }))
    expect(r.readability.assessments.length).toBeGreaterThan(0)
  })

  it('matches a regional variant on its primary subtag (en-US → en)', () => {
    const r = runAnalysis(input({ locale: 'en-US' }))
    // English transition words ("However"/"Therefore") should be detected, so
    // the transition check is not bad on this transition-rich body.
    const transition = r.readability.assessments.find((a) => a.id === 'transitionWords')
    expect(transition?.rating).not.toBe('bad')
  })

  it('uses an explicit pack override over the input locale', () => {
    // A custom pack with NO transition words → transition check should drop.
    const emptyPack: LocaleRulePack = {
      locale: 'custom',
      transitionWords: [],
      passiveAuxiliaries: [],
      functionWords: [],
      countSyllables: () => 1,
    }
    const r = runAnalysis(input({ locale: 'en' }), DEFAULT_ANALYSIS_CONFIG, emptyPack)
    const transition = r.readability.assessments.find((a) => a.id === 'transitionWords')
    // With no transition words known, the transition-rich body now scores 0% → bad.
    expect(transition?.rating).toBe('bad')
  })

  it('threads the resolved pack into the SEO scorer (functionWords are locale-aware) — Fix 3', () => {
    // Custom pack that classifies the keyphrase's only meaningful words
    // ("widget"/"shop") as FUNCTION words. With the pack threaded into the SEO
    // scorer, the keyphrase now has zero content words → functionWordsInKeyphrase
    // flips to 'bad'. Under the old hard-wired-English behaviour it would stay
    // 'good' regardless of the pack.
    const pack: LocaleRulePack = {
      locale: 'custom',
      transitionWords: [],
      passiveAuxiliaries: [],
      functionWords: ['widget', 'shop'],
      countSyllables: () => 1,
    }
    const withKp = input({ keyphrase: 'widget shop' })

    const custom = runAnalysis(withKp, DEFAULT_ANALYSIS_CONFIG, pack)
    const def = runAnalysis(withKp, DEFAULT_ANALYSIS_CONFIG) // English pack

    const customFw = custom.seo.assessments.find(
      (a) => a.id === 'functionWordsInKeyphrase',
    )
    const defaultFw = def.seo.assessments.find(
      (a) => a.id === 'functionWordsInKeyphrase',
    )
    expect(customFw?.rating).toBe('bad') // pack's functionWords took effect
    expect(defaultFw?.rating).toBe('good') // English pack: real content words
  })
})
