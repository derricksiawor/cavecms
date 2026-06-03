// Pure, framework-agnostic content-analysis contracts. The engine runs
// BOTH client-side (live editor scoring) and server-side (bulk scoring),
// so nothing in the analysis/* tree may import `server-only`, node
// built-ins, or DOM globals. Input is STRUCTURED (already-extracted text
// + headings + links + images) — HTML/DOM extraction is a separate
// concern (Phase 5 client helper) so this layer is trivially testable.

export type Rating = 'bad' | 'ok' | 'good'

export interface Assessment {
  /** Stable id, e.g. 'keyphraseInTitle'. React key + test anchor. */
  id: string
  /** Per-check score contribution, 0–9 (Yoast convention). */
  score: number
  /** Traffic-light rating for this single check. */
  rating: Rating
  /** Operator-facing message — already resolved, contains no %vars%. */
  text: string
}

export interface AnalysisResult {
  /** Aggregate 0–100 for this scorer. */
  score: number
  rating: Rating
  assessments: Assessment[]
}

export interface HeadingNode {
  level: number // 1–6
  text: string
}

/** Ordered body content node. The DOM/markdown extractor emits these in
 *  document order so readability can measure paragraph length AND
 *  subheading distribution (words between consecutive headings), and seo
 *  can find the intro paragraph + keyphrase-in-subheadings. */
export type ContentNode =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'listitem'; text: string }
export interface LinkNode {
  href: string
  text: string
  /** True when the link targets the same site (relative or same host). */
  internal: boolean
  /** rel attribute, lowercased (e.g. 'nofollow'), when present. */
  rel?: string
}
export interface ImageNode {
  src: string
  alt: string
}

export interface AnalysisInput {
  /** Resolved SEO title (what renders in <title>). */
  title: string
  /** Resolved meta description. */
  metaDescription: string
  /** URL slug (last path segment) — for keyphrase-in-slug. */
  slug: string
  /** Full canonical URL, when available. */
  url?: string
  /** Primary focus keyphrase (may be ''). */
  keyphrase: string
  /** Premium-style additional keyphrases / synonyms. */
  synonyms?: string[]
  /** Ordered body content (paragraphs, headings, list items) — the single
   *  source for derived plain text, word count, intro paragraph, and
   *  subheading distribution. Helpers in analysis/text.ts flatten it. */
  blocks: ContentNode[]
  links: LinkNode[]
  images: ImageNode[]
  /** Locale tag, default 'en' — selects the rule pack. */
  locale?: string
  /** Cornerstone content uses the higher min-word target. */
  cornerstone?: boolean
}

/** Operator-tunable thresholds (subset of the seo_analysis setting). */
export interface AnalysisConfig {
  keyphraseDensityMin: number // percent
  keyphraseDensityMax: number // percent
  minWords: number
  cornerstoneMinWords: number
  fleschTarget: number
  passiveMaxPct: number
  transitionMinPct: number
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  keyphraseDensityMin: 0.5,
  keyphraseDensityMax: 3,
  minWords: 300,
  cornerstoneMinWords: 900,
  fleschTarget: 60,
  passiveMaxPct: 10,
  transitionMinPct: 30,
}

/** Per-locale rule pack — pluggable so non-English installs add their own. */
export interface LocaleRulePack {
  locale: string
  /** Transition words/phrases (lowercased); multi-word phrases allowed.
   *  Hand-authored packs supply ONLY this list; the precomputed lookup
   *  structures below are optional and, when absent, the readability check
   *  derives them on demand (with a per-call cache). For the shipped packs
   *  (en) they are precomputed at module load. */
  transitionWords: string[]
  /** PRECOMPUTED: single-word transitions as a Set for O(1) membership. */
  transitionSingle?: ReadonlySet<string>
  /** PRECOMPUTED: multi-word transitions keyed by FIRST token →
   *  array of full phrase-token arrays. The readability check only attempts a
   *  multi-word run match at positions where the token is a known starter. */
  transitionMulti?: ReadonlyMap<string, ReadonlyArray<ReadonlyArray<string>>>
  /** Passive-voice auxiliary forms (be-verbs etc.), lowercased. */
  passiveAuxiliaries: string[]
  /** PRECOMPUTED: passiveAuxiliaries as a Set (avoids rebuilding per call). */
  passiveAuxiliarySet?: ReadonlySet<string>
  /** Stop / function words, lowercased. */
  functionWords: string[]
  /** Estimate syllable count of a single lowercased word (Flesch input). */
  countSyllables: (word: string) => number
}
