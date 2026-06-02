import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret, AAD_BACKUP_PENDING_DEVICE_CODE } from '@/lib/security/secretCipher'

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
  getClientSecret: () => 'test-secret',
  clientFingerprint: () => 'fp',
}))

const oauth = vi.hoisted(() => ({
  pollDeviceToken: vi.fn(),
  fetchAccountEmail: vi.fn().mockResolvedValue('owner@example.com'),
}))
vi.mock('@/lib/backups/cloud/oauthClient', () => oauth)

vi.mock('@/lib/api/auditMeta', () => ({
  auditMetaFromRequest: () => ({ ip: '127.0.0.1', userAgent: 'x', requestId: 'r' }),
}))
vi.mock('@/db/client', () => ({ db: { insert: () => ({ values: async () => undefined }) } }))
vi.mock('@/db/schema', () => ({ auditLog: {} }))

// Pending state holds a valid encrypted device code so the route can decrypt it.
const validPending = () => ({
  gdrivePending: {
    deviceCode: encryptSecret('dev-code', AAD_BACKUP_PENDING_DEVICE_CODE),
    userCode: 'WXYZ-1234',
    verificationUrl: 'https://www.google.com/device',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    intervalSec: 5,
  },
})
let stateValue: Record<string, unknown> = validPending()
let backupsValue: Record<string, unknown> = {}
vi.mock('@/lib/cms/getSettings', () => ({
  getSetting: vi.fn(async (k: string) => (k === 'backups_state' ? stateValue : backupsValue)),
}))
const writes: Array<{ key: string; result: unknown }> = []
vi.mock('@/lib/cms/writeSetting', () => ({
  updateSettingValue: vi.fn(async (key: string, mutate: (c: unknown) => unknown) => {
    const base = key === 'backups_state' ? stateValue : backupsValue
    const result = mutate(base)
    if (key === 'backups_state') stateValue = result as Record<string, unknown>
    else backupsValue = result as Record<string, unknown>
    writes.push({ key, result })
    return result
  }),
}))

import { POST } from '@/app/api/admin/backups/destinations/connect/poll/route'

beforeEach(() => {
  writes.length = 0
  backupsValue = {}
  stateValue = validPending()
})

function req() {
  return new Request('http://localhost/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'gdrive' }),
  })
}

describe('POST poll', () => {
  it('forwards a pending status without writing the connection', async () => {
    oauth.pollDeviceToken.mockResolvedValueOnce({ status: 'pending' })
    const res = await POST(req(), {})
    expect((await res.json()).status).toBe('pending')
    expect(writes.some((w) => w.key === 'backups')).toBe(false)
  })

  it('on success, stores an encrypted refresh token + account email and clears pending', async () => {
    oauth.pollDeviceToken.mockResolvedValueOnce({
      status: 'success',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresInSec: 3599,
    })
    const res = await POST(req(), {})
    const json = await res.json()
    expect(json.status).toBe('success')
    expect(json.accountEmail).toBe('owner@example.com')
    // backups got the connection; the refresh token is an encrypted envelope, not plaintext.
    const w = writes.find((x) => x.key === 'backups')!.result as {
      gdrive: { connected: boolean; refreshToken: { alg: string }; accountEmail: string }
    }
    expect(w.gdrive.connected).toBe(true)
    expect(w.gdrive.refreshToken.alg).toBe('aes-256-gcm')
    expect(w.gdrive.accountEmail).toBe('owner@example.com')
    // pending cleared.
    expect((stateValue as { gdrivePending?: unknown }).gdrivePending).toBeUndefined()
  })

  it('returns expired when no pending block exists', async () => {
    stateValue = {}
    const res = await POST(req(), {})
    expect((await res.json()).status).toBe('expired')
  })
})
