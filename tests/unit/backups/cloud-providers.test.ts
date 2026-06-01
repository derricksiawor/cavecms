import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gdrive from '../../../scripts/backup/cloud/gdrive.mjs'
import * as onedrive from '../../../scripts/backup/cloud/onedrive.mjs'
import { makeTokenProvider, fetchRetry } from '../../../scripts/backup/cloud/destination.mjs'

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
})

describe('fetchRetry', () => {
  it('retries on a 500 then returns the 200', async () => {
    queueFetch([res({ status: 500 }), res({ status: 200, json: { ok: true } })])
    const r = await fetchRetry('https://x', {}, { attempts: 3 })
    expect(r.status).toBe(200)
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })
})
