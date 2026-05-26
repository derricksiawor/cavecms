// Public Gemini pricing for the dashboard usage card. Numbers are
// per 1M tokens, in USD, captured from
// https://ai.google.dev/pricing in January 2026. Google bills with
// distinct input/output tiers (and Pro has a context-length tier
// split at 200K); for an at-a-glance dashboard we use the lower-tier
// rate and surface "approximate" copy so an operator who cares
// about the exact bill checks the AI Studio console.
//
// AI_MODEL_IDS is the source of truth for which model strings can
// land in ai_proposals.model. Every entry there must have a row
// here; if a future model id is added without a price row, the
// estimator falls through to 0 and shows "—" rather than crash.

export interface GeminiPricing {
  /** USD per 1,000,000 input tokens (≤200K-context tier where the
   *  model has a split). */
  inputPer1M: number
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number
}

export const GEMINI_PRICING: Readonly<Record<string, GeminiPricing>> = {
  'gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5 },
  // Preview models — Google has published the pricing already, but
  // treat as the closest GA equivalent so a dashboard estimate
  // doesn't whip-saw if the preview turns into something different.
  'gemini-3-flash-preview': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-3.1-pro-preview': { inputPer1M: 1.25, outputPer1M: 5 },
  'gemini-3.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
}

/** Returns the estimated USD cost for a `(model, promptTokens,
 *  outputTokens)` triplet, or 0 if the model is unknown. The caller
 *  is expected to surface "approximate" copy alongside the number. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number,
): number {
  const rate = GEMINI_PRICING[model]
  if (!rate) return 0
  return (
    (promptTokens / 1_000_000) * rate.inputPer1M +
    (outputTokens / 1_000_000) * rate.outputPer1M
  )
}
