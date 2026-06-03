// Readability scorer. Pure + framework-agnostic — runs client-side (live
// editor) and server-side (bulk). Mirrors the Yoast readability checks: Flesch
// reading ease, sentence length, paragraph length, subheading distribution,
// passive voice, transition words, consecutive sentences, and text presence.
//
// Each check produces an Assessment { id, score (0–9), rating, text }. The
// per-check scores are aggregated to a 0–100 readability score (see
// aggregate()). The Flesch target, passive-voice limit, and transition-word
// minimum are config-driven (AnalysisConfig) so operators can tune them; the
// structural cutoffs (20-word sentences, 150-word paragraphs, 300-word
// subheading runs, the 3-in-a-row sentence-opening rule) are fixed Yoast-
// derived constants baked into the individual checks.

import type {
  AnalysisInput,
  AnalysisConfig,
  AnalysisResult,
  Assessment,
  ContentNode,
  LocaleRulePack,
  Rating,
} from './types'
import {
  computeDerivedText,
  buildTransitionIndex,
  type DerivedText,
  type TransitionIndex,
} from './text'

// --- scoring helpers --------------------------------------------------------

// Yoast uses a 0–9 per-check scale where 9/good ≈ pass, 6/ok ≈ improvable,
// 3/bad ≈ fail. We keep that convention so the aggregate maps cleanly to 0–100.
const GOOD: Rating = 'good'
const OK: Rating = 'ok'
const BAD: Rating = 'bad'

function assess(id: string, score: number, rating: Rating, text: string): Assessment {
  return { id, score, rating, text }
}

/** Map an aggregate 0–100 to an overall traffic-light rating. */
function ratingForScore(score: number): Rating {
  if (score < 40) return BAD
  if (score < 70) return OK
  return GOOD
}

/**
 * Aggregate per-check scores (each 0–9) into a 0–100 result. We normalise by
 * the maximum achievable (checks × 9) so adding/removing a check rescales
 * cleanly. A check that is "not applicable" (e.g. subheading distribution on a
 * very short text scoring full marks) still contributes its 9, which is correct:
 * "nothing wrong here" should not drag the score down.
 */
function aggregate(assessments: Assessment[]): AnalysisResult {
  if (assessments.length === 0) {
    return { score: 0, rating: BAD, assessments }
  }
  const max = assessments.length * 9
  const sum = assessments.reduce((acc, a) => acc + a.score, 0)
  const score = Math.round((sum / max) * 100)

  // Dominant-failure override: several readability checks (paragraph length,
  // subheading distribution, consecutive openings) PASS vacuously when there is
  // no body text, which would otherwise prop an empty document up into the 'ok'
  // band. Readability of an empty document is unambiguously bad — so if the
  // text-presence gate failed, force the overall rating to 'bad' regardless of
  // the numeric average. (The numeric score is preserved for display.)
  const textPresence = assessments.find((a) => a.id === 'textPresence')
  if (textPresence && textPresence.rating === BAD) {
    return { score, rating: BAD, assessments }
  }

  return { score, rating: ratingForScore(score), assessments }
}

// --- individual checks ------------------------------------------------------


/**
 * Flesch Reading Ease:
 *   206.835 − 1.015·(words/sentences) − 84.6·(syllables/words)
 * Higher = easier. Green at/above config.fleschTarget (default 60 ≈ "plain
 * English"); we scale down linearly below the target so the per-check score
 * degrades gracefully rather than cliff-edging.
 */
function checkFlesch(
  words: string[],
  sentenceCount: number,
  pack: LocaleRulePack,
  config: AnalysisConfig,
): Assessment {
  const wordCount = words.length
  if (wordCount === 0 || sentenceCount === 0) {
    return assess(
      'fleschReadingEase',
      3,
      BAD,
      'Add some content so its reading ease can be measured.',
    )
  }
  const syllables = words.reduce((acc, w) => acc + pack.countSyllables(w), 0)
  const wordsPerSentence = wordCount / sentenceCount
  const syllablesPerWord = syllables / wordCount
  const flesch = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord
  const rounded = Math.round(flesch)

  if (flesch >= config.fleschTarget) {
    return assess(
      'fleschReadingEase',
      9,
      GOOD,
      `The Flesch reading-ease score is ${rounded}, which is easy to read.`,
    )
  }
  // Below target: 30 is the "fairly difficult" floor; treat <30 as bad, the
  // band between 30 and the target as ok.
  if (flesch >= 30) {
    return assess(
      'fleschReadingEase',
      6,
      OK,
      `The Flesch reading-ease score is ${rounded}. Try shorter sentences and simpler words.`,
    )
  }
  return assess(
    'fleschReadingEase',
    3,
    BAD,
    `The Flesch reading-ease score is ${rounded}, which is hard to read. Simplify your language.`,
  )
}

