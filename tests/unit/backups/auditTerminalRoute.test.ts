import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock env so isLoopbackInternalRequest has a known secret. The factory is
// hoisted above module-scope consts, so the literal must be inline here.
vi.mock('@/lib/env', () => ({ env: { INTERNAL_REVALIDATE_SECRET: 'x'.repeat(40) } }))
const SECRET = 'x'.repeat(40)

// Capture the audit insert without a live DB.
const valuesMock = vi.fn(async (_row: Record<string, unknown>) => undefined)
vi.mock('@/db/client', () => ({ db: { insert: () => ({ values: valuesMock }) } }))
vi.mock('@/db/schema', () => ({ auditLog: {} }))

import { POST } from '@/app/api/internal/backups/audit-terminal/route'

function req(body: unknown, headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1/api/internal/backups/audit-terminal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
const auth = { host: '127.0.0.1', authorization: `Bearer ${SECRET}` }

beforeEach(() => {
  valuesMock.mockClear()
})

describe('internal backups audit-terminal', () => {
  it('401 without bearer', async () => {
    const res = await POST(req({ action: 'backup_completed', resourceId: 'a' }, { host: '127.0.0.1' }))
    expect(res.status).toBe(401)
    expect(valuesMock).not.toHaveBeenCalled()
  })
  it('401 from a non-loopback host', async () => {
    const res = await POST(req({ action: 'backup_completed', resourceId: 'a' }, { host: 'evil.com', authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(401)
  })
  it('400 on an unknown action', async () => {
    const res = await POST(req({ action: 'nope', resourceId: 'a' }, auth))
    expect(res.status).toBe(400)
    expect(valuesMock).not.toHaveBeenCalled()
  })
  it('200 + inserts resource_type=backups for restore_completed', async () => {
    const res = await POST(req({ action: 'restore_completed', resourceId: 'cavecms-backup-20260531-000000-abc', durationMs: 1234 }, auth))
    expect(res.status).toBe(200)
    expect(valuesMock).toHaveBeenCalledTimes(1)
    const row = valuesMock.mock.calls[0]![0]
    expect(row.resourceType).toBe('backups')
    expect(row.action).toBe('restore_completed')
    expect(row.userId).toBeNull()
    expect((row.diff as Record<string, unknown>).durationMs).toBe(1234)
  })
})
