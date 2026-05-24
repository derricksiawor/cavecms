import { describe, it, expect } from 'vitest'
import { issueCsrf, verifyCsrf } from '@/lib/auth/csrf'

describe('CSRF (session-bound)', () => {
  it('round-trips for the same session jti+sub', async () => {
    const t = await issueCsrf({ jti: 'J', sub: '7' })
    expect(await verifyCsrf(t, { jti: 'J', sub: '7' })).toBe(true)
  })

  it('rejects different session', async () => {
    const t = await issueCsrf({ jti: 'J', sub: '7' })
    expect(await verifyCsrf(t, { jti: 'K', sub: '7' })).toBe(false)
  })

  it('rejects expired', async () => {
    const t = await issueCsrf({ jti: 'J', sub: '7' }, { nowSec: 0 })
    expect(await verifyCsrf(t, { jti: 'J', sub: '7' })).toBe(false)
  })

  it('rejects non-canonical timestamp encodings (leading-zero variant)', async () => {
    // Issue a real token, then surgically replace its ts segment with a
    // leading-zero variant that parses to the same integer. Without the
    // leading-zero rejection, an attacker could produce many wire-distinct
    // tokens from one stolen MAC binding.
    const t = await issueCsrf({ jti: 'J', sub: '7' })
    const [nonce, tsB64, macB64] = t.split('.') as [string, string, string]
    const ts = Buffer.from(tsB64, 'base64url').toString('utf8')
    const variantTs = '0' + ts
    const variantTsB64 = Buffer.from(variantTs).toString('base64url')
    const variant = [nonce, variantTsB64, macB64].join('.')
    expect(await verifyCsrf(variant, { jti: 'J', sub: '7' })).toBe(false)
  })
})