/**
 * Sentence length: percentage of sentences longer than 20 words. Green when
 * fewer than 25% exceed it (Yoast's threshold); ok up to 30%; bad above.
 */
function checkSentenceLength(sentenceTokens: string[][]): Assessment {
  if (sentenceTokens.length === 0) {
    return assess('sentenceLength', 3, BAD, 'No sentences to evaluate yet.')
  }
  const longCount = sentenceTokens.filter((t) => t.length > 20).length
  const pct = (longCount / sentenceTokens.length) * 100
  if (pct < 25) {
    return assess(
      'sentenceLength',
      9,
      GOOD,
      `${Math.round(pct)}% of sentences are over 20 words — within the recommended range.`,
    )
  }
  if (pct < 30) {
    return assess(
      'sentenceLength',
      6,
      OK,
      `${Math.round(pct)}% of sentences are over 20 words. Try to shorten some of them.`,
    )
  }
  return assess(
    'sentenceLength',
    3,
    BAD,
    `${Math.round(pct)}% of sentences are over 20 words — too many. Shorten them.`,
  )
}

/**
 * Paragraph length: each paragraph node should stay under 150 words. Green when
 * none exceed; bad when any do (with a count in the message).
 */
function checkParagraphLength(
  blocks: ContentNode[],
  blockWordCounts: number[],
): Assessment {
  // Use the precomputed per-block word counts (indexed by original block
  // position) rather than re-tokenizing each paragraph here.
  let paraCount = 0
  let over = 0
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.kind !== 'paragraph') continue
    paraCount++
    if ((blockWordCounts[i] ?? 0) > 150) over++
  }
  if (paraCount === 0) {
    return assess('paragraphLength', 9, GOOD, 'No long paragraphs detected.')
  }
  if (over === 0) {
    return assess(
      'paragraphLength',
      9,
      GOOD,
      'No paragraph exceeds the recommended 150-word maximum.',
    )
  }
  return assess(
    'paragraphLength',
    3,
    BAD,
    `${over} paragraph${over > 1 ? 's are' : ' is'} longer than 150 words. Break ${over > 1 ? 'them' : 'it'} up.`,
  )
}

/**
 * Subheading distribution: walking the blocks in order, no run of body text
 * between two consecutive headings (or before the first / after the last) may
 * exceed 300 words. Green when satisfied. Short texts (≤300 words total) pass
 * trivially — you don't need a subheading for a few sentences.
 */
function checkSubheadingDistribution(
  blocks: ContentNode[],
  blockWordCounts: number[],
): Assessment {
  let running = 0
  let worstRun = 0
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.kind === 'heading') {
      // A heading resets the running body-word counter.
      if (running > worstRun) worstRun = running
      running = 0
    } else {
      running += blockWordCounts[i] ?? 0
    }
  }
  if (running > worstRun) worstRun = running

  if (worstRun <= 300) {
    return assess(
      'subheadingDistribution',
      9,
      GOOD,
      'Subheadings are well distributed — no long stretch of text without one.',
    )
  }
  return assess(
    'subheadingDistribution',
    3,
    BAD,
    `A section of ${worstRun} words has no subheading. Add subheadings to break up long sections.`,
  )
}

/**
 * Past-participle heuristic: a token is "participle-ish" if it ends in -ed, or
 * is a common irregular participle. Used by the passive-voice check together
 * with a passive auxiliary.
 */
