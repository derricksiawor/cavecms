import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verifyRecaptcha } from '@/lib/security/recaptcha'

// env.ts validates at module-load. The test config (.env.local) has
// RECAPTCHA_SECRET_KEY unset, so the initial import sees configured_off.
// For the verify-path branches we re-import with vi.stubEnv setting the key.
//
// getSetting is mocked to return the registry-default shape for
// security_recaptcha (enabled=false, no keys). That triggers the
// env-fallback branch in getRecaptchaServerConfig, so the tests
// continue to exercise the env-driven verify pipeline against the
// stubbed RECAPTCHA_SECRET_KEY values.
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

describe('verifyRecaptcha', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('returns configured_off when secret key is unset', async () => {
    const r = await verifyRecaptcha('any-token', 'login')
    expect(r.ok).toBe(true)
    expect(r.reason).toBe('configured_off')
  })

  it('returns verify_failed for empty token when secret is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify_failed')
  })

  it('rejects when Google reports success=false', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      'error-codes': ['invalid-input-response'],
    }), { status: 200 })) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify_failed')
  })

  it('rejects when action does not match expected', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      score: 0.9,
      action: 'signup',
    }), { status: 200 })) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('wrong_action')
    expect(r.score).toBe(0.9)
  })

  it('rejects when score below threshold', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    vi.stubEnv('RECAPTCHA_MIN_SCORE', '0.5')
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      score: 0.3,
      action: 'login',
    }), { status: 200 })) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('low_score')
    expect(r.score).toBe(0.3)
  })

  it('accepts on success with score above threshold and matching action', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    vi.stubEnv('RECAPTCHA_MIN_SCORE', '0.5')
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      score: 0.9,
      action: 'login',
    }), { status: 200 })) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(true)
    expect(r.reason).toBe('verified')
    expect(r.score).toBe(0.9)
  })

  it('rejects on network failure', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    globalThis.fetch = vi.fn(async () => { throw new Error('network down') }) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify_failed')
  })

  it('rejects on non-2xx HTTP from Google', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    globalThis.fetch = vi.fn(async () => new Response('Server Error', { status: 500 })) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('verify_failed')
  })

  it('treats missing score as 0 (low_score under default threshold)', async () => {
    vi.stubEnv('NEXT_PUBLIC_RECAPTCHA_SITE_KEY', 'sk'.repeat(8))
    vi.stubEnv('RECAPTCHA_SECRET_KEY', 'x'.repeat(32))
    vi.stubEnv('RECAPTCHA_MIN_SCORE', '0.5')
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      action: 'login',
      // no score field
    }), { status: 200 })) as typeof fetch
    const mod = await import('@/lib/security/recaptcha')
    const r = await mod.verifyRecaptcha('token', 'login')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('low_score')
  })
})
