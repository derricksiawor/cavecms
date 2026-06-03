// Public entry point for the SEO content-analysis engine. Pure +
// framework-agnostic — the SAME `runAnalysis` call powers the live editor
// (client) and bulk scoring (server). Composes the SEO scorer and the
// readability scorer, selecting a locale rule pack from `input.locale` (falling
// back to English).

import type {
  AnalysisInput,
  AnalysisConfig,
  AnalysisResult,
  LocaleRulePack,
} from './types'
import { DEFAULT_ANALYSIS_CONFIG } from './types'
import { en } from './locales/en'
import { analyzeSeo } from './seo'
import { analyzeReadability } from './readability'
import { computeDerivedText } from './text'

/**
 * Locale → rule pack registry. English ships today; additional packs register
 * by adding an entry here (or, for installs, by importing + assigning at
 * bootstrap). Keep the keys lowercased BCP-47-ish primary subtags ('en', 'de',
 * 'fr', …) so `input.locale` resolution is forgiving.
 */
export const localeRegistry: Record<string, LocaleRulePack> = {
  en,
}

/** Resolve a rule pack for a locale tag, falling back to English. We match on
 *  the primary subtag ('en-US' → 'en') so regional variants share a pack. */
function resolvePack(locale: string | undefined, override?: LocaleRulePack): LocaleRulePack {
  if (override) return override
  if (!locale) return en
  const lower = locale.toLowerCase()
  // `split('-')[0]` is always a string for a non-empty input, but TS's
  // noUncheckedIndexedAccess types it as `string | undefined`, so default it.
  const primary = lower.split('-')[0] ?? lower
  return localeRegistry[primary] ?? localeRegistry[lower] ?? en
}

export interface RunAnalysisResult {
  seo: AnalysisResult
  readability: AnalysisResult
}

/**
 * Run both scorers over a single entity.
 *
 * @param input  Structured content + metadata to score.
 * @param config Operator-tunable thresholds. Defaults to DEFAULT_ANALYSIS_CONFIG.
 * @param pack   Explicit locale pack override. Defaults to the pack selected by
 *               `input.locale` (English fallback).
 */
export function runAnalysis(
  input: AnalysisInput,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
  pack?: LocaleRulePack,
): RunAnalysisResult {
  const rulePack = resolvePack(input.locale, pack)
  // Tokenize / sentence-split the document ONCE and thread the bundle into
  // BOTH scorers (Fix 9). Also thread the resolved pack into the SEO scorer so
  // keyphrase content words honour the locale's function-word list (Fix 3).
  const derived = computeDerivedText(input.blocks)
  return {
    seo: analyzeSeo(input, config, rulePack, derived),
    readability: analyzeReadability(input, config, rulePack, derived),
  }
}

// Re-export the building blocks so consumers can import them from one place.
export { analyzeSeo } from './seo'
export { analyzeReadability } from './readability'
export { en } from './locales/en'
export * from './text'
