import { describe, it, expect } from 'vitest'
import {
  validateTermSlug,
  TAXONOMY_RESERVED,
} from '@/lib/cms/taxonomy-slug'

// A LOGIN_PATH that satisfies the env constraint (6-32 lowercase/dash) so the
// term-slug validator's login-path collision branch is exercised realistically.
const LOGIN = 'kqt9ji3jrhz7'

describe('validateTermSlug', () => {
  it('accepts a normal lowercase-hyphen slug', () => {
    expect(validateTermSlug('design-notes', LOGIN)).toEqual({ ok: true })
    expect(validateTermSlug('interiors', LOGIN)).toEqual({ ok: true })
    expect(validateTermSlug('a2', LOGIN)).toEqual({ ok: true })
  })

  it('rejects every taxonomy-reserved sub-path word', () => {
    for (const word of TAXONOMY_RESERVED) {
      expect(validateTermSlug(word, LOGIN)).toEqual({
        ok: false,
        reason: 'slug_reserved',
      })
    }
    // The exact four the spec calls out.
    expect(validateTermSlug('category', LOGIN).ok).toBe(false)
    expect(validateTermSlug('tag', LOGIN).ok).toBe(false)
    expect(validateTermSlug('feed', LOGIN).ok).toBe(false)
    expect(validateTermSlug('page', LOGIN).ok).toBe(false)
  })

  it('rejects globally-reserved top-level words too (superset of page-slug rules)', () => {
    expect(validateTermSlug('admin', LOGIN).ok).toBe(false)
    expect(validateTermSlug('api', LOGIN).ok).toBe(false)
    // 'blog' is a global reserved word — a category slug 'blog' would shadow
    // the segment, so it must be rejected.
    expect(validateTermSlug('blog', LOGIN).ok).toBe(false)
  })

  it('rejects the configured login path', () => {
    const r = validateTermSlug(LOGIN, LOGIN)
    expect(r.ok).toBe(false)
  })

  it('rejects malformed slugs (format/whitespace/case/leading-hyphen)', () => {
    expect(validateTermSlug('Design', LOGIN).ok).toBe(false) // uppercase
    expect(validateTermSlug('design notes', LOGIN).ok).toBe(false) // space
    expect(validateTermSlug('-design', LOGIN).ok).toBe(false) // leading hyphen
    expect(validateTermSlug('design-', LOGIN).ok).toBe(false) // trailing hyphen
    expect(validateTermSlug('de--sign', LOGIN).ok).toBe(false) // double hyphen
    expect(validateTermSlug('a', LOGIN).ok).toBe(false) // too short (< 2)
    expect(validateTermSlug('_x', LOGIN).ok).toBe(false) // underscore prefix
    expect(validateTermSlug('.x', LOGIN).ok).toBe(false) // dotfile prefix
  })

  it('rejects non-ASCII / confusable input', () => {
    expect(validateTermSlug('désign', LOGIN).ok).toBe(false)
    // Fullwidth Latin "ｄesign" normalises differently → rejected.
    expect(validateTermSlug('ｄesign', LOGIN).ok).toBe(false)
  })

  it('reserved set is exactly the four blog sub-paths', () => {
    expect([...TAXONOMY_RESERVED].sort()).toEqual(
      ['category', 'feed', 'page', 'tag'],
    )
  })
})
