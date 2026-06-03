import { describe, it, expect } from 'vitest'
import {
  flattenText,
  tokenizeWords,
  splitSentences,
  firstParagraph,
  countOccurrences,
  countOccurrencesOfTokens,
  contentWords,
  computeDerivedText,
  buildTransitionIndex,
} from '@/lib/seo/analysis/text'
import type { ContentNode } from '@/lib/seo/analysis/types'

describe('flattenText', () => {
  it('joins paragraph, heading and list-item text in order with single spaces', () => {
    const blocks: ContentNode[] = [
      { kind: 'heading', level: 2, text: 'Hello World' },
      { kind: 'paragraph', text: 'First para.' },
      { kind: 'listitem', text: 'one' },
      { kind: 'listitem', text: 'two' },
    ]
    expect(flattenText(blocks)).toBe('Hello World First para. one two')
  })

  it('drops empty / whitespace-only nodes (no double spaces)', () => {
    const blocks: ContentNode[] = [
      { kind: 'paragraph', text: '  ' },
      { kind: 'paragraph', text: 'real' },
      { kind: 'paragraph', text: '' },
    ]
    expect(flattenText(blocks)).toBe('real')
  })

  it('returns empty string for empty block list', () => {
    expect(flattenText([])).toBe('')
  })
})

describe('tokenizeWords', () => {
  it('lowercases and strips surrounding punctuation', () => {
    expect(tokenizeWords('Hello, World!')).toEqual(['hello', 'world'])
  })

  it('keeps internal apostrophes and hyphens as one token', () => {
    expect(tokenizeWords("don't well-known")).toEqual(["don't", 'well-known'])
  })

  it('is Unicode-aware (keeps accented letters)', () => {
    expect(tokenizeWords('Café Über')).toEqual(['café', 'über'])
  })

  it('returns [] for empty / punctuation-only input', () => {
    expect(tokenizeWords('')).toEqual([])
    expect(tokenizeWords('--- !!!')).toEqual([])
  })

  it('keeps numbers as tokens', () => {
    expect(tokenizeWords('top 10 tips')).toEqual(['top', '10', 'tips'])
  })
})

describe('splitSentences', () => {
  it('splits on . ! and ?', () => {
    const s = splitSentences('First. Second! Third?')
    expect(s).toEqual(['First.', 'Second!', 'Third?'])
  })

  it('does not break on common abbreviations', () => {
    // "Dr. Smith" should NOT split after "Dr."
    const s = splitSentences('Dr. Smith arrived. He waved.')
    expect(s).toEqual(['Dr. Smith arrived.', 'He waved.'])
  })

  it('does not break on e.g. / i.e.', () => {
    const s = splitSentences('Use a tool, e.g. a hammer. Then build.')
    expect(s).toEqual(['Use a tool, e.g. a hammer.', 'Then build.'])
  })

  it('does not break on decimals', () => {
    const s = splitSentences('Pi is 3.14 roughly. Done.')
    expect(s).toEqual(['Pi is 3.14 roughly.', 'Done.'])
  })

  it('does NOT treat "no" as an abbreviation (real sentence boundary)', () => {
    // Regression for the false-merge bug: "no." ends a real sentence here.
    const s = splitSentences('I said no. Then I left.')
    expect(s).toEqual(['I said no.', 'Then I left.'])
  })

  it('does NOT treat "st"/"co"/"al" as abbreviations either', () => {
    expect(splitSentences('We met at the st. Then we walked.')).toEqual([
      'We met at the st.',
      'Then we walked.',
    ])
    expect(splitSentences('It was the co. Then it closed.')).toEqual([
      'It was the co.',
      'Then it closed.',
    ])
    expect(splitSentences('Read it al. Then stop.')).toEqual([
      'Read it al.',
      'Then stop.',
    ])
  })

  it('still protects "Mr." and "e.g." (kept abbreviations intact)', () => {
    expect(splitSentences('Mr. Smith waved. He left.')).toEqual([
      'Mr. Smith waved.',
      'He left.',
    ])
    expect(splitSentences('Bring a tool, e.g. a hammer. Build it.')).toEqual([
      'Bring a tool, e.g. a hammer.',
      'Build it.',
    ])
  })

  it('returns a single sentence when there is no terminator', () => {
    expect(splitSentences('No terminator here')).toEqual(['No terminator here'])
  })

  it('returns [] for empty input', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('   ')).toEqual([])
  })
})

describe('firstParagraph', () => {
  it('returns the first paragraph text, skipping leading headings/list items', () => {
    const blocks: ContentNode[] = [
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'listitem', text: 'a bullet' },
      { kind: 'paragraph', text: 'The intro.' },
      { kind: 'paragraph', text: 'Second.' },
    ]
    expect(firstParagraph(blocks)).toBe('The intro.')
  })

  it('returns empty string when there is no paragraph', () => {
    const blocks: ContentNode[] = [{ kind: 'heading', level: 2, text: 'h' }]
    expect(firstParagraph(blocks)).toBe('')
  })
})

