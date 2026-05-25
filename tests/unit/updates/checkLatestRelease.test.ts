import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkLatestRelease,
  __resetCacheForTests,
} from '@/lib/updates/checkLatestRelease'

const ORIG_FETCH = globalThis.fetch

function mockCommit(sha: string, date: string, message: string) {
  return {
    sha,
    commit: {
      committer: { date, name: 'a', email: 'a@b' },
      author: { date, name: 'a', email: 'a@b' },
      message,
    },
  }
}

describe('checkLatestRelease', () => {
  beforeEach(() => {
    __resetCacheForTests()
  })
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH
    vi.restoreAllMocks()
  })

  it('fetches GitHub commits/main and returns shape', async () => {
    const mock = vi.fn(async () =>
      new Response(
        JSON.stringify(
          mockCommit(
            'deadbeefcafe1234567890abcdef0123456789ab',
            '2026-05-24T12:00:00Z',
            'feat: add updates feature',
          ),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    globalThis.fetch = mock as unknown as typeof fetch

    const r = await checkLatestRelease({ owner: 'derricksiawor', repo: 'cavecms' })
    expect(r.sha).toBe('deadbeefcafe1234567890abcdef0123456789ab')
    expect(r.ts).toBe('2026-05-24T12:00:00Z')
    expect(r.changelog).toContain('updates feature')
    expect(r.isSecurity).toBe(false)
    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0] as unknown as [string, RequestInit]
    const [url] = call
    expect(String(url)).toContain('api.github.com/repos/derricksiawor/cavecms/commits/main')
  })

  it('flags security commits via heuristic', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify(mockCommit('aa', '2026-05-24T00:00:00Z', 'fix: CVE-2026-0001 in auth')),
        { status: 200 },
      ),
    ) as unknown as typeof fetch

    const r = await checkLatestRelease({ owner: 'x', repo: 'y' })
    expect(r.isSecurity).toBe(true)
  })

  it('caches within 5 minute TTL (single fetch)', async () => {
    const mock = vi.fn(async () =>
      new Response(
        JSON.stringify(mockCommit('bb', '2026-05-24T00:00:00Z', 'docs: readme')),
        { status: 200 },
      ),
    )
    globalThis.fetch = mock as unknown as typeof fetch
    await checkLatestRelease({ owner: 'x', repo: 'y' })
    await checkLatestRelease({ owner: 'x', repo: 'y' })
    await checkLatestRelease({ owner: 'x', repo: 'y' })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('throws on non-200 GitHub response', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('rate limited', { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      checkLatestRelease({ owner: 'x', repo: 'y' }),
    ).rejects.toThrow(/github/i)
  })

  it('sends Authorization header when GITHUB_PAT env set', async () => {
    process.env.GITHUB_PAT = 'ghp_testtoken'
    const mock = vi.fn(async () =>
      new Response(JSON.stringify(mockCommit('cc', '2026-05-24T00:00:00Z', 'a')), {
        status: 200,
      }),
    )
    globalThis.fetch = mock as unknown as typeof fetch
    try {
      await checkLatestRelease({ owner: 'x', repo: 'y' })
      const call = mock.mock.calls[0] as unknown as [string, RequestInit]
      const init = call[1]
      const headers = init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer ghp_testtoken')
    } finally {
      delete process.env.GITHUB_PAT
    }
  })
})
