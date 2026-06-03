import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encryptSecret, AAD_BACKUP_GDRIVE_REFRESH } from '@/lib/security/secretCipher'

const { ctx } = vi.hoisted(() => ({
  ctx: { userId: 7, jti: 'jti', role: 'admin' as const, email: 'a@b.c', oat: 0, iat: 0, pwp: false },
}))
vi.mock('@/lib/auth/requireRole', async (orig) => {
  const real = await (orig() as Promise<Record<string, unknown>>)
  return { ...real, requireRole: vi.fn().mockResolvedValue(ctx) }
})
vi.mock('@/lib/auth/requireCsrf', () => ({ requireCsrf: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/auth/cmsRateLimit', () => ({ checkMutationRate: vi.fn() }))
const oauth = vi.hoisted(() => ({ revokeToken: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/backups/cloud/oauthClient', () => oauth)

let backupsValue: Record<string, unknown> = {}
vi.mock('@/lib/cms/getSettings', () => ({ getSetting: vi.fn(async () => backupsValue) }))
const writes: Array<{ result: Record<string, unknown> }> = []
vi.mock('@/lib/cms/writeSetting', () => ({
  updateSettingValue: vi.fn(async (_k: string, mutate: (c: unknown) => unknown) => {
    const result = mutate(backupsValue) as Record<string, unknown>
    backupsValue = result
    writes.push({ result })
    return result
  }),
}))
vi.mock('@/lib/api/auditMeta', () => ({ auditMetaFromRequest: () => ({ ip: '1', userAgent: 'x', requestId: 'r' }) }))
vi.mock('@/db/client', () => ({ db: { insert: () => ({ values: async () => undefined }) } }))
vi.mock('@/db/schema', () => ({ auditLog: {} }))

import { POST } from '@/app/api/admin/backups/destinations/disconnect/route'

function freshState(): Record<string, unknown> {
  return {
    destination: 'gdrive',
    gdrive: { connected: true, accountEmail: 'o@e.com', refreshToken: encryptSecret('rt', AAD_BACKUP_GDRIVE_REFRESH) },
    onedrive: { connected: false },
  }
}

beforeEach(() => {
  writes.length = 0
  oauth.revokeToken.mockClear()
  backupsValue = freshState()
})

function req() {
  return new Request('http://localhost/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'gdrive' }),
  })
}

describe('POST disconnect', () => {
  it('revokes, wipes the connection, and resets destination to local if it pointed at the removed provider', async () => {
    const res = await POST(req(), {})
    expect(res.status).toBe(200)
    expect(oauth.revokeToken).toHaveBeenCalledTimes(1)
    const result = writes[0]!.result as { gdrive: { connected: boolean }; destination: string }
    expect(result.gdrive.connected).toBe(false)
    expect(result.gdrive).not.toHaveProperty('refreshToken')
    expect(result.destination).toBe('local')
  })
})
