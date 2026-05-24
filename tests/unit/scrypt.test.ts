import { describe, it, expect } from 'vitest'
import { hashPassword, verifyPassword, getDummyScryptHash } from '@/lib/auth/scrypt'

describe('scrypt', () => {
  it('round-trips a password', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(h.startsWith('scrypt$N=131072$r=8$p=1$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })

  it('produces a dummy hash usable for constant-time non-existent users', async () => {
    const dummy = await getDummyScryptHash()
    expect(dummy.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('anything', dummy)).toBe(false)
  })

  it('returns the same Promise across getDummyScryptHash() calls (memoised)', async () => {
    const a = getDummyScryptHash()
    const b = getDummyScryptHash()
    expect(a).toBe(b)
  })
})
