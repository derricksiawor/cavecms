import { describe, it, expect, vi } from 'vitest'
import {
  submitUrls,
  chunk,
  dedupeUrls,
  MAX_URLS_PER_POST,
  type SubmitArgs,
  type Engine,
} from '@/lib/seo/indexnow/submit'
import { ENDPOINTS } from '@/lib/seo/indexnow/key'

const HOST = 'example.com'
const KEY = 'a'.repeat(32) // valid 32-char key
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`

/** Build a mock fetch that returns the given status for every call. */
function mockFetchStatus(status: number) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status }) as Response,
  )
}

function baseArgs(overrides: Partial<SubmitArgs> = {}): SubmitArgs {
  return {
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urls: [`https://${HOST}/a`, `https://${HOST}/b`],
    engines: ['indexnow'],
    fetchImpl: mockFetchStatus(200),
    ...overrides,
  }
}

describe('chunk', () => {
  it('splits into ceil(n/size) chunks at the 10000 boundary', () => {
    const urls = Array.from({ length: 25000 }, (_, i) => `https://${HOST}/${i}`)
    const chunks = chunk(urls, MAX_URLS_PER_POST)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(10000)
    expect(chunks[1]).toHaveLength(10000)
    expect(chunks[2]).toHaveLength(5000)
  })

  it('returns one full chunk at exactly the boundary', () => {
    const urls = Array.from({ length: 10000 }, (_, i) => `${i}`)
    expect(chunk(urls, MAX_URLS_PER_POST)).toHaveLength(1)
  })

  it('returns an empty array for empty input', () => {
    expect(chunk([], MAX_URLS_PER_POST)).toEqual([])
  })

  it('throws on a non-positive size', () => {
    expect(() => chunk([1, 2], 0)).toThrow(RangeError)
  })
})

