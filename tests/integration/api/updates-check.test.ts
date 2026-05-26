import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Auth-gate mocks. We preserve the REAL HttpError class so withError's
// `instanceof HttpError` check still works — replacing it with a vi.fn
// would silently break the 401/403/409 paths in the route under test.
vi.mock('@/lib/auth/requireRole', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/requireRole')>(
    '@/lib/auth/requireRole',
  )
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: 9501,
      role: 'admin',
      email: 'check-test@local',
      jti: 'jti-check',
      oat: 0,
      iat: 0,
      pwp: false,
    })),
  }
})

vi.mock('@/lib/auth/requireCsrf', () => ({
  requireCsrf: vi.fn(async () => undefined),
}))

vi.mock('@/lib/auth/cmsRateLimit', () => ({
  checkMutationRate: vi.fn(() => undefined),
  checkReadRate: vi.fn(() => undefined),
}))

// `next/headers` is referenced transitively by some imports under
// app/api/* even when the route itself doesn't read cookies/headers
// directly. A minimal mock keeps the import graph happy.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}))

import { __resetCacheForTests } from '@/lib/updates/checkLatestRelease'

const ORIG_FETCH = globalThis.fetch
const ORIG_COMMIT = process.env.CAVECMS_COMMIT

function mockGithubResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

describe('POST /api/admin/updates/check (integration)', () => {
  beforeEach(() => {
    __resetCacheForTests()
    // Production-shaped commit so getCurrentVersion() doesn't return
    // 'dev' (which would otherwise force `available` to always be set
    // and the "up to date" assertion couldn't run).
    process.env.CAVECMS_COMMIT = 'abcdef1'
    process.env.CAVECMS_RELEASE_TS = '2026-05-20T00:00:00.000Z'
  })
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH
    process.env.CAVECMS_COMMIT = ORIG_COMMIT
    delete process.env.CAVECMS_RELEASE_TS
    vi.clearAllMocks()
  })

  it('returns current + available shape when a newer SHA exists upstream', async () => {
    globalThis.fetch = mockGithubResponse({
      sha: '9999999999999999999999999999999999999999',
      commit: {
        committer: { date: '2026-05-25T12:00:00Z' },
        message: 'feat: new release',
      },
    })

    const { POST } = await import('@/app/api/admin/updates/check/route')
    const req = new Request('http://127.0.0.1:3040/api/admin/updates/check', {
      method: 'POST',
    })
    const res = await POST(req, {})

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      current: { sha: string }
      available: { sha: string; isSecurity: boolean } | null
    }
    expect(body.current.sha).toBe('abcdef1')
    expect(body.available).not.toBeNull()
    expect(body.available?.sha.startsWith('9999999')).toBe(true)
  })

  it('returns available: null when upstream HEAD matches the current SHA prefix', async () => {
    globalThis.fetch = mockGithubResponse({
      sha: 'abcdef1234567890abcdef1234567890abcdef12',
      commit: {
        committer: { date: '2026-05-20T00:00:00Z' },
        message: 'chore: same release',
      },
    })

    const { POST } = await import('@/app/api/admin/updates/check/route')
    const res = await POST(
      new Request('http://127.0.0.1:3040/api/admin/updates/check', {
        method: 'POST',
      }),
      {},
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { available: unknown | null }
    expect(body.available).toBeNull()
  })

  it('flags isSecurity when the changelog mentions security/CVE', async () => {
    globalThis.fetch = mockGithubResponse({
      sha: '1111111111111111111111111111111111111111',
      commit: {
        committer: { date: '2026-05-25T12:00:00Z' },
        message: 'fix: CVE-2026-0001 path traversal in admin uploader',
      },
    })

    const { POST } = await import('@/app/api/admin/updates/check/route')
    const res = await POST(
      new Request('http://127.0.0.1:3040/api/admin/updates/check', {
        method: 'POST',
      }),
      {},
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      available: { isSecurity: boolean } | null
    }
    expect(body.available?.isSecurity).toBe(true)
  })

  it('returns 502 when the GitHub API responds with a 5xx', async () => {
    globalThis.fetch = mockGithubResponse({ message: 'upstream down' }, 503)

    const { POST } = await import('@/app/api/admin/updates/check/route')
    const res = await POST(
      new Request('http://127.0.0.1:3040/api/admin/updates/check', {
        method: 'POST',
      }),
      {},
    )

    expect(res.status).toBe(502)
  })
})
