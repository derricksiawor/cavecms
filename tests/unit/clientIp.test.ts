import { describe, it, expect } from 'vitest'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

describe('clientIpFromHeaders', () => {
  it('trusts X-Real-IP from loopback only', () => {
    expect(clientIpFromHeaders({ 'x-real-ip': '8.8.8.8' }, '127.0.0.1')).toBe('8.8.8.8')
    expect(clientIpFromHeaders({ 'x-real-ip': '8.8.8.8' }, '203.0.113.4')).toBe('203.0.113.4')
  })

  it('rejects garbage X-Real-IP', () => {
    expect(clientIpFromHeaders({ 'x-real-ip': 'not-an-ip' }, '127.0.0.1')).toBe(null)
  })
})
