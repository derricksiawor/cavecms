import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gdrive from '../../../scripts/backup/cloud/gdrive.mjs'
import * as onedrive from '../../../scripts/backup/cloud/onedrive.mjs'
import {
  makeTokenProvider,
  fetchRetry,
  clearAccessTokenCache,
} from '../../../scripts/backup/cloud/destination.mjs'

type MockRes = { status: number; headers?: Record<string, string>; json?: unknown }
function res({ status, headers, json }: MockRes) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (headers ?? {})[k.toLowerCase()] ?? null },
    json: async () => json ?? {},
  }
}

let dir: string
const calls: Array<{ url: string; opts: { method?: string; headers?: Record<string, string>; body?: unknown } }> = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cavecms-prov-'))
  calls.length = 0
  vi.stubEnv('CAVECMS_CLOUD_CHUNK_BYTES', '16')
  // The access-token cache is process-global module state — reset it between
  // tests so one test's cached token can't satisfy another's refresh assertion.
  clearAccessTokenCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function queueFetch(responses: ReturnType<typeof res>[]) {
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, opts: Record<string, unknown> = {}) => {
      calls.push({ url, opts: opts as never })
      return responses[i++]
    }),
  )
}

const stubToken = { token: { getAccessToken: async () => 'AT' }, folderId: 'FOLDER' }

describe('gdrive.upload — multi-chunk resumable with 308 resume', () => {
  it('PUTs each 16-byte chunk with the right Content-Range and returns the file id', async () => {
    const file = join(dir, 'a.tar.gz')
    writeFileSync(file, Buffer.alloc(40, 7)) // 40 bytes → chunks 16,16,8
    queueFetch([
      res({ status: 200, headers: { location: 'https://session/uri' } }), // init
      res({ status: 308, headers: { range: 'bytes=0-15' } }), // chunk0
      res({ status: 308, headers: { range: 'bytes=0-31' } }), // chunk1
      res({ status: 200, json: { id: 'FILEID' } }), // chunk2 final
    ])
    const r = await gdrive.upload(stubToken, file, 'a.tar.gz')
    expect(r.remoteId).toBe('FILEID')
    const puts = calls.filter((c) => c.opts.method === 'PUT')
    expect(puts).toHaveLength(3)
    expect(puts[0]!.opts.headers!['content-range']).toBe('bytes 0-15/40')
    expect(puts[1]!.opts.headers!['content-range']).toBe('bytes 16-31/40')
    expect(puts[2]!.opts.headers!['content-range']).toBe('bytes 32-39/40')
  })

  it('stamps opts.appProperties onto the resumable session init body', async () => {
    const file = join(dir, 'm.tar.gz')
    writeFileSync(file, Buffer.alloc(8, 1)) // single-chunk
    queueFetch([
      res({ status: 200, headers: { location: 'https://session/uri' } }), // init
      res({ status: 200, json: { id: 'FID' } }), // final PUT
    ])
    await gdrive.upload(stubToken, file, 'm.tar.gz', undefined, {
      appProperties: { cavecmsVersion: '0.1.81', cavecmsEncrypted: '1' },
    })
    const init = calls.find((c) => c.opts.method === 'POST')!
    const body = JSON.parse(init.opts.body as string)
    expect(body.name).toBe('m.tar.gz')
    expect(body.appProperties).toEqual({ cavecmsVersion: '0.1.81', cavecmsEncrypted: '1' })
  })
})

describe('onedrive.upload — createUploadSession + nextExpectedRanges', () => {
  it('advances by nextExpectedRanges and returns the item id', async () => {
    const file = join(dir, 'b.tar.gz')
    writeFileSync(file, Buffer.alloc(40, 9))
    queueFetch([
      res({ status: 200, json: { uploadUrl: 'https://up/session' } }), // createSession
      res({ status: 202, json: { nextExpectedRanges: ['16-39'] } }),
      res({ status: 202, json: { nextExpectedRanges: ['32-39'] } }),
      res({ status: 201, json: { id: 'ITEM' } }),
    ])
    const r = await onedrive.upload({ token: { getAccessToken: async () => 'AT' } }, file, 'b.tar.gz')
    expect(r.remoteId).toBe('ITEM')
    const puts = calls.filter((c) => c.opts.method === 'PUT')
    expect(puts).toHaveLength(3)
    // No Authorization header on the upload-URL PUTs.
    expect(puts[0]!.opts.headers!['authorization']).toBeUndefined()
    expect(puts[0]!.opts.headers!['content-range']).toBe('bytes 0-15/40')
  })

  it('restarts the session once on a 404 then succeeds', async () => {
    const file = join(dir, 'c.tar.gz')
    writeFileSync(file, Buffer.alloc(20, 1)) // 16 + 4
    queueFetch([
      res({ status: 200, json: { uploadUrl: 'https://up/1' } }), // session 1
      res({ status: 404 }), // chunk0 → session expired
      res({ status: 200, json: { uploadUrl: 'https://up/2' } }), // session 2 (restart)
      res({ status: 202, json: { nextExpectedRanges: ['16-19'] } }),
      res({ status: 201, json: { id: 'ITEM2' } }),
    ])
    const r = await onedrive.upload({ token: { getAccessToken: async () => 'AT' } }, file, 'c.tar.gz')
    expect(r.remoteId).toBe('ITEM2')
  })
})

