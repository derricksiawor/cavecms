// Shared text utilities for the SEO + readability scorers. EVERYTHING here is
// a pure function: same input → same output, no I/O, no globals, no DOM, no
// node built-ins. This module runs identically in the browser (live editor
// scoring) and on the server (bulk scoring), so it may not reach for anything
// platform-specific.
//
// The analysis layer is fed STRUCTURED content (a `ContentNode[]` tree of
// paragraphs / headings / list items) rather than raw HTML — the DOM/markdown
// extraction is a separate concern. These helpers turn that structure into the
// primitives the scorers need: a flat plain-text string, a word list, a
// sentence list, keyphrase-occurrence counts, etc.

import type { ContentNode } from './types'

/**
 * Join the visible text of every paragraph / list item / heading node into a
 * single space-separated string, in document order.
 *
 * We deliberately include headings: word-count, keyphrase density and the
 * keyphrase-in-subheadings check all care about heading text too. Empty /
 * whitespace-only node texts are dropped so we never emit double spaces that
 * would skew tokenization.
 */
export function flattenText(blocks: ContentNode[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    // Every ContentNode variant carries a `text` field; trim it and skip
    // empties so the joined string has exactly one space between segments.
    const t = block.text.trim()
    if (t) parts.push(t)
  }
  return parts.join(' ')
}

/**
 * Split a string into lowercased word tokens, Unicode-aware.
 *
 * We match runs of letters/numbers/marks using the Unicode property escapes
 * `\p{L}` (letters), `\p{N}` (numbers) and `\p{M}` (combining marks) so accented
 * and non-Latin scripts survive. Apostrophes and hyphens that sit BETWEEN word
 * characters are kept (so "don't" and "well-known" stay single tokens), but
 * leading/trailing punctuation is stripped. Everything is lowercased so callers
 * can compare case-insensitively.
 */