const IRREGULAR_PARTICIPLES = new Set([
  'done',
  'made',
  'said',
  'seen',
  'taken',
  'given',
  'written',
  'known',
  'shown',
  'gone',
  'found',
  'held',
  'kept',
  'left',
  'built',
  'bought',
  'brought',
  'caught',
  'taught',
  'sold',
  'told',
  'sent',
  'spent',
  'lost',
  'paid',
  'put',
  'set',
  'cut',
  'read',
  'led',
  'met',
  'won',
  'run',
  'begun',
  'chosen',
  'broken',
  'spoken',
  'driven',
  'eaten',
  'fallen',
  'forgotten',
  'hidden',
  'thrown',
  'grown',
  'drawn',
])

function looksLikeParticiple(word: string): boolean {
  // -ed covers most regular participles ("created", "designed"). The irregular
  // set covers high-frequency exceptions. We exclude very short -ed words like
  // "bed"/"red" by requiring length ≥ 4 for the -ed branch.
  if (word.length >= 4 && word.endsWith('ed')) return true
  return IRREGULAR_PARTICIPLES.has(word)
}

/**
 * Passive voice: percentage of sentences containing a passive construction. The
 * heuristic flags a sentence when a passive auxiliary (be/is/was/…) is followed
 * WITHIN 3 tokens by a participle-ish word ("was created", "is being designed",
 * "were quickly made"). Green when ≤ config.passiveMaxPct (default 10).
 */
function checkPassiveVoice(
  sentenceTokens: string[][],
  pack: LocaleRulePack,
  config: AnalysisConfig,
): Assessment {
  if (sentenceTokens.length === 0) {
    return assess('passiveVoice', 3, BAD, 'No sentences to evaluate yet.')
  }
  // Use the pack's precomputed Set when present; otherwise build it once here
  // (a hand-authored pack may ship only the flat list).
  const aux: ReadonlySet<string> =
    pack.passiveAuxiliarySet ?? new Set(pack.passiveAuxiliaries)
  let passiveCount = 0
  for (const tokens of sentenceTokens) {
    let isPassive = false
    for (let i = 0; i < tokens.length && !isPassive; i++) {
      const auxWord = tokens[i]
      if (auxWord === undefined || !aux.has(auxWord)) continue
      // Look ahead up to 3 tokens for a participle. This window lets an adverb
      // or two sit between the auxiliary and the participle ("was clearly made").
      const end = Math.min(tokens.length, i + 4)
      for (let j = i + 1; j < end; j++) {
        const cand = tokens[j]
        if (cand !== undefined && looksLikeParticiple(cand)) {
          isPassive = true
          break
        }
      }
    }
    if (isPassive) passiveCount++
  }
  const pct = (passiveCount / sentenceTokens.length) * 100
  if (pct <= config.passiveMaxPct) {
    return assess(
      'passiveVoice',
      9,
      GOOD,
      `${Math.round(pct)}% of sentences use the passive voice — within the recommended limit.`,
    )
  }
  if (pct <= config.passiveMaxPct * 1.5) {
    return assess(
      'passiveVoice',
      6,
      OK,
      `${Math.round(pct)}% of sentences use the passive voice. Try to use more active voice.`,
    )
  }
  return assess(
    'passiveVoice',
    3,
    BAD,
    `${Math.round(pct)}% of sentences use the passive voice — too many. Rewrite in active voice.`,
  )
}

/**
 * Transition words: percentage of sentences that contain at least one
 * transition word/phrase. Multi-word phrases are matched as a consecutive token
 * run. Green when ≥ config.transitionMinPct (default 30).
 */
function checkTransitionWords(
  sentenceTokens: string[][],
  index: TransitionIndex,
  config: AnalysisConfig,
): Assessment {
  if (sentenceTokens.length === 0) {
    return assess('transitionWords', 3, BAD, 'No sentences to evaluate yet.')
  }
  let withTransition = 0
  for (const tokens of sentenceTokens) {
    let found = false
    for (let i = 0; i < tokens.length && !found; i++) {
      const tok = tokens[i]!
      // O(1) single-word transition check.
      if (index.single.has(tok)) {
        found = true
        break
      }
      // Multi-word: only attempt a run match if this token is a known
      // phrase-starter, then check each candidate phrase bucketed under it.
      const candidates = index.multi.get(tok)
      if (candidates) {
        for (const phrase of candidates) {
          if (runMatchesAt(tokens, phrase, i)) {
            found = true
            break
          }
        }
      }
    }
    if (found) withTransition++
  }
  const pct = (withTransition / sentenceTokens.length) * 100
  if (pct >= config.transitionMinPct) {
    return assess(
      'transitionWords',
      9,
      GOOD,
      `${Math.round(pct)}% of sentences contain a transition word — good flow.`,
    )
  }
  if (pct >= config.transitionMinPct * 0.66) {
    return assess(
      'transitionWords',
      6,
      OK,
      `${Math.round(pct)}% of sentences contain a transition word. Add a few more to improve flow.`,
    )
  }
  return assess(
    'transitionWords',
    3,
    BAD,
    `Only ${Math.round(pct)}% of sentences contain a transition word. Use more to connect your ideas.`,
  )
}

