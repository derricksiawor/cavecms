import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Import the SHIPPED installer/CLI binary directly. Its entry router is gated
// on invokedDirectly() (realpath argv[1] === realpath __filename), so importing
// it here runs no CLI — it only exposes the retry helpers under test.
const cliPath = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../packages/create-cavecms/bin/create-cavecms.mjs',
)
const { syncRequestRetry, isTransientStatus } = (await import(cliPath)) as {
  syncRequestRetry: (
    method: string,
    url: string,
    opts?: Record<string, unknown>,
    cfg?: { retries?: number; label?: string },
  ) => Promise<{ status: number; body: Buffer }>
  isTransientStatus: (status: number) => boolean
}

// Spin a throwaway http server whose handler is supplied per-test. The handler
// receives the running request count (1-based) so it can fail the first N
// attempts and succeed afterwards.
let server: http.Server | null = null
function startServer(
  handler: (count: number, res: http.ServerResponse, req: http.IncomingMessage) => void,
): Promise<string> {
  return new Promise((resolve) => {
    let count = 0
    server = http.createServer((req, res) => {
      count += 1
      handler(count, res, req)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve(`http://127.0.0.1:${port}`)
    })
  })
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }
})

describe('isTransientStatus', () => {
  it('treats 429 + 5xx as transient, everything else as terminal', () => {
    for (const s of [429, 500, 502, 503, 599]) expect(isTransientStatus(s)).toBe(true)
    for (const s of [200, 204, 301, 400, 401, 403, 404, 409, 413, 422]) expect(isTransientStatus(s)).toBe(false)
  })
})

describe('syncRequestRetry (against a real socket)', () => {
  it('retries through 503,503 then returns the 200', async () => {
    const url = await startServer((count, res) => {
      if (count <= 2) {
        res.statusCode = 503
        res.end('busy')
      } else {
        res.statusCode = 200
        res.end('ok')
      }
    })
    const r = await syncRequestRetry('GET', `${url}/x`, {}, { retries: 3 })
    expect(r.status).toBe(200)
    expect(r.body.toString('utf8')).toBe('ok')
  }, 15_000)

  it('retries through a dropped connection (network error) then succeeds', async () => {
    const url = await startServer((count, res) => {
      if (count === 1) {
        // Hard-kill the socket → client sees ECONNRESET → caught + retried.
        res.socket?.destroy()
      } else {
        res.statusCode = 200
        res.end('recovered')
      }
    })
    const r = await syncRequestRetry('GET', `${url}/x`, {}, { retries: 2 })
    expect(r.status).toBe(200)
    expect(r.body.toString('utf8')).toBe('recovered')
  }, 15_000)

  it('does NOT retry a 4xx — returns it immediately, one request only', async () => {
    let seen = 0
    const url = await startServer((count, res) => {
      seen = count
      res.statusCode = 422
      res.end('bad bundle')
    })
    const r = await syncRequestRetry('GET', `${url}/x`, {}, { retries: 3 })
    expect(r.status).toBe(422)
    expect(seen).toBe(1) // never re-requested
  }, 15_000)

  it('throws after exhausting retries on a persistent 500', async () => {
    let seen = 0
    const url = await startServer((count, res) => {
      seen = count
      res.statusCode = 500
      res.end('always down')
    })
    await expect(syncRequestRetry('GET', `${url}/x`, {}, { retries: 1 })).rejects.toThrow(/HTTP 500/)
    expect(seen).toBe(2) // initial attempt + 1 retry
  }, 15_000)
})
