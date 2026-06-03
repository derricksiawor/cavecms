import { describe, it, expect, vi, beforeEach } from 'vitest'

const { ctx } = vi.hoisted(() => ({
  ctx: { userId: 7, jti: 'jti', role: 'admin' as const, email: 'a@b.c', oat: 0, iat: 0, pwp: false },
}))
vi.mock('@/lib/auth/requireRole', async (orig) => {
  const real = await (orig() as Promise<Record<string, unknown>>)
  return { ...real, requireRole: vi.fn().mockResolvedValue(ctx) }
})
vi.mock('@/lib/auth/requireCsrf', () => ({ requireCsrf: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/auth/cmsRateLimit', () => ({ checkMutationRate: vi.fn() }))
vi.mock('@/lib/backups/cloud/clients', () => ({
  getClientId: () => 'test-client',
  isProviderConfigured: () => true,
  clientFingerprint: () => 'fp',
}))
vi.mock('@/lib/backups/cloud/oauthClient', () => ({
  requestDeviceCode: vi.fn().mockResolvedValue({
    deviceCode: 'dev',
    userCode: 'WXYZ-1234',
    verificationUrl: 'https://www.google.com/device',
    expiresIn: 1800,
    intervalSec: 5,
  }),
}))
const updated: Array<{ key: string }> = []
vi.mock('@/lib/cms/writeSetting', () => ({
  updateSettingValue: vi.fn(async (key: string, mutate: (c: unknown) => unknown) => {
    updated.push({ key })
    return mutate({})
  }),
}))
vi.mock('@/lib/api/auditMeta', () => ({
  auditMetaFromRequest: () => ({ ip: '127.0.0.1', userAgent: 'x', requestId: 'r' }),
}))
vi.mock('@/db/client', () => ({ db: { insert: () => ({ values: async () => undefined }) } }))
vi.mock('@/db/schema', () => ({ auditLog: {} }))

import { POST } from '@/app/api/admin/backups/destinations/connect/route'

beforeEach(() => {
  updated.length = 0
})

function req(body: unknown) {
  return new Request('http://localhost/api/admin/backups/destinations/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST connect', () => {
  it('returns the user code + verification url and stashes pending state', async () => {
    const res = await POST(req({ provider: 'gdrive' }), {})
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.userCode).toBe('WXYZ-1234')
    expect(json.verificationUrl).toBe('https://www.google.com/device')
    expect(updated.some((u) => u.key === 'backups_state')).toBe(true)
  })

  it('rejects an unknown provider with 400', async () => {
    const res = await POST(req({ provider: 'dropbox' }), {})
    expect(res.status).toBe(400)
  })
})
