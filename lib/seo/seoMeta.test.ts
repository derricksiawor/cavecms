import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { parseSeoMeta } from '@/lib/seo/seoMeta'
import {
  parsePanelSeoMeta,
  SeoEditorFields,
} from '@/lib/cms/seoEditorFields'

// ─────────────────────────────────────────────────────────────────────
// Fix 2 — canonical_url refine must REJECT a protocol-relative `//evil.com`
// (which the old `^/` branch accepted) while still accepting an absolute
// http(s) URL, a single-leading-slash path, '', and null/undefined.
// ─────────────────────────────────────────────────────────────────────
describe('SeoEditorFields.canonicalUrl refine (protocol-relative hijack)', () => {
  // Wrap the single field in an object schema so we can safeParse it.
  const schema = z.object({ canonicalUrl: SeoEditorFields.canonicalUrl })
  const accepts = (v: unknown) =>
    schema.safeParse({ canonicalUrl: v }).success

  it('REJECTS a protocol-relative `//evil.com` (the security LOW)', () => {
    expect(accepts('//evil.com')).toBe(false)
    expect(accepts('//evil.com/path')).toBe(false)
    // Even a triple slash is still leading-`//` → rejected.
    expect(accepts('///evil.com')).toBe(false)
  })

  it('accepts a root-relative path with a single leading slash', () => {
    expect(accepts('/path')).toBe(true)
    expect(accepts('/')).toBe(true)
    expect(accepts('/a/b/c')).toBe(true)
  })

  it('accepts absolute http(s) URLs', () => {
    expect(accepts('https://x.com')).toBe(true)
    expect(accepts('http://x.com')).toBe(true)
    expect(accepts('https://x.com/a/b')).toBe(true)
  })

  it('accepts empty string, null, and undefined (cleared / absent)', () => {
    expect(accepts('')).toBe(true)
    expect(accepts(null)).toBe(true)
    expect(accepts(undefined)).toBe(true)
  })

  it('still rejects javascript:/data: schemes', () => {
    expect(accepts('javascript:alert(1)')).toBe(false)
    expect(accepts('data:text/html,x')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Fix 5 — parseSeoMeta (server) must produce output IDENTICAL to the
// client parsePanelSeoMeta, because it now DELEGATES to it (one parser
// body). Spot-check a spread of inputs.
// ─────────────────────────────────────────────────────────────────────
describe('parseSeoMeta delegates to parsePanelSeoMeta (identical output)', () => {
  const cases: unknown[] = [
    null,
    undefined,
    '',
    '   ',
    'not json{',
    '[]',
    '{}',
    JSON.stringify({ ogTitle: 'Hi', ogDescription: '' }),
    JSON.stringify({
      ogTitle: 'T',
      twitterDescription: 'D',
      schemaType: 'FAQPage',
      schemaData: { items: [{ question: 'Q', answer: 'A' }] },
      extraKeyphrases: ['a', 1, 'b'],
    }),
    JSON.stringify({ schemaType: 'NotAType' }), // unknown type dropped
    { ogTitle: 'AlreadyObject', schemaData: {} }, // pre-parsed object, empty data dropped
    42, // non-object scalar → {}
  ]

  it('matches field-for-field across a spread of raw inputs', () => {
    for (const raw of cases) {
      expect(parseSeoMeta(raw)).toEqual(parsePanelSeoMeta(raw))
    }
  })

  it('drops an unknown schemaType (typo cannot smuggle a bad @type)', () => {
    expect(parseSeoMeta(JSON.stringify({ schemaType: 'Bogus' }))).toEqual({})
  })

  it('normalizes the empty/cleared state to {} (no null/""/[]/{} keys)', () => {
    expect(
      parseSeoMeta(
        JSON.stringify({
          ogTitle: '',
          ogDescription: '',
          extraKeyphrases: [],
          schemaData: {},
        }),
      ),
    ).toEqual({})
  })
})
