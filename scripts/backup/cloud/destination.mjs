// Shared zero-dep helpers for cloud destinations: an access-token provider that
// refreshes autonomously mid-transfer (a multi-GB upload outlives a ~1h token),
// a fetch wrapper with exponential backoff on 5xx/429/network, a chunk reader,
// and the destination factory.
//
// CHUNK_BYTES = 10 MiB is a common multiple of Google's 256 KB and OneDrive's
// 320 KiB fragment requirements (and within OneDrive's <60 MiB/request cap),
// so one size satisfies both providers.

import { open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { refreshAccessToken } from './oauth.mjs'
import * as gdrive from './gdrive.mjs'
import * as onedrive from './onedrive.mjs'

export const CHUNK_BYTES = 10 * 1024 * 1024

// Resolved chunk size. CAVECMS_CLOUD_CHUNK_BYTES overrides the default (tests
// set a tiny value to exercise the multi-chunk resume paths without GB
// fixtures; never set in production).
export function chunkSize() {
  const o = Number(process.env.CAVECMS_CLOUD_CHUNK_BYTES)
  return Number.isFinite(o) && o > 0 ? o : CHUNK_BYTES
}

// Refresh the access token this many ms before it actually expires (clock skew).
const REFRESH_SKEW_MS = 5 * 60 * 1000

// Build a token provider. getAccessToken() caches the token and re-mints it
// when it's within REFRESH_SKEW_MS of expiry. onRotate is called with a new
// refresh token whenever the provider rotates it (Microsoft does, every time).
export function makeTokenProvider({ provider, clientId, clientSecret, refreshToken, onRotate }) {
  let access = null
  let expiresAtMs = 0
  let currentRefresh = refreshToken

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && access && Date.now() < expiresAtMs - REFRESH_SKEW_MS) {
      return access
    }
    const r = await refreshAccessToken({ provider, clientId, clientSecret, refreshToken: currentRefresh })
    access = r.accessToken
    expiresAtMs = Date.now() + r.expiresInSec * 1000
    if (r.refreshToken && r.refreshToken !== currentRefresh) {
      currentRefresh = r.refreshToken
      if (onRotate) onRotate(currentRefresh)
    }
    return access
  }

  return { getAccessToken, getRefreshToken: () => currentRefresh }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

// fetch with exponential backoff + a per-request timeout. Retries on network
// error, timeout, 429, and 5xx. `attempts` total tries (default 5). Backoff:
// 1s, 2s, 4s, 8s (+ small jitter from the attempt index, not Math.random which
// is unavailable). `timeoutMs` (default 120s) bounds EACH attempt via
// AbortSignal so a half-open socket can't wedge the engine forever; an abort is
// treated as a retryable network error.
export async function fetchRetry(url, opts = {}, { attempts = 5, timeoutMs = 120_000 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    // Compose the caller's signal (if any) with the per-attempt timeout.
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal
    try {
      const res = await fetch(url, { ...opts, signal })
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (i < attempts - 1) {
          await sleep(1000 * 2 ** i + i * 137)
          continue
        }
      }
      return res
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        await sleep(1000 * 2 ** i + i * 137)
        continue
      }
    }
  }
  if (lastErr) throw lastErr
  throw new Error('fetch_retry_exhausted')
}

// Streaming sha256 of a file (shared by cloud-push + cloud-pull; never loads a
// multi-GB archive into memory).
export function sha256FileStream(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('error', reject)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

// Read [start, start+len) from an open file handle into a Buffer (may return
// fewer bytes at EOF).
export async function readChunk(fh, start, len) {
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, start)
  return bytesRead === len ? buf : buf.subarray(0, bytesRead)
}

export async function withOpenFile(path, fn) {
  const fh = await open(path, 'r')
  try {
    return await fn(fh)
  } finally {
    await fh.close()
  }
}

const IMPLS = { gdrive, onedrive }

// Build a destination handle bound to a provider + auth context. Returns the
// provider module's functions partially applied with the token provider.
export function createDestination({ provider, clientId, clientSecret, refreshToken, folderId, onRotate }) {
  const impl = IMPLS[provider]
  if (!impl) throw new Error(`unknown_provider:${provider}`)
  const token = makeTokenProvider({ provider, clientId, clientSecret, refreshToken, onRotate })
  const ctx = { token, folderId }
  return {
    provider,
    getRefreshToken: token.getRefreshToken,
    getFolderId: () => ctx.folderId,
    ensureFolder: () => impl.ensureFolder(ctx),
    upload: (localPath, remoteName, onProgress) => impl.upload(ctx, localPath, remoteName, onProgress),
    list: () => impl.list(ctx),
    download: (remoteId, destPath, onProgress) => impl.download(ctx, remoteId, destPath, onProgress),
    delete: (remoteId) => impl.remove(ctx, remoteId),
    quota: () => impl.quota(ctx),
  }
}
