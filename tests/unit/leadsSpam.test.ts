import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { honeypotTripped } from '@/lib/leads/spam'

// getSetting is mocked to return the untouched security_recaptcha
// default so getRecaptchaServerConfig falls back to env (matching the
// pre-DB behaviour these tests were written against). Without this
// mock, unstable_cache fires outside a Next request context and
// crashes with an incremental-cache invariant.
vi.mock('@/lib/cms/getSettings', () => ({
  getSetting: vi.fn(async (key: string) => {
    if (key === 'security_recaptcha') {
      return {
        enabled: false,
        enabledOnLogin: false,
        version: 'v3',
        minScore: 0.5,
      }
    }
    return {}
  }),
}))

// honeypotTripped is the cheapest, most foundational check on lead
// forms — pin its decision matrix so a future refactor can't
// silently flip "" → trip or null → trip without the test catching it.
describe('honeypotTripped', () => {
  it('returns false for empty / null / undefined', () => {
    expect(honeypotTripped('')).toBe(false)
    expect(honeypotTripped(null)).toBe(false)
    expect(honeypotTripped(undefined)).toBe(false)
  })

  it('returns true for any non-empty string', () => {
    expect(honeypotTripped('http://spam')).toBe(true)
    expect(honeypotTripped(' ')).toBe(true) // bots often submit whitespace
    expect(honeypotTripped('a')).toBe(true)
  })
})

// checkLeadRecaptcha wraps lib/security/recaptcha.verifyRecaptcha
// with lead-form fail-open semantics. The fail-open path is gated
// by reCAPTCHA being either CONFIGURED_OFF or returning
// VERIFY_FAILED at runtime — anything else (low_score, wrong_action,
// missing token when configured) must fail closed. This test pins
// the decision matrix so a future refactor of either helper can't
// silently flip the failure-mode bias.

describe('checkLeadRecaptcha', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('passes degraded as missing_token when no token sent (any env)', async () => {
    // No-token path short-circuits BEFORE calling verifyRecaptcha,
    // so the reason is always 'missing_token' regardless of whether
    // the secret is set. Both paths are degraded-pass — fail-open
    // semantics for lead routes.
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha(null, 'lead', '127.0.0.1')
    expect(r.pass).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toBe('missing_token')
  })

  it('passes degraded (configured_off) when secret unset and token sent', async () => {
    // verifyRecaptcha short-circuits to configured_off → wrapped
    // path returns degraded pass with reason='configured_off'.
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha('whatever', 'lead', '127.0.0.1')
    expect(r.pass).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toBe('configured_off')
  })

  it('FAILS OPEN (degraded) on missing token even when keys are configured', async () => {
    // Lead-route semantics: a missing client-side token in
    // production almost always means the form's reCAPTCHA execute()
    // wasn't wired. Drop the lead silently would be worse than
    // accepting it; operators see `degraded=true,reason='missing_token'`
    // in logs and fix the wiring.
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha(null, 'lead', '127.0.0.1')
    expect(r.pass).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toBe('missing_token')
  })

  it('passes (verified) on success with score above threshold', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    vi.stubEnv('RECAPTCHA_MIN_SCORE', '0.5')
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, score: 0.9, action: 'lead' }),
          { status: 200 },
        ),
    ) as typeof fetch
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha('token', 'lead', '127.0.0.1')
    expect(r.pass).toBe(true)
    expect(r.degraded).toBe(false)
    expect(r.reason).toBe('verified')
  })

  it('FAILS CLOSED on low_score (NOT degraded)', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    vi.stubEnv('RECAPTCHA_MIN_SCORE', '0.5')
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, score: 0.1, action: 'lead' }),
          { status: 200 },
        ),
    ) as typeof fetch
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha('token', 'lead', '127.0.0.1')
    expect(r.pass).toBe(false)
    expect(r.degraded).toBe(false)
    expect(r.reason).toBe('low_score')
  })

  it('FAILS CLOSED on wrong_action', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, score: 0.9, action: 'signup' }),
          { status: 200 },
        ),
    ) as typeof fetch
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha('token', 'lead', '127.0.0.1')
    expect(r.pass).toBe(false)
    expect(r.degraded).toBe(false)
    expect(r.reason).toBe('wrong_action')
  })

  it('FAILS OPEN (degraded) on network failure', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as typeof fetch
    const { checkLeadRecaptcha } = await import('@/lib/leads/spam')
    const r = await checkLeadRecaptcha('token', 'lead', '127.0.0.1')
    expect(r.pass).toBe(true)
    expect(r.degraded).toBe(true)
    expect(r.reason).toBe('verify_failed')
  })
})
