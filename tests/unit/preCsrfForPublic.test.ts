import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  ensurePublicPreCsrf,
  consumePublicPreCsrf,
} from '@/lib/auth/preCsrfForPublic'

describe('preCsrfForPublic (HMAC-stateless)', () => {
  it('issues a token that consumes as ok', async () => {
    const tok = await ensurePublicPreCsrf()
    const r = await consumePublicPreCsrf(tok)
    expect(r).toBe('ok')
  })

  it('returns invalid for missing / empty / malformed shapes', async () => {
    expect(await consumePublicPreCsrf(null)).toBe('invalid')
    expect(await consumePublicPreCsrf(undefined)).toBe('invalid')
    expect(await consumePublicPreCsrf('')).toBe('invalid')
    expect(await consumePublicPreCsrf('no-dots')).toBe('invalid')
    expect(await consumePublicPreCsrf('a.b')).toBe('invalid')
    expect(await consumePublicPreCsrf('a.b.c.d')).toBe('invalid')
  })

  it('returns invalid when MAC is tampered', async () => {
    const tok = await ensurePublicPreCsrf()
    const parts = tok.split('.')
    const macBytes = Buffer.from(parts[2]!, 'base64url')
    macBytes[0] = (macBytes[0] ?? 0) ^ 0x01
    const tampered = `${parts[0]}.${parts[1]}.${macBytes.toString('base64url')}`
    expect(await consumePublicPreCsrf(tampered)).toBe('invalid')
  })

  it('returns invalid when random portion is swapped (MAC bound to random|exp)', async () => {
    const tok = await ensurePublicPreCsrf()
    const parts = tok.split('.')
    const swapped = `AAAAAAAAAAAAAAAAAAAAAAAA.${parts[1]}.${parts[2]}`
    expect(await consumePublicPreCsrf(swapped)).toBe('invalid')
  })

  it('returns expired when MAC verifies but exp is in the past', async () => {
    // Sign a payload with a past exp using the real secret.
    const past = Math.floor(Date.now() / 1000) - 10
    const random = 'AAAAAAAAAAAAAAAAAAAAAA'
    const mac = createHmac('sha256', process.env.CSRF_SECRET!)
      .update(`${random}|${past}`)
      .digest('base64url')
    const tok = `${random}.${past}.${mac}`
    expect(await consumePublicPreCsrf(tok)).toBe('expired')
  })

  it('returns invalid when exp is non-numeric', async () => {
    expect(await consumePublicPreCsrf('a.NaN.b')).toBe('invalid')
    expect(await consumePublicPreCsrf('a.0.b')).toBe('invalid')
    expect(await consumePublicPreCsrf('a.-1.b')).toBe('invalid')
  })

  it('returns invalid for oversized input (DoS guard)', async () => {
    expect(await consumePublicPreCsrf('a'.repeat(1024))).toBe('invalid')
  })

  it('returns invalid (not expired) when MAC is tampered AND exp is past', async () => {
    // Pins the implementation ordering — MAC check happens BEFORE
    // the exp check. If a future refactor flipped the order,
    // attackers could distinguish "real-but-expired" from "forged"
    // tokens via response shape.
    const past = Math.floor(Date.now() / 1000) - 10
    const random = 'AAAAAAAAAAAAAAAAAAAAAA'
    const realMac = createHmac('sha256', process.env.CSRF_SECRET!)
      .update(`${random}|${past}`)
      .digest()
    realMac[0] = (realMac[0] ?? 0) ^ 0x01
    const tok = `${random}.${past}.${realMac.toString('base64url')}`
    expect(await consumePublicPreCsrf(tok)).toBe('invalid')
  })
})
