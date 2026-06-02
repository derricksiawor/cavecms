import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// checkLatestRelease shells out to `wget` (NOT fetch) — Cloudflare Bot Fight
// Mode 403s undici/curl by TLS fingerprint from datacenter IPs, so the impl
// uses wget via `promisify(execFile)`. These tests therefore mock
// `node:child_process` execFile (the real seam), not globalThis.fetch.
//
// The mock follows execFile's callback convention so `promisify(execFile)`
// resolves `{ stdout, stderr }` on success and rejects the error on failure
// (mirroring how wget surfaces HTTP status on stderr + a non-zero exit).
type WgetResult = { stdout?: string; stderr?: string; error?: unknown }
const { wget } = vi.hoisted(() => ({
  wget: {
    calls: [] as string[][],
    handler: (_cmd: string, _args: string[]): WgetResult => ({ stdout: '', stderr: '' }),
  },
}))

vi.mock('node:child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, res?: { stdout: string; stderr: string }) => void,
  ) => {
    wget.calls.push(args)
    const r = wget.handler(cmd, args) as {
      stdout?: string
      stderr?: string
      error?: unknown
    }
    if (r.error) cb(r.error)
    else cb(null, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' })
  },
}))

import {
  checkLatestRelease,
  __resetCacheForTests,
} from '@/lib/updates/checkLatestRelease'

const SHA = 'deadbeefcafe1234567890abcdef0123456789ab'
const ZIP_SHA256 = '13211fde39e965e6d6152f2f3fb662fa47d21520d79e87a4e5fc0856c00b19bc'

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'stable',
    version: '0.1.0',
    sha: SHA,
    publishedAt: '2026-05-24T12:00:00Z',
    downloadUrl: 'https://updates.cavecms.com/releases/cavecms-0.1.0.zip',
    sha256: ZIP_SHA256,
    signature: null,
    isSecurity: false,
    minPreviousVersion: null,
    changelog: '## 0.1.0\n\nFirst public release of CaveCMS.',
    ...overrides,
  }
}

// wget returns the manifest JSON on stdout (HTTP 200 success).
function wgetReturns(body: unknown) {
  wget.handler = () => ({ stdout: JSON.stringify(body), stderr: '' })
}

// wget exits non-zero; `stderr` carries wget's `--server-response` status line
// (and/or `code`/`killed`), exactly as the impl's catch branch inspects.
function wgetFails(error: Record<string, unknown>) {
  wget.handler = () => ({
    error: Object.assign(new Error(String(error.message ?? 'wget failed')), error),
  })
}