describe('dedupeUrls', () => {
  it('removes duplicates preserving first-seen order', () => {
    expect(dedupeUrls(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })
})

describe('submitUrls — validation + reporting', () => {
  it('dedupes URLs before submitting', async () => {
    const fetchImpl = mockFetchStatus(200)
    const report = await submitUrls(
      baseArgs({
        urls: [`https://${HOST}/a`, `https://${HOST}/a`, `https://${HOST}/b`],
        fetchImpl,
      }),
    )
    expect(report.submitted).toBe(2)
    // Body sent should contain exactly the 2 unique urls.
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.urlList).toEqual([`https://${HOST}/a`, `https://${HOST}/b`])
  })

  it('skips + reports cross-host and non-absolute URLs, submits the rest', async () => {
    const fetchImpl = mockFetchStatus(200)
    const report = await submitUrls(
      baseArgs({
        urls: [
          `https://${HOST}/keep`,
          'https://evil.com/drop', // host-mismatch
          '/relative/path', // not absolute
          'not a url', // not absolute
        ],
        fetchImpl,
      }),
    )
    expect(report.submitted).toBe(1)
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { url: 'https://evil.com/drop', reason: 'host-mismatch' },
        { url: '/relative/path', reason: 'not-absolute-url' },
        { url: 'not a url', reason: 'not-absolute-url' },
      ]),
    )
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.urlList).toEqual([`https://${HOST}/keep`])
  })

  it('matches host case-insensitively', async () => {
    const report = await submitUrls(
      baseArgs({
        host: 'Example.com',
        urls: [`https://EXAMPLE.com/x`],
      }),
    )
    expect(report.submitted).toBe(1)
    expect(report.skipped).toHaveLength(0)
  })

  it('short-circuits with no requests on an empty URL list', async () => {
    const fetchImpl = mockFetchStatus(200)
    const report = await submitUrls(baseArgs({ urls: [], fetchImpl }))
    expect(report.submitted).toBe(0)
    expect(report.results).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('short-circuits when every URL is cross-host (nothing valid to send)', async () => {
    const fetchImpl = mockFetchStatus(200)
    const report = await submitUrls(
      baseArgs({ urls: ['https://other.com/a'], fetchImpl }),
    )
    expect(report.submitted).toBe(0)
    expect(report.results).toEqual([])
    expect(report.skipped).toEqual([{ url: 'https://other.com/a', reason: 'host-mismatch' }])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an invalid key without making any request', async () => {
    const fetchImpl = mockFetchStatus(200)
    const report = await submitUrls(
      baseArgs({ key: 'bad key!', fetchImpl }),
    )
    expect(report.submitted).toBe(0)
    expect(report.results).toEqual([])
    expect(report.skipped.every((s) => s.reason === 'invalid-key')).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('submitUrls — chunking POSTs', () => {
  it('POSTs one request per chunk per engine (25000 urls -> 3 chunks)', async () => {
    const fetchImpl = mockFetchStatus(200)
    const urls = Array.from({ length: 25000 }, (_, i) => `https://${HOST}/${i}`)
    const report = await submitUrls(
      baseArgs({ urls, engines: ['indexnow', 'bing'], fetchImpl }),
    )
    // 2 engines × 3 chunks = 6 POSTs
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expect(report.results).toHaveLength(6)
    expect(report.submitted).toBe(25000)

    // Each chunk index 0..2 appears for each engine.
    const indexnowChunks = report.results
      .filter((r) => r.engine === 'indexnow')
      .map((r) => r.chunk)
      .sort()
    expect(indexnowChunks).toEqual([0, 1, 2])
  })

  it('targets each engine`s correct /indexnow endpoint', async () => {
    const fetchImpl = mockFetchStatus(200)
    const engines: Engine[] = ['indexnow', 'bing', 'yandex', 'seznam', 'naver']
    await submitUrls(baseArgs({ engines, fetchImpl }))
    const calledUrls = fetchImpl.mock.calls.map((c) => c[0])
    for (const engine of engines) {
      expect(calledUrls).toContain(`https://${ENDPOINTS[engine]}/indexnow`)
    }
  })

  it('sends a well-formed POST body (host/key/keyLocation/urlList)', async () => {
    const fetchImpl = mockFetchStatus(200)
    await submitUrls(baseArgs({ urls: [`https://${HOST}/x`], fetchImpl }))
    const [, init] = fetchImpl.mock.calls[0]!
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({
      host: HOST,
      key: KEY,
      keyLocation: KEY_LOCATION,
      urlList: [`https://${HOST}/x`],
    })
  })
})

describe('submitUrls — status recording', () => {
  it.each([200, 202, 400, 403, 422, 429, 500])(
    'records HTTP status %i per engine',
    async (status) => {
      const report = await submitUrls(
        baseArgs({ fetchImpl: mockFetchStatus(status) }),
      )
      expect(report.results).toEqual([{ engine: 'indexnow', status, chunk: 0 }])
    },
  )

  it('records mixed statuses across engines', async () => {
    // indexnow -> 200, bing -> 429
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      const status = u.includes(ENDPOINTS.bing) ? 429 : 200
      return new Response(null, { status }) as Response
    })
    const report = await submitUrls(
      baseArgs({ engines: ['indexnow', 'bing'], fetchImpl }),
    )
    const byEngine = Object.fromEntries(report.results.map((r) => [r.engine, r.status]))
    expect(byEngine).toEqual({ indexnow: 200, bing: 429 })
  })
})

describe('submitUrls — resilience', () => {
  it('catches a network failure as status:error without rejecting', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    })
    const report = await submitUrls(baseArgs({ fetchImpl }))
    expect(report.results).toHaveLength(1)
    expect(report.results[0]!.status).toBe('error')
    expect(report.results[0]!.error).toBe('network down')
    // The call resolved (did not reject) and still reports submitted urls.
    expect(report.submitted).toBe(2)
  })

  it('isolates a failing engine — others still succeed', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(ENDPOINTS.bing)) {
        throw new Error('bing exploded')
      }
      return new Response(null, { status: 200 }) as Response
    })
    const report = await submitUrls(
      baseArgs({ engines: ['indexnow', 'bing'], fetchImpl }),
    )
    const indexnow = report.results.find((r) => r.engine === 'indexnow')!
    const bing = report.results.find((r) => r.engine === 'bing')!
    expect(indexnow.status).toBe(200)
    expect(bing.status).toBe('error')
    expect(bing.error).toBe('bing exploded')
  })

  it('aborts a hanging request via the per-request timeout', async () => {
    vi.useFakeTimers()
    try {
      // A fetch that only settles when its AbortSignal fires.
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            if (signal) {
              signal.addEventListener('abort', () => {
                const err = new Error('aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }
          }),
      ) as unknown as typeof fetch

      const promise = submitUrls(
        baseArgs({ fetchImpl, timeoutMs: 8000 }),
      )
      // Advance past the timeout so the AbortController fires.
      await vi.advanceTimersByTimeAsync(8000)
      const report = await promise
      expect(report.results).toHaveLength(1)
      expect(report.results[0]!.status).toBe('error')
      expect(report.results[0]!.error).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
