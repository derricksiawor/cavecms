// SEO scorer. Pure + framework-agnostic — runs client-side (live editor) and
// server-side (bulk). Mirrors Yoast's SEO analysis: keyphrase placement (title,
// meta, slug, intro, subheadings), density, length, function-word guard, text
// length, image alt, links, single H1, title width, meta-description length.
//
// When no keyphrase is set, ALL keyphrase-dependent checks are skipped and a
// single 'bad' assessment (id 'keyphraseSet') prompts the operator to set one —
// matching the editor UX where the focus keyphrase is the prerequisite.

import type {
  AnalysisInput,
  AnalysisConfig,
  AnalysisResult,
  Assessment,
  LocaleRulePack,
  Rating,
} from './types'
import { en } from './locales/en'
import {
  tokenizeWords,
  firstParagraph,
  countOccurrencesOfTokens,
  computeDerivedText,
  type DerivedText,
} from './text'

/**
 * Keyphrase analysis context — the focus keyphrase tokenized ONCE
 * (`tokens`) and its content words computed ONCE (`contentWords`, with the
 * locale pack's function-word list). Threaded into every keyphrase sub-check
 * so the needle is not re-tokenized ~8× per analysis run (Fix 11).
 */
interface KeyphraseCtx {
  /** Lowercased word tokens of the keyphrase. */
  tokens: string[]
  /** Keyphrase tokens minus the locale's function words. */
  contentWords: string[]
}

const GOOD: Rating = 'good'
const OK: Rating = 'ok'
const BAD: Rating = 'bad'

function assess(id: string, score: number, rating: Rating, text: string): Assessment {
  return { id, score, rating, text }
}

function ratingForScore(score: number): Rating {
  if (score < 40) return BAD
  if (score < 70) return OK
  return GOOD
}

function aggregate(assessments: Assessment[]): AnalysisResult {
  if (assessments.length === 0) {
    return { score: 0, rating: BAD, assessments }
  }
  const max = assessments.length * 9
  const sum = assessments.reduce((acc, a) => acc + a.score, 0)
  const score = Math.round((sum / max) * 100)
  return { score, rating: ratingForScore(score), assessments }
}

// --- keyphrase-independent checks (always run) ------------------------------

/** Exactly one level-1 heading is ideal. Zero or many is a problem. */
function checkSingleH1(input: AnalysisInput): Assessment {
  const h1s = input.blocks.filter((b) => b.kind === 'heading' && b.level === 1).length
  if (h1s === 1) {
    return assess('singleH1', 9, GOOD, 'The page has exactly one H1 heading.')
  }
  if (h1s === 0) {
    return assess('singleH1', 6, OK, 'The page has no H1 heading. Add one top-level heading.')
  }
  return assess(
    'singleH1',
    3,
    BAD,
    `The page has ${h1s} H1 headings. Use exactly one top-level heading.`,
  )
}

/**
 * Title width — character-length proxy for pixel width. Google truncates around
 * 60 chars / 600px. Green ~40–60, too-long >60 (bad), too-short <30 (ok).
 */
function checkTitleWidth(input: AnalysisInput): Assessment {
  const len = input.title.trim().length
  if (len === 0) {
    return assess('titleWidth', 3, BAD, 'Add an SEO title.')
  }
  if (len > 60) {
    return assess(
      'titleWidth',
      3,
      BAD,
      `The SEO title is ${len} characters — it may be truncated in search results. Shorten it.`,
    )
  }
  if (len < 30) {
    return assess(
      'titleWidth',
      6,
      OK,
      `The SEO title is ${len} characters — quite short. Consider using more of the available width.`,
    )
  }
  return assess('titleWidth', 9, GOOD, `The SEO title is a good length (${len} characters).`)
}

/** Meta-description length. Green 120–156, ok 1–119, bad 0 or >160. */
function checkMetaDescriptionLength(input: AnalysisInput): Assessment {
  const len = input.metaDescription.trim().length
  if (len === 0) {
    return assess(
      'metaDescriptionLength',
      3,
      BAD,
      'No meta description. Add one so search engines show your summary.',
    )
  }
  if (len > 160) {
    return assess(
      'metaDescriptionLength',
      3,
      BAD,
      `The meta description is ${len} characters — it will be truncated. Keep it under 156.`,
    )
  }
  if (len >= 120 && len <= 156) {
    return assess(
      'metaDescriptionLength',
      9,
      GOOD,
      `The meta description is a good length (${len} characters).`,
    )
  }
  return assess(
    'metaDescriptionLength',
    6,
    OK,
    `The meta description is ${len} characters. Aim for 120–156 to use the full width.`,
  )
}

