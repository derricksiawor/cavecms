import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  checkLatestRelease,
  __resetCacheForTests,
} from '@/lib/updates/checkLatestRelease'

const ORIG_FETCH = globalThis.fetch

const SHA = 'deadbeefcafe1234567890abcdef0123456789ab'
const ZIP_SHA256 = '13211fde39e965e6d6152f2f3fb662fa47d21520d79e87a4e5fc0856c00b19bc'

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'stable',
    version: '0.1.0',
    sha: SHA,
    publishedAt: '2026-05-24T12:00:00Z',
    downloadUrl: 'https://cavecms.derricksiawor.com/releases/cavecms-0.1.0.zip',
    sha256: ZIP_SHA256,
    signature: null,
    isSecurity: false,
    minPreviousVersion: null,
    changelog: '## 0.1.0\n\nFirst public release of CaveCMS.',
    ...overrides,
  }
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('checkLatestRelease (static manifest)', () => {
  beforeEach(() => {
    __resetCacheForTests()
    // Pin the manifest URL so tests don't depend on whatever the operator
    // has in their .env.local for the assistant's dev box.
    process.env.CAVECMS_RELEASE_MANIFEST_URL = 'https://cavecms.derricksiawor.com/updates/latest.json'
  })
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH
    delete process.env.CAVECMS_RELEASE_MANIFEST_URL
    vi.restoreAllMocks()
  })

  it('fetches the static manifest and returns the canonical shape', async () => {
    const mock = vi.fn(async () => jsonResponse(manifest()))
    globalThis.fetch = mock as unknown as typeof fetch

    const r = await checkLatestRelease()
    expect(r.sha).toBe(SHA)
    expect(r.ts).toBe('2026-05-24T12:00:00Z')
    expect(r.version).toBe('0.1.0')
    expect(r.downloadUrl).toBe('https://cavecms.derricksiawor.com/releases/cavecms-0.1.0.zip')
    expect(r.sha256).toBe(ZIP_SHA256)
    expect(r.minPreviousVersion).toBeNull()
    expect(r.changelog).toContain('First public release')
    expect(r.isSecurity).toBe(false)
    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0] as unknown as [string]
    expect(String(call[0])).toBe('https://cavecms.derricksiawor.com/updates/latest.json')
  })

  it('honours isSecurity=true from the manifest (no heuristic)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(manifest({ isSecurity: true, changelog: 'patches: routine cleanup' })),
    ) as unknown as typeof fetch
    const r = await checkLatestRelease()
    expect(r.isSecurity).toBe(true)
  })

  it('returns isSecurity=false even when changelog mentions CVE (heuristic is now publisher-controlled)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(manifest({ isSecurity: false, changelog: 'fix: mentions CVE-2026-0001 in passing' })),
    ) as unknown as typeof fetch
    const r = await checkLatestRelease()
    expect(r.isSecurity).toBe(false)
  })

  it('caches within 5 minute TTL (single fetch across N calls)', async () => {
    const mock = vi.fn(async () => jsonResponse(manifest()))
    globalThis.fetch = mock as unknown as typeof fetch
    await checkLatestRelease()
    await checkLatestRelease()
    await checkLatestRelease()
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('back-compat: accepts ignored owner/repo args (caller signature parity)', async () => {
    const mock = vi.fn(async () => jsonResponse(manifest()))
    globalThis.fetch = mock as unknown as typeof fetch
    const r = await checkLatestRelease({ owner: 'whatever', repo: 'ignored' })
    expect(r.sha).toBe(SHA)
    // URL must not be assembled from owner/repo — it's the static manifest URL.
    const call = mock.mock.calls[0] as unknown as [string]
    expect(String(call[0])).not.toContain('whatever')
    expect(String(call[0])).not.toContain('ignored')
  })

  it('respects CAVECMS_RELEASE_MANIFEST_URL override for forks', async () => {
    process.env.CAVECMS_RELEASE_MANIFEST_URL = 'https://forked.example.com/updates/latest.json'
    const mock = vi.fn(async () => jsonResponse(manifest({
      downloadUrl: 'https://forked.example.com/releases/cavecms-0.1.0.zip',
    })))
    globalThis.fetch = mock as unknown as typeof fetch
    const r = await checkLatestRelease()
    expect(r.downloadUrl).toBe('https://forked.example.com/releases/cavecms-0.1.0.zip')
    const call = mock.mock.calls[0] as unknown as [string]
    expect(String(call[0])).toBe('https://forked.example.com/updates/latest.json')
  })

  it('throws manifest_not_found on 404', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('not found', { status: 404 }),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_not_found/)
  })

  it('throws manifest_http_500 on upstream 500', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_http_500/)
  })

  it('throws manifest_unreachable when the network call fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_unreachable/)
  })

  it('throws manifest_malformed_json when body is not JSON', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('this is not json {{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_malformed_json/)
  })

  it('throws manifest_malformed_fields when required fields are missing', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse({ channel: 'stable', version: '0.1.0' /* sha + others missing */ }),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_malformed_fields/)
  })

  it('throws manifest_invalid_sha256 when sha256 is not 64 hex chars', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse(manifest({ sha256: 'not-hex' })),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_invalid_sha256/)
  })

  it('throws manifest_cross_origin_download when downloadUrl is on a different origin', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse(manifest({
        downloadUrl: 'https://attacker.example.com/evil.zip',
      })),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_cross_origin_download/)
  })

  it('throws manifest_invalid_download_url when downloadUrl is not a valid URL', async () => {
    globalThis.fetch = vi.fn(
      async () => jsonResponse(manifest({ downloadUrl: 'not-a-url' })),
    ) as unknown as typeof fetch
    await expect(checkLatestRelease()).rejects.toThrow(/manifest_invalid_download_url/)
  })

  it('truncates a runaway changelog at the configured cap', async () => {
    const big = 'x'.repeat(100_000)
    globalThis.fetch = vi.fn(
      async () => jsonResponse(manifest({ changelog: big })),
    ) as unknown as typeof fetch
    const r = await checkLatestRelease()
    // RELEASE_CHANGELOG_MAX_BYTES is the cap (currently 8KiB-ish);
    // assertion just confirms truncation happened.
    expect(r.changelog.length).toBeLessThan(big.length)
  })
})