describe('gdrive.list', () => {
  it('maps Drive files to the common shape', async () => {
    queueFetch([res({ status: 200, json: { files: [{ id: 'x', name: 'n.tar.gz', size: '123', createdTime: 'T' }] } })])
    const out = await gdrive.list(stubToken)
    expect(out).toEqual([{ remoteId: 'x', name: 'n.tar.gz', sizeBytes: 123, createdAt: 'T' }])
  })

  it('parses appProperties into entry.meta (the list fast-path); absent → no meta', async () => {
    queueFetch([
      res({
        status: 200,
        json: {
          files: [
            {
              id: 'a',
              name: 'a.tar.gz',
              size: '10',
              createdTime: 'T1',
              appProperties: {
                cavecmsVersion: '0.1.81',
                cavecmsCreatedAt: 'C1',
                cavecmsEncrypted: '1',
                cavecmsIncludeEnv: '0',
                cavecmsMigratorEncoding: 'drizzle-hash',
              },
            },
            { id: 'b', name: 'b.tar.gz', size: '20', createdTime: 'T2' }, // no appProperties
          ],
        },
      }),
    ])
    const out = await gdrive.list(stubToken)
    expect(out[0]!.meta).toEqual({
      version: '0.1.81',
      createdAt: 'C1',
      encrypted: true,
      includeEnv: false,
      migratorEncoding: 'drizzle-hash',
    })
    expect(out[1]!.meta).toBeUndefined()
    // The list query must actually request the appProperties field.
    expect(calls[0]!.url).toContain('appProperties')
  })

  it('follows nextPageToken to return ALL files across pages', async () => {
    queueFetch([
      res({ status: 200, json: { nextPageToken: 'PG2', files: [{ id: 'a', name: 'a.tar.gz', createdTime: 'T1' }] } }),
      res({ status: 200, json: { files: [{ id: 'b', name: 'b.tar.gz', createdTime: 'T2' }] } }),
    ])
    const out = await gdrive.list(stubToken)
    expect(out.map((e) => e.remoteId)).toEqual(['a', 'b'])
    // Second request carried the pageToken.
    expect(calls[1]!.url).toContain('pageToken=PG2')
  })
})

describe('onedrive.list', () => {
  it('follows @odata.nextLink to return ALL items across pages', async () => {
    queueFetch([
      res({ status: 200, json: { '@odata.nextLink': 'https://graph/next', value: [{ id: 'a', name: 'a.tar.gz' }] } }),
      res({ status: 200, json: { value: [{ id: 'b', name: 'b.tar.gz' }] } }),
    ])
    const out = await onedrive.list({ token: { getAccessToken: async () => 'AT' } })
    expect(out.map((e) => e.remoteId)).toEqual(['a', 'b'])
    expect(calls[1]!.url).toBe('https://graph/next')
  })
})

describe('makeTokenProvider', () => {
  it('caches the access token and reports a rotated refresh token via onRotate', async () => {
    const rotated: string[] = []
    queueFetch([
      res({ status: 200, json: { access_token: 'AT1', refresh_token: 'RT2', expires_in: 3600 } }),
    ])
    const tp = makeTokenProvider({
      provider: 'onedrive',
      clientId: 'cid',
      refreshToken: 'RT1',
      onRotate: (rt: string) => rotated.push(rt),
    })
    expect(await tp.getAccessToken()).toBe('AT1')
    expect(rotated).toEqual(['RT2'])
    // Second call within expiry → cached, no new fetch.
    expect(await tp.getAccessToken()).toBe('AT1')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(tp.getRefreshToken()).toBe('RT2')
  })

  it('reuses a cached token across SEPARATE provider instances; clearAccessTokenCache forces a refresh', async () => {
    queueFetch([
      res({ status: 200, json: { access_token: 'AT-A', refresh_token: 'RTb', expires_in: 3600 } }),
      res({ status: 200, json: { access_token: 'AT-B', refresh_token: 'RTc', expires_in: 3600 } }),
    ])
    const a = makeTokenProvider({ provider: 'gdrive', clientId: 'cid', refreshToken: 'RTa' })
    expect(await a.getAccessToken()).toBe('AT-A')
    // A brand-new instance for the same provider (what createDestination builds
    // per request) reuses the cached token — NO second refresh round-trip.
    const b = makeTokenProvider({ provider: 'gdrive', clientId: 'cid', refreshToken: 'RTa' })
    expect(await b.getAccessToken()).toBe('AT-A')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    // Clearing the cache (disconnect/connect) forces the next call to refresh.
    clearAccessTokenCache('gdrive')
    const c = makeTokenProvider({ provider: 'gdrive', clientId: 'cid', refreshToken: 'RTb' })
    expect(await c.getAccessToken()).toBe('AT-B')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('de-dupes concurrent refresh misses into a single token fetch', async () => {
    queueFetch([res({ status: 200, json: { access_token: 'AT1', refresh_token: 'RT2', expires_in: 3600 } })])
    const a = makeTokenProvider({ provider: 'onedrive', clientId: 'cid', refreshToken: 'RT1' })
    const b = makeTokenProvider({ provider: 'onedrive', clientId: 'cid', refreshToken: 'RT1' })
    // Two instances refresh at the same time → one shared fetch, not two racing
    // refreshes with the same (rotating) refresh token.
    const [ta, tb] = await Promise.all([a.getAccessToken(), b.getAccessToken()])
    expect(ta).toBe('AT1')
    expect(tb).toBe('AT1')
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })
})

describe('fetchRetry', () => {
  it('retries on a 500 then returns the 200', async () => {
    queueFetch([res({ status: 500 }), res({ status: 200, json: { ok: true } })])
    const r = await fetchRetry('https://x', {}, { attempts: 3 })
    expect(r.status).toBe(200)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })
})
