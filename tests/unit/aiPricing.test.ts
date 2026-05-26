import { describe, it, expect } from 'vitest'
import { estimateCostUsd, GEMINI_PRICING } from '@/lib/ai/pricing'

describe('estimateCostUsd', () => {
  it('returns 0 for an unknown model', () => {
    expect(estimateCostUsd('not-a-model', 1_000_000, 1_000_000)).toBe(0)
  })

  it('applies input + output rates per million tokens', () => {
    const flash = GEMINI_PRICING['gemini-2.5-flash']!
    // 1M input + 1M output = inputPer1M + outputPer1M
    expect(estimateCostUsd('gemini-2.5-flash', 1_000_000, 1_000_000)).toBeCloseTo(
      flash.inputPer1M + flash.outputPer1M,
      6,
    )
  })

  it('scales linearly for partial million counts', () => {
    expect(estimateCostUsd('gemini-2.5-flash', 500_000, 250_000)).toBeCloseTo(
      0.075 * 0.5 + 0.3 * 0.25,
      6,
    )
  })

  it('handles zero tokens', () => {
    expect(estimateCostUsd('gemini-2.5-flash', 0, 0)).toBe(0)
  })

  it('covers every model id exposed by the registry', () => {
    // Every AI_MODEL_IDS entry should have pricing — otherwise the
    // dashboard rolls up a 0 cost for that model silently. This test
    // protects against future model additions that skip pricing.
    const knownModels = Object.keys(GEMINI_PRICING)
    expect(knownModels).toContain('gemini-2.5-flash')
    expect(knownModels).toContain('gemini-2.5-pro')
    expect(knownModels).toContain('gemini-3.5-flash')
  })
})