export function tokenizeWords(s: string): string[] {
  if (!s) return []
  // Word = one-or-more word-chars, optionally with internal apostrophe/hyphen
  // joiners. The inner alternation `(?:['’\-][\p{L}\p{N}\p{M}]+)*` lets a single
  // token absorb "well-known" / "don't" / "mother-in-law" while still breaking
  // on a trailing hyphen ("end-" → "end").
  const re = /[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*/gu
  const out: string[] = []
  for (const m of s.matchAll(re)) {
    out.push(m[0].toLowerCase())
  }
  return out
}

/**
 * Split a paragraph of prose into sentences on terminal punctuation (. ! ?),
 * with a MINIMAL abbreviation guard so common abbreviations don't create false
 * sentence breaks.
 *
 * This is intentionally heuristic — perfect sentence segmentation is an NLP
 * problem, but readability checks only need a good-enough split. The approach:
 *   1. Protect a small set of common abbreviations ("mr.", "e.g.", "etc.") by
 *      temporarily replacing their period with a sentinel.
 *   2. Split on a terminator (one or more of . ! ?) followed by whitespace, or
 *      at end-of-string.
 *   3. Restore the sentinels.
 *
 * A decimal number like "3.14" is protected too: a period flanked by digits is
 * not a sentence boundary.
 */
// NOTE ON OMISSIONS: `no`, `st`, `co`, `al` are deliberately NOT here. They
// caused false sentence merges in ordinary prose — "I said no. Then I left."
// would treat "no." as an abbreviation and merge the two sentences into one;
// likewise "the deal closed. co"-style copy. Their abbreviation value
// ("No. 5", "St. Louis", "Acme Co.", "et al.") is outweighed by how often the
// same letters end a real sentence. Keeping them out is the correct trade-off
// for a readability heuristic.
const ABBREVIATIONS = [
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'inc',
  'ltd',
  'fig',
]

const PERIOD_SENTINEL = '' // a control char that never appears in prose

// --- PRECOMPILED at module scope (was rebuilt inside splitSentences on every
// call — and splitSentences runs on every keystroke over the whole document).
// We escape each abbreviation, join them into ONE alternation, and compile a
// single regex `\b(mr|mrs|…)\.` that protects every abbreviation in one pass.
// The capture group preserves the writer's original casing; the replace
// callback neutralises the abbreviation's internal dots (e.g. "e.g") plus its
// trailing period. Compiling once turns ~20 `new RegExp` + a replace loop per
// call into a single precompiled scan.
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ABBREVIATION_RE = new RegExp(
  `\\b(${ABBREVIATIONS.map(escapeForRegExp).join('|')})\\.`,
  'gi',
)

// The sentinel→period restore regex, compiled once.
const SENTINEL_RE = new RegExp(PERIOD_SENTINEL, 'g')

// Decimal-dot protection, compiled once.
const DECIMAL_RE = /(\d)\.(\d)/g

// Sentence-boundary split: a terminator (. ! ? possibly repeated) optionally
// followed by a closing quote/bracket, then whitespace. Compiled once.
const SENTENCE_SPLIT_RE = /(?<=[.!?]["'”’)\]]?)\s+/

export function splitSentences(s: string): string[] {
  if (!s || !s.trim()) return []

  let work = s

  // Protect decimals: a dot directly between two digits is never a sentence end.
  work = work.replace(DECIMAL_RE, `$1${PERIOD_SENTINEL}$2`)

  // Protect known abbreviations in ONE precompiled pass. The capture preserves
  // original casing ("Dr", "Mr", "E.G"); we only swap the period(s) for the
  // sentinel, neutralising any internal dot first (e.g. "E.G") then the
  // trailing period.
  work = work.replace(ABBREVIATION_RE, (_full, captured: string) => {
    const internalDotted = captured.replace(/\./g, PERIOD_SENTINEL)
    return `${internalDotted}${PERIOD_SENTINEL}`
  })

  // Split on a terminator group (. ! ? possibly repeated, plus optional closing
  // quotes/brackets) followed by whitespace. We keep the terminator attached to
  // the preceding sentence by splitting on the whitespace AFTER it.
  const pieces = work
    .split(SENTENCE_SPLIT_RE)
    .map((p) => p.replace(SENTINEL_RE, '.').trim())
    .filter((p) => p.length > 0)

  return pieces
}

/**
 * Return the text of the FIRST paragraph node (kind === 'paragraph'), or '' if
 * the block list has no paragraph. Used by keyphrase-in-introduction. Headings
 * and list items that appear before the first paragraph are skipped — the
 * "introduction" is specifically the opening prose paragraph.
 */
export function firstParagraph(blocks: ContentNode[]): string {
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      return block.text.trim()
    }
  }
  return ''
}

/**
 * Count how many times `phrase` occurs in `haystackWords` as a run of
 * CONSECUTIVE word matches. Case-insensitive. The phrase may be multi-word:
 * "content marketing" matches only where "content" is immediately followed by
 * "marketing". Overlapping matches are NOT double-counted — after a hit we
 * advance past the whole matched span.
 *
 * `haystackWords` must already be tokenized (lowercased) via tokenizeWords so
 * the comparison is apples-to-apples.
 */
export function countOccurrences(haystackWords: string[], phrase: string): number {
  return countOccurrencesOfTokens(haystackWords, tokenizeWords(phrase))
}

/**
 * Token-level variant of {@link countOccurrences}: the needle is ALREADY
 * tokenized (lowercased). This lets a hot caller tokenize the keyphrase ONCE
 * and reuse the token array across many haystacks (e.g. body, title, meta,
 * slug, intro) instead of re-tokenizing the same needle ~8× per analysis run.
 */
export function countOccurrencesOfTokens(
  haystackWords: string[],
  needle: string[],
): number {
  if (needle.length === 0) return 0
  if (needle.length > haystackWords.length) return 0

  let count = 0
  let i = 0
  const limit = haystackWords.length - needle.length
  while (i <= limit) {
    let matched = true
    for (let j = 0; j < needle.length; j++) {
      if (haystackWords[i + j] !== needle[j]) {
        matched = false
        break
      }
    }
    if (matched) {
      count++
      i += needle.length // non-overlapping: jump past the whole phrase
    } else {
      i++
    }
  }
  return count
}

/**
 * Return the "content words" of a keyphrase — its tokens with function/stop
 * words removed. Used by keyphrase-in-slug / -subheadings / -alt where we want
 * to match on the meaningful terms, not on "the"/"of"/"a". If EVERY word in the
 * phrase is a function word, this returns [] (the caller — functionWordsInKeyphrase
 * — treats that as a problem).
 */
export function contentWords(phrase: string, functionWords: string[]): string[] {
  const stop = new Set(functionWords)
  return tokenizeWords(phrase).filter((w) => !stop.has(w))
}

/**
 * A precomputed transition-word lookup: single-word transitions in a Set for
 * O(1) membership, multi-word transitions bucketed by their FIRST token so the
 * scorer only attempts a phrase-run match at positions where the current token
 * is a known phrase-starter. Built once per locale pack (or lazily, with a
 * cache, for hand-authored packs that ship only a flat `transitionWords` list).
 */
export interface TransitionIndex {
  single: Set<string>
  /** firstToken → array of full phrase token arrays starting with that token. */
  multi: Map<string, string[][]>
}

/**
 * Build a {@link TransitionIndex} from a flat list of transition words/phrases.
 * Each entry is tokenized with the same {@link tokenizeWords} used on the body,
 * so a phrase like "as a result" buckets under "as" as `['as','a','result']`.
 * Empty/punctuation-only entries are dropped.
 */
export function buildTransitionIndex(transitionWords: string[]): TransitionIndex {
  const single = new Set<string>()
  const multi = new Map<string, string[][]>()
  for (const phrase of transitionWords) {
    const tokens = tokenizeWords(phrase)
    if (tokens.length === 0) continue
    if (tokens.length === 1) {
      single.add(tokens[0]!)
    } else {
      const first = tokens[0]!
      const bucket = multi.get(first)
      if (bucket) bucket.push(tokens)
      else multi.set(first, [tokens])
    }
  }
  return { single, multi }
}

/**
 * The once-per-document derived text bundle. The analysis engine runs BOTH
 * scorers (SEO + readability) over the same document, and most checks need the
 * same primitives: the flattened plain text, its word tokens, its sentences,
 * and each sentence's own tokens. Computing these ONCE (in {@link
 * computeDerivedText}) and threading the bundle through both scorers avoids the
 * ~12× redundant flatten / tokenize / sentence-split that previously fired on
 * every keystroke over a 3000-word document.
 *
 * INVARIANT (asserted in tests): the concatenation of every `sentenceTokens[i]`
 * equals `words` as a multiset AND in order. Sentence boundaries fall on
 * whitespace/terminal punctuation, never inside a token, so splitting into
 * sentences and then tokenizing each sentence yields exactly the same token
 * sequence as tokenizing the whole flattened string. This is what makes it safe
 * for a check to consume `derived.words` and another to consume
 * `derived.sentenceTokens` and still agree on word counts.
 */
export interface DerivedText {
  /** Flattened plain text of all blocks, in document order. */
  plain: string
  /** Lowercased word tokens of `plain`. */
  words: string[]
  /** Sentences of `plain` (terminator-attached, abbreviation-guarded). */
  sentences: string[]
  /** Per-sentence word tokens — `sentenceTokens[i]` = tokenize(sentences[i]). */
  sentenceTokens: string[][]
  /** `words.length`, precomputed for convenience. */
  wordCount: number
  /** Word count of each block, by original block index (headings + body). */
  blockWordCounts: number[]
}

/**
 * Build the {@link DerivedText} bundle for a block list, doing each O(N) text
 * pass exactly once.
 */
export function computeDerivedText(blocks: ContentNode[]): DerivedText {
  const plain = flattenText(blocks)
  const words = tokenizeWords(plain)
  const sentences = splitSentences(plain)
  const sentenceTokens = sentences.map((s) => tokenizeWords(s))
  const blockWordCounts = blocks.map((b) => tokenizeWords(b.text).length)
  return {
    plain,
    words,
    sentences,
    sentenceTokens,
    wordCount: words.length,
    blockWordCounts,
  }
}