/** Internal links: at least one link to the same site. */
function checkInternalLinks(input: AnalysisInput): Assessment {
  const internal = input.links.filter((l) => l.internal).length
  if (internal >= 1) {
    return assess(
      'internalLinks',
      9,
      GOOD,
      `Found ${internal} internal link${internal > 1 ? 's' : ''} — good.`,
    )
  }
  return assess(
    'internalLinks',
    3,
    BAD,
    'No internal links. Link to related pages on your site.',
  )
}

/** Outbound links: at least one link to another site. */
function checkOutboundLinks(input: AnalysisInput): Assessment {
  const outbound = input.links.filter((l) => !l.internal).length
  if (outbound >= 1) {
    return assess(
      'outboundLinks',
      9,
      GOOD,
      `Found ${outbound} outbound link${outbound > 1 ? 's' : ''} — good.`,
    )
  }
  return assess(
    'outboundLinks',
    3,
    BAD,
    'No outbound links. Link to authoritative external sources.',
  )
}

// --- keyphrase-dependent checks ---------------------------------------------

/** Keyphrase in the SEO title; bonus when it appears at the very start. */
function checkKeyphraseInTitle(input: AnalysisInput, kp: KeyphraseCtx): Assessment {
  const titleWords = tokenizeWords(input.title)
  const occ = countOccurrencesOfTokens(titleWords, kp.tokens)
  if (occ === 0) {
    return assess(
      'keyphraseInTitle',
      3,
      BAD,
      'The focus keyphrase is not in the SEO title. Add it.',
    )
  }
  // "At the start" = the keyphrase's first content word matches the title's
  // first content word position (we check the leading tokens of the title).
  const phraseTokens = kp.tokens
  const atStart =
    phraseTokens.length > 0 &&
    titleWords.slice(0, phraseTokens.length).join(' ') === phraseTokens.join(' ')
  if (atStart) {
    return assess(
      'keyphraseInTitle',
      9,
      GOOD,
      'The focus keyphrase appears at the start of the SEO title — ideal.',
    )
  }
  return assess(
    'keyphraseInTitle',
    6,
    OK,
    'The focus keyphrase is in the SEO title. Moving it nearer the start can help.',
  )
}

/** Keyphrase in the meta description. */
function checkKeyphraseInMetaDescription(
  input: AnalysisInput,
  kp: KeyphraseCtx,
): Assessment {
  const words = tokenizeWords(input.metaDescription)
  const occ = countOccurrencesOfTokens(words, kp.tokens)
  if (occ >= 1) {
    return assess(
      'keyphraseInMetaDescription',
      9,
      GOOD,
      'The focus keyphrase appears in the meta description.',
    )
  }
  return assess(
    'keyphraseInMetaDescription',
    3,
    BAD,
    'The focus keyphrase is not in the meta description. Add it.',
  )
}

/** Keyphrase in slug: ALL keyphrase content words appear in the slug tokens. */
function checkKeyphraseInSlug(input: AnalysisInput, kp: KeyphraseCtx): Assessment {
  const cw = kp.contentWords
  // If the keyphrase is only function words there is nothing meaningful to find;
  // treat as ok (the functionWordsInKeyphrase check handles the real problem).
  if (cw.length === 0) {
    return assess(
      'keyphraseInSlug',
      6,
      OK,
      'The keyphrase has no distinctive words to check against the slug.',
    )
  }
  const slugTokens = new Set(tokenizeWords(input.slug.replace(/[-_/]+/g, ' ')))
  const allPresent = cw.every((w) => slugTokens.has(w))
  if (allPresent) {
    return assess('keyphraseInSlug', 9, GOOD, 'The focus keyphrase appears in the URL slug.')
  }
  return assess(
    'keyphraseInSlug',
    3,
    BAD,
    'The focus keyphrase is missing from the URL slug. Add its key words.',
  )
}

/** Keyphrase in the introduction (first paragraph). */
function checkKeyphraseInIntroduction(
  input: AnalysisInput,
  kp: KeyphraseCtx,
): Assessment {
  const intro = firstParagraph(input.blocks)
  const words = tokenizeWords(intro)
  const occ = countOccurrencesOfTokens(words, kp.tokens)
  if (occ >= 1) {
    return assess(
      'keyphraseInIntroduction',
      9,
      GOOD,
      'The focus keyphrase appears in the first paragraph.',
    )
  }
  return assess(
    'keyphraseInIntroduction',
    3,
    BAD,
    'The focus keyphrase is not in the introduction. Mention it in your first paragraph.',
  )
}

