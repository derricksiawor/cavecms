import { describe, it, expect } from 'vitest'
import {
  validateInlineRequest,
  newProposalToken,
  InlineRequestSchema,
} from '@/lib/ai/runProposal'
import { normaliseAcceptIndices } from '@/lib/ai/applyProposal'
import { HttpError } from '@/lib/auth/requireRole'

// PR 3 contract tests for the pure-validation surfaces of the propose
// + apply pipeline. The DB-touching paths (persistInlineProposal,
// applyInlineProposalByToken, dismissProposalByToken) are exercised
// in the Playwright walkthrough — they require a live MySQL
// connection + a hydrated content_blocks row + a real Gemini run.
// The validation helpers here are pure functions so they live in the
// fast unit tier.

describe('validateInlineRequest', () => {
  const ok = {
    pageId: 1,
    blockId: 42,
    intent: 'rewrite' as const,
    toneChip: 'punchier' as const,
  }

  it('accepts a minimal rewrite body', () => {
    expect(validateInlineRequest(ok)).toMatchObject({
      pageId: 1,
      blockId: 42,
      intent: 'rewrite',
      toneChip: 'punchier',
    })
  })

  it('accepts translate with language', () => {
    expect(
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'translate',
        language: 'fr',
      }),
    ).toMatchObject({ intent: 'translate', language: 'fr' })
  })

  it('rejects translate without language', () => {
    expect(() =>
      validateInlineRequest({ pageId: 1, blockId: 1, intent: 'translate' }),
    ).toThrow(HttpError)
  })

  it('rejects rewrite with language', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'rewrite',
        language: 'fr',
      }),
    ).toThrow(HttpError)
  })

  it('rejects translate with toneChip', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'translate',
        language: 'fr',
        toneChip: 'punchier',
      }),
    ).toThrow(HttpError)
  })

  it('rejects unknown intent', () => {
    expect(() =>
      validateInlineRequest({ pageId: 1, blockId: 1, intent: 'delete' }),
    ).toThrow(HttpError)
  })

  it('rejects negative blockId', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: -1,
        intent: 'rewrite',
        toneChip: 'punchier',
      }),
    ).toThrow(HttpError)
  })

  it('rejects freeText with bidi-override character', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'rewrite',
        toneChip: 'punchier',
        freeText: 'hello‮world',
      }),
    ).toThrow(HttpError)
  })

  it('rejects freeText over 240 chars', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'rewrite',
        toneChip: 'punchier',
        freeText: 'a'.repeat(241),
      }),
    ).toThrow(HttpError)
  })

  it('accepts freeText at the 240 cap', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'rewrite',
        toneChip: 'punchier',
        freeText: 'a'.repeat(240),
      }),
    ).not.toThrow()
  })

  it('rejects unknown tone chip', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'rewrite',
        toneChip: 'sassy',
      }),
    ).toThrow(HttpError)
  })

  it('rejects unknown language code', () => {
    expect(() =>
      validateInlineRequest({
        pageId: 1,
        blockId: 1,
        intent: 'translate',
        language: 'xx',
      }),
    ).toThrow(HttpError)
  })

  it('strict schema rejects unknown top-level fields', () => {
    expect(
      InlineRequestSchema.safeParse({
        pageId: 1,
        blockId: 1,
        intent: 'rewrite',
        toneChip: 'punchier',
        extra: 'evil',
      }).success,
    ).toBe(false)
  })
})

describe('newProposalToken', () => {
  it('emits a 32-byte base64url string (43 chars, URL-safe)', () => {
    const tok = newProposalToken()
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('mints unique tokens', () => {
    const set = new Set<string>()
    for (let i = 0; i < 200; i++) set.add(newProposalToken())
    expect(set.size).toBe(200)
  })
})

describe('normaliseAcceptIndices', () => {
  it('returns null for null input', () => {
    expect(normaliseAcceptIndices(null, 5)).toBeNull()
  })

  it('dedupes + sorts ascending', () => {
    expect(normaliseAcceptIndices([2, 0, 2, 1, 0], 5)).toEqual([0, 1, 2])
  })

  it('throws on out-of-range', () => {
    expect(() => normaliseAcceptIndices([3], 3)).toThrow(HttpError)
  })

  it('throws on negative index', () => {
    expect(() => normaliseAcceptIndices([-1, 0], 3)).toThrow(HttpError)
  })

  it('accepts empty list', () => {
    expect(normaliseAcceptIndices([], 5)).toEqual([])
  })
})
