import { describe, it, expect } from 'vitest'
import {
  signBrochureToken,
  verifyBrochureToken,
  canonicalize,
} from '@/lib/auth/brochureToken'
import { createHmac } from 'node:crypto'

describe('brochureToken', () => {
  it('round-trips a valid token', () => {
    const t = signBrochureToken({ lead_id: 42, project_id: 7 })
    const p = verifyBrochureToken(t)
    expect(p).not.toBeNull()
    expect(p!.lead_id).toBe(42)
    expect(p!.project_id).toBe(7)
    expect(p!.v).toBe(1)
    expect(p!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('returns null for missing dot separator', () => {
    expect(verifyBrochureToken('garbage')).toBeNull()
  })

  it('returns null when payload mac mismatches (tamper)', () => {
    const t = signBrochureToken({ lead_id: 1, project_id: 1 })
    const parts = t.split('.')
    expect(parts.length).toBe(2)
    const payloadPart = parts[0]!
    const macPart = parts[1]!
    const macBytes = Buffer.from(macPart, 'base64url')
    // Flip one bit in the MAC
    macBytes[0] = (macBytes[0] ?? 0) ^ 0x01
    const tampered = `${payloadPart}.${macBytes.toString('base64url')}`
    expect(verifyBrochureToken(tampered)).toBeNull()
  })

  it('returns null when payload bytes are tampered (re-MAC required)', () => {
    const t = signBrochureToken({ lead_id: 1, project_id: 1 })
    const parts = t.split('.')
    // Swap lead_id by re-encoding payload with a different value but
    // keeping the original MAC.
    const tampered = `${Buffer.from(
      JSON.stringify({ v: 1, lead_id: 99999, project_id: 1, exp: 9999999999 }),
    ).toString('base64url')}.${parts[1]}`
    expect(verifyBrochureToken(tampered)).toBeNull()
  })

  it('returns null when expired', () => {
    // Build a token whose exp is in the past, signed with the real
    // secret. We sign via the same canonicalize used by the helper to
    // make sure only the expiry trips the check (not the MAC).
    const past = Math.floor(Date.now() / 1000) - 60
    const payload = { v: 1 as const, lead_id: 5, project_id: 5, exp: past }
    const canon = canonicalize(payload)
    const mac = createHmac('sha256', process.env.BROCHURE_SECRET!)
      .update(canon)
      .digest()
    const tok = `${Buffer.from(canon).toString('base64url')}.${mac.toString('base64url')}`
    expect(verifyBrochureToken(tok)).toBeNull()
  })

  it('rejects payloads with non-positive ids', () => {
    const canon = JSON.stringify({
      v: 1,
      lead_id: 0,
      project_id: 1,
      exp: 9999999999,
    })
    const mac = createHmac('sha256', process.env.BROCHURE_SECRET!)
      .update(canon)
      .digest()
    const tok = `${Buffer.from(canon).toString('base64url')}.${mac.toString('base64url')}`
    expect(verifyBrochureToken(tok)).toBeNull()
  })

  it('rejects v != 1', () => {
    const canon = JSON.stringify({
      v: 2,
      lead_id: 1,
      project_id: 1,
      exp: 9999999999,
    })
    const mac = createHmac('sha256', process.env.BROCHURE_SECRET!)
      .update(canon)
      .digest()
    const tok = `${Buffer.from(canon).toString('base64url')}.${mac.toString('base64url')}`
    expect(verifyBrochureToken(tok)).toBeNull()
  })
})
