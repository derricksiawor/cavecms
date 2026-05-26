import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@/lib/auth/requireRole', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/requireRole')>(
    '@/lib/auth/requireRole',
  )
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: 9601,
      role: 'admin',
      email: 'status-test@local',
      jti: 'jti-status',
      oat: 0,
      iat: 0,
      pwp: false,
    })),
  }
})

vi.mock('@/lib/auth/cmsRateLimit', () => ({
  checkMutationRate: vi.fn(() => undefined),
  checkReadRate: vi.fn(() => undefined),
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}))

import { __setStatusPathForTests } from '@/lib/updates/statusFile'

let tmpDir: string
let statusPath: string

describe('GET /api/admin/updates/status (integration)', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cavecms-status-'))
    statusPath = join(tmpDir, 'update-status.json')
    __setStatusPathForTests(statusPath)
  })
  afterEach(() => {
    __setStatusPathForTests(null)
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* tmpdir cleanup is best-effort */
    }
    vi.clearAllMocks()
  })

  it('returns idle when the status file does not exist', async () => {
    const { GET } = await import('@/app/api/admin/updates/status/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/status')
    const res = await GET(req, {})

    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('idle')
  })

  it('passes the live status through when in-progress and fresh', async () => {
    const now = new Date().toISOString()
    writeFileSync(
      statusPath,
      JSON.stringify({
        state: 'updating',
        step: 3,
        totalSteps: 6,
        startedAt: now,
        updatedAt: now,
        fromSha: 'abc1234',
        toSha: 'def5678',
        stepLabel: 'Preparing your data',
      }),
    )

    const { GET } = await import('@/app/api/admin/updates/status/route')
    const res = await GET(
      new Request('http://127.0.0.1:3040/api/admin/updates/status'),
      {},
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      state: string
      step: number
      fromSha: string
      toSha: string
    }
    expect(body.state).toBe('updating')
    expect(body.step).toBe(3)
    expect(body.fromSha).toBe('abc1234')
  })

  it('synthesises a failed state when in-progress is older than 15 minutes', async () => {
    const longAgo = new Date(Date.now() - 20 * 60_000).toISOString()
    writeFileSync(
      statusPath,
      JSON.stringify({
        state: 'updating',
        step: 4,
        totalSteps: 6,
        startedAt: longAgo,
        updatedAt: longAgo,
        fromSha: 'abc1234',
        toSha: 'def5678',
        stepLabel: 'Building your site',
      }),
    )

    const { GET } = await import('@/app/api/admin/updates/status/route')
    const res = await GET(
      new Request('http://127.0.0.1:3040/api/admin/updates/status'),
      {},
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('failed')
  })

  it('synthesises idle when a terminal state is older than 24h', async () => {
    const longAgo = new Date(Date.now() - 25 * 3600_000).toISOString()
    writeFileSync(
      statusPath,
      JSON.stringify({
        state: 'completed',
        step: 6,
        totalSteps: 6,
        startedAt: longAgo,
        updatedAt: longAgo,
        fromSha: 'abc1234',
        toSha: 'def5678',
      }),
    )

    const { GET } = await import('@/app/api/admin/updates/status/route')
    const res = await GET(
      new Request('http://127.0.0.1:3040/api/admin/updates/status'),
      {},
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('idle')
  })

  it('preserves a recent terminal state (within 24h)', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString()
    writeFileSync(
      statusPath,
      JSON.stringify({
        state: 'completed',
        step: 6,
        totalSteps: 6,
        startedAt: recent,
        updatedAt: recent,
        fromSha: 'abc1234',
        toSha: 'def5678',
      }),
    )

    const { GET } = await import('@/app/api/admin/updates/status/route')
    const res = await GET(
      new Request('http://127.0.0.1:3040/api/admin/updates/status'),
      {},
    )
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('completed')

    // Cleanup so the file doesn't leak between tests.
    try {
      unlinkSync(statusPath)
    } catch {
      /* tmpdir cleanup is best-effort */
    }
  })
})