/** True when `needle` matches `hay` as a consecutive run ANCHORED at `start`
 *  (i.e. hay[start..start+needle.length) === needle). Used by the transition
 *  check, which already knows `hay[start]` equals the phrase's first token. */
function runMatchesAt(
  hay: string[],
  needle: ReadonlyArray<string>,
  start: number,
): boolean {
  if (needle.length === 0 || start + needle.length > hay.length) return false
  for (let j = 0; j < needle.length; j++) {
    if (hay[start + j] !== needle[j]) return false
  }
  return true
}

/**
 * Consecutive sentences: flag when 3 or more sentences IN A ROW start with the
 * same word ("I did X. I did Y. I did Z."). Green when no such run exists.
 */
function checkConsecutiveSentences(sentenceTokens: string[][]): Assessment {
  if (sentenceTokens.length < 3) {
    return assess(
      'consecutiveSentences',
      9,
      GOOD,
      'No three consecutive sentences start with the same word.',
    )
  }
  let run = 1
  let prevFirst: string | null = null
  let maxRunWord: string | null = null
  let maxRun = 1
  for (const tokens of sentenceTokens) {
    const first = tokens.length > 0 ? tokens[0] ?? null : null
    if (first !== null && first === prevFirst) {
      run++
      if (run > maxRun) {
        maxRun = run
        maxRunWord = first
      }
    } else {
      run = 1
    }
    prevFirst = first
  }
  if (maxRun >= 3) {
    return assess(
      'consecutiveSentences',
      3,
      BAD,
      `${maxRun} consecutive sentences start with "${maxRunWord}". Vary your sentence openings.`,
    )
  }
  return assess(
    'consecutiveSentences',
    9,
    GOOD,
    'No three consecutive sentences start with the same word.',
  )
}

/** Text presence: there must be some body text to analyse at all. */
function checkTextPresence(wordCount: number): Assessment {
  if (wordCount > 0) {
    return assess('textPresence', 9, GOOD, 'Your content has text to analyse.')
  }
  return assess(
    'textPresence',
    3,
    BAD,
    'There is no body text yet. Add content to get a readability score.',
  )
}

// --- orchestration ----------------------------------------------------------

export function analyzeReadability(
  input: AnalysisInput,
  config: AnalysisConfig,
  pack: LocaleRulePack,
  derived?: DerivedText,
): AnalysisResult {
  // `runAnalysis` always supplies a precomputed bundle (tokenized once for both
  // scorers). Direct callers may omit it — we compute it here so the public
  // (input, config, pack) signature keeps working standalone.
  const d = derived ?? computeDerivedText(input.blocks)
  const { words, sentences, sentenceTokens, blockWordCounts } = d

  // Resolve the precomputed transition index from the pack; fall back to
  // building it once here for hand-authored packs that ship only the flat list.
  const transitionIndex: TransitionIndex =
    pack.transitionSingle && pack.transitionMulti
      ? {
          single: pack.transitionSingle as Set<string>,
          multi: pack.transitionMulti as Map<string, string[][]>,
        }
      : buildTransitionIndex(pack.transitionWords)

  const assessments: Assessment[] = [
    checkTextPresence(words.length),
    checkFlesch(words, sentences.length, pack, config),
    checkSentenceLength(sentenceTokens),
    checkParagraphLength(input.blocks, blockWordCounts),
    checkSubheadingDistribution(input.blocks, blockWordCounts),
    checkPassiveVoice(sentenceTokens, pack, config),
    checkTransitionWords(sentenceTokens, transitionIndex, config),
    checkConsecutiveSentences(sentenceTokens),
  ]

  return aggregate(assessments)
}
