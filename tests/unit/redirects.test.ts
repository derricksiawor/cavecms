import { describe, it, expect } from 'vitest'
import {
  validateRedirect,
  compileRules,
  matchRedirect,
  type RedirectRule,
} from '@/lib/cms/redirects'

describe('validateRedirect', () => {
  const base = {
    source: '/old',
    matchType: 'exact' as const,
    action: 'redirect' as const,
    target: '/new',
    statusCode: 301,
    queryHandling: 'passthrough' as const,
    caseInsensitive: true,
    enabled: true,
    notes: null,
  }

  it('accepts a valid exact redirect', () => {
    expect(validateRedirect(base).ok).toBe(true)
  })

  it('rejects a source that does not start with /', () => {
    const r = validateRedirect({ ...base, source: 'old' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/start with/i)
  })

  it('rejects a self-loop (source === target) for exact rules', () => {
    expect(validateRedirect({ ...base, source: '/x', target: '/x' }).ok).toBe(false)
  })

  it('rejects an invalid regex source', () => {
    const r = validateRedirect({ ...base, matchType: 'regex', source: '/(' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/regex/i)
  })

  it('requires a target for action=redirect', () => {
    expect(validateRedirect({ ...base, target: null }).ok).toBe(false)
  })

  it('forbids a target for action=gone', () => {
    expect(
      validateRedirect({ ...base, action: 'gone', target: '/x', statusCode: null }).ok,
    ).toBe(false)
  })

  it('accepts a valid gone rule', () => {
    expect(
      validateRedirect({ ...base, action: 'gone', target: null, statusCode: null }).ok,
    ).toBe(true)
  })

  it('requires a valid status code for action=redirect', () => {
    expect(validateRedirect({ ...base, statusCode: 418 }).ok).toBe(false)
  })

  it('accepts an absolute http(s) target', () => {
    expect(validateRedirect({ ...base, target: 'https://example.com/x' }).ok).toBe(true)
  })
})

function rule(p: Partial<RedirectRule>): RedirectRule {
  return {
    id: 1,
    source: '/old',
    matchType: 'exact',
    action: 'redirect',
    target: '/new',
    statusCode: 301,
    queryHandling: 'passthrough',
    caseInsensitive: true,
    ...p,
  }
}

describe('matchRedirect', () => {
  it('matches an exact path', () => {
    const c = compileRules([rule({ source: '/old', target: '/new' })])
    expect(matchRedirect(c, '/old', '')).toEqual({
      kind: 'redirect',
      location: '/new',
      status: 301,
      ruleId: 1,
    })
  })

  it('exact match is case-insensitive when flagged', () => {
    const c = compileRules([
      rule({ source: '/Old', target: '/new', caseInsensitive: true }),
    ])
    expect(matchRedirect(c, '/old', '')?.kind).toBe('redirect')
  })

  it('passes the query string through by default', () => {
    const c = compileRules([rule({ source: '/old', target: '/new' })])
    expect(matchRedirect(c, '/old', '?utm=x')?.location).toBe('/new?utm=x')
  })

  it('ignores the query string when queryHandling=ignore', () => {
    const c = compileRules([
      rule({ source: '/old', target: '/new', queryHandling: 'ignore' }),
    ])
    expect(matchRedirect(c, '/old', '?utm=x')?.location).toBe('/new')
  })

  it('matches a wildcard prefix', () => {
    const c = compileRules([
      rule({ matchType: 'wildcard', source: '/blog/*', target: '/news' }),
    ])
    expect(matchRedirect(c, '/blog/anything/here', '')?.location).toBe('/news')
  })

  it('substitutes regex capture groups into the target', () => {
    const c = compileRules([
      rule({ matchType: 'regex', source: '^/p/(\\d+)$', target: '/product/$1' }),
    ])
    expect(matchRedirect(c, '/p/42', '')?.location).toBe('/product/42')
  })

  it('returns a gone result for action=gone', () => {
    const c = compileRules([rule({ action: 'gone', target: null, statusCode: null })])
    expect(matchRedirect(c, '/old', '')).toEqual({ kind: 'gone', ruleId: 1 })
  })

  it('prefers exact over wildcard regardless of position', () => {
    const c = compileRules([
      rule({ id: 1, matchType: 'wildcard', source: '/a/*', target: '/wild' }),
      rule({ id: 2, matchType: 'exact', source: '/a/b', target: '/exact' }),
    ])
    expect(matchRedirect(c, '/a/b', '')?.location).toBe('/exact')
  })

  it('skips a self-targeting match (loop guard)', () => {
    const c = compileRules([
      rule({ matchType: 'wildcard', source: '/x/*', target: '/x/y' }),
    ])
    expect(matchRedirect(c, '/x/y', '')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    const c = compileRules([rule({ source: '/old' })])
    expect(matchRedirect(c, '/unrelated', '')).toBeNull()
  })

  it('returns the id of the matched rule for hit counting', () => {
    const c = compileRules([rule({ id: 99, source: '/old', target: '/new' })])
    expect(matchRedirect(c, '/old', '')?.ruleId).toBe(99)
  })

  it('normalizes a trailing slash on the incoming path', () => {
    const c = compileRules([rule({ source: '/old', target: '/new' })])
    expect(matchRedirect(c, '/old/', '')?.location).toBe('/new')
  })

  it('skips a rule whose regex is invalid without breaking others', () => {
    const c = compileRules([
      rule({ id: 1, matchType: 'regex', source: '^/(', target: '/bad' }),
      rule({ id: 2, matchType: 'exact', source: '/good', target: '/ok' }),
    ])
    expect(matchRedirect(c, '/good', '')?.location).toBe('/ok')
  })

  // ── Regressions: case-sensitivity (was: lowercased fallback hit every rule) ──

  it('a case-SENSITIVE exact rule does NOT match a differing-case path', () => {
    const c = compileRules([
      rule({ source: '/Foo', target: '/sensitive', caseInsensitive: false }),
    ])
    expect(matchRedirect(c, '/Foo', '')?.location).toBe('/sensitive') // exact case hits
    expect(matchRedirect(c, '/foo', '')).toBeNull() // differing case must NOT hit
  })

  it('a case-sensitive and a case-insensitive rule sharing a lowercased key do not collide', () => {
    const c = compileRules([
      rule({ id: 1, source: '/foo', target: '/cs', caseInsensitive: false }),
      rule({ id: 2, source: '/FOO', target: '/ci', caseInsensitive: true }),
    ])
    // exact-case '/foo' → the case-sensitive rule
    expect(matchRedirect(c, '/foo', '')?.location).toBe('/cs')
    // '/FOO' → the case-insensitive rule (not dropped by a Map collision)
    expect(matchRedirect(c, '/FOO', '')?.location).toBe('/ci')
  })

  it('a long path is not matched against dynamic rules (ReDoS input bound)', () => {
    const c = compileRules([
      rule({ matchType: 'wildcard', source: '/x/*', target: '/y' }),
    ])
    const longPath = '/x/' + 'a'.repeat(5000)
    expect(matchRedirect(c, longPath, '')).toBeNull()
  })
})

describe('validateRedirect — ReDoS + query-mode hardening', () => {
  const base = {
    source: '/p',
    matchType: 'regex' as const,
    action: 'redirect' as const,
    target: '/q',
    statusCode: 301,
    queryHandling: 'passthrough' as const,
    caseInsensitive: true,
    enabled: true,
    notes: null,
  }

  it('rejects a nested-quantifier (catastrophic) regex', () => {
    const r = validateRedirect({ ...base, source: '^/(a+)+$' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/unsafe/i)
  })

  it('rejects a quantified overlapping alternation (exponential)', () => {
    // (a|a)+ is the classic exponential-backtracking shape hasNestedQuantifier missed.
    expect(validateRedirect({ ...base, source: '^/(a|a)+$' }).ok).toBe(false)
  })

  it('rejects a quantified alternation conservatively (use a char class instead)', () => {
    expect(validateRedirect({ ...base, source: '^/(a|b)+$' }).ok).toBe(false)
  })

  it('still allows alternation that is NOT repeated', () => {
    expect(validateRedirect({ ...base, source: '^/(red|blue)/x$', target: '/c' }).ok).toBe(true)
  })

  it('allows a safe single-quantifier regex', () => {
    expect(validateRedirect({ ...base, source: '^/p/(\\d+)$', target: '/q/$1' }).ok).toBe(true)
  })

  it('rejects a target containing a CR/LF control char', () => {
    expect(
      validateRedirect({ ...base, matchType: 'exact', source: '/a', target: '/b\r\nX: y' }).ok,
    ).toBe(false)
  })

  it('no longer accepts queryHandling="exact"', () => {
    expect(
      validateRedirect({
        ...base,
        matchType: 'exact',
        source: '/a',
        target: '/b',
        queryHandling: 'exact' as unknown as 'passthrough',
      }).ok,
    ).toBe(false)
  })
})