/** Keyphrase in subheadings: ≥1 content word appears in an H2 or H3. */
function checkKeyphraseInSubheadings(
  input: AnalysisInput,
  kp: KeyphraseCtx,
): Assessment {
  const cw = kp.contentWords
  if (cw.length === 0) {
    return assess(
      'keyphraseInSubheadings',
      6,
      OK,
      'The keyphrase has no distinctive words to check against subheadings.',
    )
  }
  const subheadings = input.blocks.filter(
    (b) => b.kind === 'heading' && (b.level === 2 || b.level === 3),
  )
  if (subheadings.length === 0) {
    return assess(
      'keyphraseInSubheadings',
      6,
      OK,
      'There are no H2/H3 subheadings to place the keyphrase in.',
    )
  }
  const hit = subheadings.some((h) => {
    const tokens = new Set(tokenizeWords(h.text))
    return cw.some((w) => tokens.has(w))
  })
  if (hit) {
    return assess(
      'keyphraseInSubheadings',
      9,
      GOOD,
      'A subheading contains part of the focus keyphrase.',
    )
  }
  return assess(
    'keyphraseInSubheadings',
    3,
    BAD,
    'No subheading contains the focus keyphrase. Add it to at least one H2/H3.',
  )
}

/**
 * Keyphrase density: occurrences / wordCount · 100. Green within
 * [config.keyphraseDensityMin, config.keyphraseDensityMax]. ABOVE max is
 * over-optimization (bad). BELOW min is ok if non-zero, bad if zero.
 */
function checkKeyphraseDensity(
  kp: KeyphraseCtx,
  config: AnalysisConfig,
  derived: DerivedText,
): Assessment {
  const wordCount = derived.wordCount
  if (wordCount === 0) {
    return assess(
      'keyphraseDensity',
      3,
      BAD,
      'There is no content yet to measure keyphrase density.',
    )
  }
  // Consume the once-tokenized body words + once-tokenized needle — no
  // re-flatten / re-tokenize of the whole document here.
  const occ = countOccurrencesOfTokens(derived.words, kp.tokens)
  const density = (occ / wordCount) * 100
  const d = density.toFixed(1)
  if (occ === 0) {
    return assess(
      'keyphraseDensity',
      3,
      BAD,
      'The focus keyphrase does not appear in the content. Use it a few times.',
    )
  }
  if (density > config.keyphraseDensityMax) {
    return assess(
      'keyphraseDensity',
      3,
      BAD,
      `Keyphrase density is ${d}% (${occ} times) — over-optimised. Use the keyphrase less often.`,
    )
  }
  if (density >= config.keyphraseDensityMin) {
    return assess(
      'keyphraseDensity',
      9,
      GOOD,
      `Keyphrase density is ${d}% (${occ} times) — within the recommended range.`,
    )
  }
  return assess(
    'keyphraseDensity',
    6,
    OK,
    `Keyphrase density is ${d}% (${occ} times) — a little low. Use the keyphrase a bit more.`,
  )
}

/**
 * Keyphrase length: warn when the keyphrase has more than 4 content words (too
 * long to rank well) or consists only of function words.
 */
function checkKeyphraseLength(kp: KeyphraseCtx): Assessment {
  const cw = kp.contentWords
  if (cw.length === 0) {
    return assess(
      'keyphraseLength',
      3,
      BAD,
      'The focus keyphrase has no distinctive words. Use a more specific phrase.',
    )
  }
  if (cw.length > 4) {
    return assess(
      'keyphraseLength',
      6,
      OK,
      `The focus keyphrase has ${cw.length} content words — quite long. A shorter phrase ranks better.`,
    )
  }
  return assess('keyphraseLength', 9, GOOD, 'The focus keyphrase is a good length.')
}

/** Function-words-in-keyphrase: bad when the keyphrase is ONLY function words. */
function checkFunctionWordsInKeyphrase(kp: KeyphraseCtx): Assessment {
  const tokens = kp.tokens
  const cw = kp.contentWords
  if (tokens.length > 0 && cw.length === 0) {
    return assess(
      'functionWordsInKeyphrase',
      3,
      BAD,
      'The focus keyphrase contains only function words. Use meaningful terms.',
    )
  }
  return assess(
    'functionWordsInKeyphrase',
    9,
    GOOD,
    'The focus keyphrase contains meaningful words.',
  )
}

/**
 * Text length: word count vs config.minWords (or cornerstoneMinWords when the
 * page is cornerstone content). Green at/above target; ok within ~75% of it;
 * bad below.
 */