describe('countOccurrences', () => {
  it('counts single-word phrase occurrences case-insensitively', () => {
    const words = tokenizeWords('SEO is great. SEO wins. Long live seo.')
    expect(countOccurrences(words, 'seo')).toBe(3)
  })

  it('counts a multi-word phrase only on consecutive matches', () => {
    const words = tokenizeWords(
      'Content marketing matters. We love content and marketing separately. Content marketing again.',
    )
    // "content marketing" appears consecutively twice; the middle "content ... marketing"
    // is separated by "and" so it does NOT count.
    expect(countOccurrences(words, 'content marketing')).toBe(2)
  })

  it('does not double-count overlapping runs', () => {
    const words = tokenizeWords('na na na')
    // phrase "na na" — non-overlapping: positions [0,1] then index jumps to 2,
    // leaving a single "na" → exactly one match.
    expect(countOccurrences(words, 'na na')).toBe(1)
  })

  it('returns 0 when the phrase is longer than the text', () => {
    const words = tokenizeWords('short')
    expect(countOccurrences(words, 'much longer phrase here')).toBe(0)
  })

  it('returns 0 for an empty phrase', () => {
    expect(countOccurrences(tokenizeWords('anything'), '')).toBe(0)
  })
})

describe('contentWords', () => {
  const fn = ['the', 'of', 'a', 'in', 'best']
  it('removes function words, keeps content words', () => {
    expect(contentWords('the best of marketing', fn)).toEqual(['marketing'])
  })

  it('returns [] when every word is a function word', () => {
    expect(contentWords('the of a', fn)).toEqual([])
  })
})

describe('countOccurrencesOfTokens', () => {
  it('matches countOccurrences for a pre-tokenized needle', () => {
    const hay = tokenizeWords('content marketing wins. content marketing rocks.')
    const needle = tokenizeWords('content marketing')
    expect(countOccurrencesOfTokens(hay, needle)).toBe(2)
    expect(countOccurrencesOfTokens(hay, needle)).toBe(
      countOccurrences(hay, 'content marketing'),
    )
  })

  it('returns 0 for an empty needle', () => {
    expect(countOccurrencesOfTokens(tokenizeWords('anything'), [])).toBe(0)
  })
})

describe('computeDerivedText (once-per-document bundle)', () => {
  const blocks: ContentNode[] = [
    { kind: 'heading', level: 1, text: 'Content Marketing 101' },
    {
      kind: 'paragraph',
      text:
        "Content marketing isn't easy. Dr. Smith said so, e.g. in 2024. " +
        'It costs 3.14 dollars. We won! Did we? Yes — well-known fact.',
    },
    { kind: 'listitem', text: 'one two three' },
  ]

  it('exposes plain / words / sentences / sentenceTokens / counts', () => {
    const d = computeDerivedText(blocks)
    expect(d.plain).toBe(flattenText(blocks))
    expect(d.words).toEqual(tokenizeWords(d.plain))
    expect(d.sentences).toEqual(splitSentences(d.plain))
    expect(d.wordCount).toBe(d.words.length)
    expect(d.blockWordCounts.length).toBe(blocks.length)
  })

  it('per-block word counts align with each block index', () => {
    const d = computeDerivedText(blocks)
    expect(d.blockWordCounts.length).toBe(blocks.length)
    expect(d.blockWordCounts[0]).toBe(tokenizeWords(blocks[0]!.text).length)
    expect(d.blockWordCounts[2]).toBe(3) // "one two three"
  })

  it('INVARIANT: flattened sentenceTokens equal words, in order (Fix 9)', () => {
    // Sentence boundaries fall on whitespace/punctuation, never inside a token,
    // so concatenating every sentence's tokens reproduces `words` exactly. This
    // is what makes it safe for one check to read derived.words and another to
    // read derived.sentenceTokens and still agree on counts.
    const d = computeDerivedText(blocks)
    const flat = d.sentenceTokens.flat()
    expect(flat).toEqual(d.words)
  })

  it('INVARIANT holds for tricky punctuation (abbreviations, decimals, hyphens, apostrophes)', () => {
    const tricky: ContentNode[] = [
      {
        kind: 'paragraph',
        text:
          "Mr. O'Brien paid 3.14 e.g. today. The well-known co-op didn't fail! Right?",
      },
    ]
    const d = computeDerivedText(tricky)
    expect(d.sentenceTokens.flat()).toEqual(d.words)
  })
})

describe('buildTransitionIndex (Fix 10 precompute)', () => {
  it('buckets single vs multi-word transitions by first token', () => {
    const idx = buildTransitionIndex([
      'however',
      'therefore',
      'as a result',
      'as well as',
      'in addition',
      '   ', // dropped (punctuation/whitespace only)
    ])
    expect(idx.single.has('however')).toBe(true)
    expect(idx.single.has('therefore')).toBe(true)
    // multi-word phrases starting with "as" both bucket under "as"
    const asBucket = idx.multi.get('as')
    expect(asBucket).toBeDefined()
    expect(asBucket).toContainEqual(['as', 'a', 'result'])
    expect(asBucket).toContainEqual(['as', 'well', 'as'])
    // "in addition" buckets under "in"
    expect(idx.multi.get('in')).toContainEqual(['in', 'addition'])
    // empty/whitespace entry contributed nothing
    expect(idx.single.has('')).toBe(false)
  })
})
