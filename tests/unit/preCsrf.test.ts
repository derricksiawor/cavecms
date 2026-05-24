import { describe, it, expect, beforeEach } from 'vitest'
import { issuePreCsrf, consumePreCsrf, _resetPreCsrfMap } from '@/lib/auth/preCsrf'

describe('pre-auth CSRF', () => {
  beforeEach(() => _resetPreCsrfMap())

  it('issues and consumes once', () => {
    const v = issuePreCsrf()
    expect(consumePreCsrf(v)).toBe(true)
    expect(consumePreCsrf(v)).toBe(false) // single-use
  })

  it('rejects unknown', () => {
    expect(consumePreCsrf('garbage')).toBe(false)
  })
})
