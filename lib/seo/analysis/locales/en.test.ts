import { describe, it, expect } from 'vitest'
import {
  en,
  countSyllables,
  EN_TRANSITION_WORDS,
  EN_FUNCTION_WORDS,
  EN_PASSIVE_AUXILIARIES,
} from '@/lib/seo/analysis/locales/en'

describe('en rule pack shape', () => {
  it('declares locale "en" and wires the syllable counter', () => {
    expect(en.locale).toBe('en')
    expect(en.countSyllables).toBe(countSyllables)
  })

  it('ships ≥150 transition words', () => {
    expect(EN_TRANSITION_WORDS.length).toBeGreaterThanOrEqual(150)
  })

  it('includes multi-word transition phrases', () => {
    expect(EN_TRANSITION_WORDS).toContain('as a result')
    expect(EN_TRANSITION_WORDS).toContain('in addition')
    expect(EN_TRANSITION_WORDS).toContain('for example')
  })

  it('ships ≥120 function words', () => {
    expect(EN_FUNCTION_WORDS.length).toBeGreaterThanOrEqual(120)
  })

  it('includes the be-family passive auxiliaries', () => {
    for (const aux of ['be', 'is', 'are', 'was', 'were', 'been', 'being']) {
      expect(EN_PASSIVE_AUXILIARIES).toContain(aux)
    }
  })

  it('every list entry is lowercased', () => {
    const all = [...EN_TRANSITION_WORDS, ...EN_FUNCTION_WORDS, ...EN_PASSIVE_AUXILIARIES]
    for (const w of all) {
      expect(w).toBe(w.toLowerCase())
    }
  })
})

describe('countSyllables', () => {
  it('counts simple monosyllables as 1', () => {
    expect(countSyllables('cat')).toBe(1)
    expect(countSyllables('dog')).toBe(1)
    expect(countSyllables('strength')).toBe(1)
  })

  it('handles silent trailing-e', () => {
    expect(countSyllables('make')).toBe(1)
    expect(countSyllables('code')).toBe(1)
    expect(countSyllables('home')).toBe(1)
  })

  it('counts consonant + le as a syllable', () => {
    expect(countSyllables('table')).toBe(2)
    expect(countSyllables('little')).toBe(2)
    expect(countSyllables('candle')).toBe(2)
  })

  it('counts common multi-syllable words', () => {
    expect(countSyllables('beautiful')).toBe(3) // beau-ti-ful (vowel groups: eau, i, u)
    expect(countSyllables('reading')).toBe(2) // rea-ding
    expect(countSyllables('analysis')).toBeGreaterThanOrEqual(3)
  })

  it('treats one- and two-letter words as a single syllable', () => {
    expect(countSyllables('a')).toBe(1)
    expect(countSyllables('I')).toBe(1)
    expect(countSyllables('to')).toBe(1)
  })

  it('never returns less than 1 for a real word, and 0 for empty', () => {
    expect(countSyllables('')).toBe(0)
    expect(countSyllables('rhythm')).toBeGreaterThanOrEqual(1)
  })

  it('strips non-letters before counting', () => {
    expect(countSyllables('make!')).toBe(1)
    expect(countSyllables('123')).toBe(0) // strips to empty → no syllables
  })
})
