import { describe, it, expect } from 'vitest'
import { signSessionJwt, verifySessionJwt } from '@/lib/auth/jwt'

const SUB = '42'

describe('JWT sign + verify', () => {
  it('round-trips with iss/aud/jti/oat', async () => {
    const { token, jti, oat } = await signSessionJwt(SUB, { pwp: false })
    const v = await verifySessionJwt(token)
    expect(v.sub).toBe(SUB)
    expect(v.jti).toBe(jti)
    expect(v.oat).toBe(oat)
    expect(v.pwp).toBe(false)
  })

  it('rejects malformed tokens', async () => {
    await expect(verifySessionJwt('not.a.jwt')).rejects.toThrow()
  })
})
