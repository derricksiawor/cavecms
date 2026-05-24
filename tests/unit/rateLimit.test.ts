import { describe, it, expect } from 'vitest'
import { rateLimit } from '@/lib/auth/rateLimit'

describe('rateLimit', () => {
  it('allows up to limit then rejects', () => {
    const rl = rateLimit('test', { limit: 3, windowSec: 60 })
    expect(rl('k')).toBe(true)
    expect(rl('k')).toBe(true)
    expect(rl('k')).toBe(true)
    expect(rl('k')).toBe(false)
    expect(rl('other')).toBe(true)
  })
})