describe('checkLatestRelease (static manifest via wget)', () => {
  beforeEach(() => {
    __resetCacheForTests()
    wget.calls = []
    // Pin the manifest URL so tests don't depend on the host's .env.local.
    process.env.CAVECMS_RELEASE_MANIFEST_URL = 'https://updates.cavecms.com/updates/latest.json'
  })
  afterEach(() => {
    delete process.env.CAVECMS_RELEASE_MANIFEST_URL
    vi.restoreAllMocks()
  })

  it('fetches the static manifest and returns the canonical shape', async () => {
    wgetReturns(manifest())

    const r = await checkLatestRelease()
    expect(r.sha).toBe(SHA)
    expect(r.ts).toBe('2026-05-24T12:00:00Z')
    expect(r.version).toBe('0.1.0')
    expect(r.downloadUrl).toBe('https://updates.cavecms.com/releases/cavecms-0.1.0.zip')
    expect(r.sha256).toBe(ZIP_SHA256)
    expect(r.minPreviousVersion).toBeNull()
    expect(r.changelog).toContain('First public release')
    expect(r.isSecurity).toBe(false)
    // wget called exactly once, with the manifest URL as the final arg.
    expect(wget.calls).toHaveLength(1)
    expect(wget.calls[0]!.at(-1)).toBe('https://updates.cavecms.com/updates/latest.json')
  })

  it('honours isSecurity=true from the manifest (no heuristic)', async () => {
    wgetReturns(manifest({ isSecurity: true, changelog: 'patches: routine cleanup' }))
    const r = await checkLatestRelease()
    expect(r.isSecurity).toBe(true)
  })

  it('returns isSecurity=false even when changelog mentions CVE (publisher-controlled)', async () => {
    wgetReturns(manifest({ isSecurity: false, changelog: 'fix: mentions CVE-2026-0001 in passing' }))
    const r = await checkLatestRelease()
    expect(r.isSecurity).toBe(false)
  })

  it('caches within the TTL (single wget across N calls)', async () => {
    wgetReturns(manifest())
    await checkLatestRelease()
    await checkLatestRelease()
    await checkLatestRelease()
    expect(wget.calls).toHaveLength(1)
  })

  it('back-compat: accepts ignored owner/repo args (caller signature parity)', async () => {
    wgetReturns(manifest())
    const r = await checkLatestRelease({ owner: 'whatever', repo: 'ignored' })
    expect(r.sha).toBe(SHA)
    // URL must not be assembled from owner/repo — it's the static manifest URL.
    const url = wget.calls[0]!.at(-1)!
    expect(url).not.toContain('whatever')
    expect(url).not.toContain('ignored')
  })

  it('respects CAVECMS_RELEASE_MANIFEST_URL override for forks', async () => {
    process.env.CAVECMS_RELEASE_MANIFEST_URL = 'https://forked.example.com/updates/latest.json'
    wgetReturns(manifest({ downloadUrl: 'https://forked.example.com/releases/cavecms-0.1.0.zip' }))
    const r = await checkLatestRelease()
    expect(r.downloadUrl).toBe('https://forked.example.com/releases/cavecms-0.1.0.zip')
    expect(wget.calls[0]!.at(-1)).toBe('https://forked.example.com/updates/latest.json')
  })

  it('throws manifest_not_found on 404', async () => {
    wgetFails({ stderr: '  HTTP/1.1 404 Not Found' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_not_found/)
  })

  it('throws manifest_http_500 on upstream 500', async () => {
    wgetFails({ stderr: '  HTTP/1.1 500 Internal Server Error' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_http_500/)
  })

  it('throws manifest_unreachable when wget is missing (ENOENT)', async () => {
    wgetFails({ code: 'ENOENT', message: 'spawn wget ENOENT' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_unreachable/)
  })

  it('throws manifest_unreachable when wget times out', async () => {
    wgetFails({ killed: true, message: 'timed out' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_unreachable/)
  })

  it('throws manifest_unreachable on a generic network failure', async () => {
    wgetFails({ message: 'connection reset' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_unreachable/)
  })

  it('throws manifest_malformed_json when body is not JSON', async () => {
    wget.handler = () => ({ stdout: 'this is not json {{{', stderr: '' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_malformed_json/)
  })

  it('throws manifest_invalid_schema when required fields are missing', async () => {
    wget.handler = () => ({ stdout: JSON.stringify({ channel: 'stable', version: '0.1.0' }), stderr: '' })
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_invalid_schema/)
  })

  it('throws manifest_invalid_schema when sha256 is not 64 hex chars', async () => {
    wgetReturns(manifest({ sha256: 'not-hex' }))
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_invalid_schema: sha256/)
  })

  it('throws manifest_cross_origin_download when downloadUrl is on a different origin', async () => {
    wgetReturns(manifest({ downloadUrl: 'https://attacker.example.com/evil.zip' }))
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_cross_origin_download/)
  })

  it('throws manifest_invalid_schema when downloadUrl is not https (Zod rejects before URL parse)', async () => {
    wgetReturns(manifest({ downloadUrl: 'not-a-url' }))
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_invalid_schema/)
  })

  it('rejects an over-long changelog (Zod max length)', async () => {
    const big = 'x'.repeat(100_000)
    wgetReturns(manifest({ changelog: big }))
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_invalid_schema: changelog/)
  })
})
