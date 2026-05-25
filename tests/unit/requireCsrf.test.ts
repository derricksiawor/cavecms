import { describe, it, expect, vi, beforeEach } from 'vitest'
import { issueCsrf } from '@/lib/auth/csrf'

// Mock next/headers BEFORE importing requireCsrf — the helper reads the
// CSRF cookie via `cookies()` at call time. Each test rewrites the mock
// return so we can simulate a missing / wrong / valid cookie.
const cookieStore = { value: '' as string }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (_name: string) =>
      cookieStore.value ? { value: cookieStore.value } : undefined,
  }),
}))

// Force the dev cookie name path (since NODE_ENV in tests is not 'production').
import { CSRF_COOKIE } from '@/lib/auth/cookies'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { HttpError } from '@/lib/auth/requireRole'

const SESSION = { jti: 'J-test', userId: 7 }

function req(token: string | null): Request {
  return new Request('https://example.com/x', {
    method: 'POST',
    headers: token ? { 'x-csrf-token': token } : {},
  })
}

describe('requireCsrf', () => {
  beforeEach(() => {
    cookieStore.value = ''
  })

  it('uses CSRF_COOKIE (dev name in test env, never the hardcoded prod name)', () => {
    // Sanity check: tests run with NODE_ENV !== 'production', so the
    // double-submit happens against `cavecms_csrf`, NOT `__Host-cavecms_csrf`. The
    // hardcoded-name bug in Plan 02 snippets would have broken every dev
    // and test request — this assertion is the canary.
    expect(CSRF_COOKIE).toBe('cavecms_csrf')
  })

  it('throws 403 when header is missing', async () => {
    const t = await issueCsrf({ jti: SESSION.jti, sub: String(SESSION.userId) })
    cookieStore.value = t
    await expect(requireCsrf(req(null), SESSION)).rejects.toMatchObject({
      status: 403,
      code: 'csrf_invalid',
    })
  })

  it('throws 403 when cookie is missing', async () => {
    const t = await issueCsrf({ jti: SESSION.jti, sub: String(SESSION.userId) })
    cookieStore.value = ''
    await expect(requireCsrf(req(t), SESSION)).rejects.toBeInstanceOf(HttpError)
  })

  it('throws 403 when header and cookie differ', async () => {
    const a = await issueCsrf({ jti: SESSION.jti, sub: String(SESSION.userId) })
    const b = await issueCsrf({ jti: SESSION.jti, sub: String(SESSION.userId) })
    // Two distinct tokens for the same session — they should NEVER match each
    // other under double-submit even though both verify individually.
    cookieStore.value = b
    await expect(requireCsrf(req(a), SESSION)).rejects.toMatchObject({
      status: 403,
      code: 'csrf_invalid',
    })
  })

  it('throws 403 when HMAC binds to a different session', async () => {
    const t = await issueCsrf({ jti: 'OTHER', sub: String(SESSION.userId) })
    cookieStore.value = t
    await expect(requireCsrf(req(t), SESSION)).rejects.toMatchObject({
      status: 403,
      code: 'csrf_invalid',
    })
  })

  it('resolves when header == cookie and HMAC matches current session', async () => {
    const t = await issueCsrf({ jti: SESSION.jti, sub: String(SESSION.userId) })
    cookieStore.value = t
    await expect(requireCsrf(req(t), SESSION)).resolves.toBeUndefined()
  })
})