function checkTextLength(
  input: AnalysisInput,
  config: AnalysisConfig,
  wordCount: number,
): Assessment {
  const target = input.cornerstone ? config.cornerstoneMinWords : config.minWords
  if (wordCount >= target) {
    return assess(
      'textLength',
      9,
      GOOD,
      `The text is ${wordCount} words — meets the ${target}-word minimum.`,
    )
  }
  if (wordCount >= target * 0.75) {
    return assess(
      'textLength',
      6,
      OK,
      `The text is ${wordCount} words. Aim for at least ${target} words.`,
    )
  }
  return assess(
    'textLength',
    3,
    BAD,
    `The text is only ${wordCount} words — well below the ${target}-word minimum. Add more content.`,
  )
}

/**
 * Keyphrase in image alt: at least one image's alt contains a keyphrase content
 * word, scaled to image count. When there are NO images this is not a failure —
 * we return good (you can't have keyphrase-in-alt without images, and forcing
 * images is out of scope for this check).
 */
function checkKeyphraseInImageAlt(
  input: AnalysisInput,
  kp: KeyphraseCtx,
): Assessment {
  if (input.images.length === 0) {
    return assess(
      'keyphraseInImageAlt',
      9,
      GOOD,
      'No images to check — nothing to optimise here.',
    )
  }
  const cw = kp.contentWords
  if (cw.length === 0) {
    return assess(
      'keyphraseInImageAlt',
      6,
      OK,
      'The keyphrase has no distinctive words to check against image alt text.',
    )
  }
  const withKeyphrase = input.images.filter((img) => {
    const tokens = new Set(tokenizeWords(img.alt))
    return cw.some((w) => tokens.has(w))
  }).length
  if (withKeyphrase >= 1) {
    return assess(
      'keyphraseInImageAlt',
      9,
      GOOD,
      `${withKeyphrase} of ${input.images.length} images use the keyphrase in their alt text.`,
    )
  }
  return assess(
    'keyphraseInImageAlt',
    3,
    BAD,
    'None of your images use the focus keyphrase in their alt text. Add it to at least one.',
  )
}

// --- orchestration ----------------------------------------------------------

/**
 * Run the SEO scorer.
 *
 * @param input   Structured content + metadata.
 * @param config  Operator-tunable thresholds. Defaults to DEFAULT_ANALYSIS_CONFIG.
 * @param pack    Locale rule pack supplying the function-word list used to
 *                derive keyphrase content words. Defaults to English so a
 *                standalone `analyzeSeo(input, config)` call keeps working;
 *                `runAnalysis` always threads the resolved pack (Fix 3).
 * @param derived Precomputed once-per-document text bundle. Supplied by
 *                `runAnalysis` so the document is tokenized ONCE across both
 *                scorers; computed here when a direct caller omits it (Fix 9).
 */
export function analyzeSeo(
  input: AnalysisInput,
  config: AnalysisConfig,
  pack?: LocaleRulePack,
  derived?: DerivedText,
): AnalysisResult {
  // No keyphrase → a single prompting assessment, ALL keyphrase checks skipped.
  if (!input.keyphrase || !input.keyphrase.trim()) {
    return aggregate([
      assess(
        'keyphraseSet',
        3,
        BAD,
        'Set a focus keyphrase to unlock the full SEO analysis.',
      ),
    ])
  }

  // Resolve the function-word list from the supplied pack (Fix 3), defaulting
  // to English when called standalone without a pack.
  const functionWords = pack?.functionWords ?? en.functionWords
  const d = derived ?? computeDerivedText(input.blocks)

  // Tokenize the keyphrase + derive its content words ONCE (Fix 11), then
  // thread the bundle into every keyphrase sub-check.
  const kpTokens = tokenizeWords(input.keyphrase)
  const stop = new Set(functionWords)
  const kp: KeyphraseCtx = {
    tokens: kpTokens,
    contentWords: kpTokens.filter((w) => !stop.has(w)),
  }

  const assessments: Assessment[] = [
    // Keyphrase-dependent
    checkKeyphraseInTitle(input, kp),
    checkKeyphraseInMetaDescription(input, kp),
    checkKeyphraseInSlug(input, kp),
    checkKeyphraseInIntroduction(input, kp),
    checkKeyphraseInSubheadings(input, kp),
    checkKeyphraseDensity(kp, config, d),
    checkKeyphraseLength(kp),
    checkFunctionWordsInKeyphrase(kp),
    checkTextLength(input, config, d.wordCount),
    checkKeyphraseInImageAlt(input, kp),
    // Keyphrase-independent (still run)
    checkInternalLinks(input),
    checkOutboundLinks(input),
    checkSingleH1(input),
    checkTitleWidth(input),
    checkMetaDescriptionLength(input),
  ]

  return aggregate(assessments)
}
