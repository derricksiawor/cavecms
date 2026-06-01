// Microsoft OneDrive destination (Graph, zero-dep, raw REST). Scope
// Files.ReadWrite.AppFolder → a dedicated /Apps/CaveCMS folder the owner can
// see. Resumable upload per
// https://learn.microsoft.com/graph/api/driveitem-createuploadsession.

import { statSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fetchRetry, readChunk, withOpenFile, chunkSize } from './destination.mjs'

const GRAPH = 'https://graph.microsoft.com/v1.0'

async function authHeader(ctx, forceRefresh = false) {
  return `Bearer ${await ctx.token.getAccessToken(forceRefresh)}`
}

// AppFolder (approot) is created on demand by Graph; nothing to do. Returned for
// API symmetry with gdrive.
export async function ensureFolder() {
  return 'approot'
}

async function createSession(ctx, remoteName) {
  const res = await fetchRetry(
    `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(remoteName)}:/createUploadSession`,
    {
      method: 'POST',
      headers: { authorization: await authHeader(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    },
  )
  if (!res.ok) throw new Error(`onedrive_session_failed:${res.status}`)
  const j = await res.json()
  if (!j.uploadUrl) throw new Error('onedrive_no_upload_url')
  return j.uploadUrl
}

// Resumable upload. Returns { remoteId }. Restarts the whole session once on a
// 404 (expired session).
export async function upload(ctx, localPath, remoteName, onProgress, _restarted = false) {
  const total = statSync(localPath).size

  // Tiny/empty file: simple content PUT (createUploadSession rejects 0 bytes).
  if (total === 0) {
    const res = await fetchRetry(
      `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(remoteName)}:/content`,
      {
        method: 'PUT',
        headers: { authorization: await authHeader(ctx), 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(0),
      },
    )
    if (!res.ok) throw new Error(`onedrive_empty_put_failed:${res.status}`)
    const j = await res.json()
    return { remoteId: j.id }
  }

  const uploadUrl = await createSession(ctx, remoteName)

  try {
    return await withOpenFile(localPath, async (fh) => {
      let offset = 0
      while (offset < total) {
        const len = Math.min(chunkSize(), total - offset)
        const chunk = await readChunk(fh, offset, len)
        const end = offset + chunk.length - 1
        // NOTE: no Authorization header on the upload-URL PUTs — the session
        // URL is pre-authenticated.
        const res = await fetchRetry(uploadUrl, {
          method: 'PUT',
          headers: {
            'content-length': String(chunk.length),
            'content-range': `bytes ${offset}-${end}/${total}`,
          },
          body: chunk,
        })
        if (res.status === 404) {
          throw new Error('onedrive_session_404')
        }
        if (res.status === 202) {
          // Accepted — advance using nextExpectedRanges ("start-end" or "start-").
          let j = {}
          try {
            j = await res.json()
          } catch {
            j = {}
          }
          const ranges = j.nextExpectedRanges
          if (Array.isArray(ranges) && ranges.length > 0) {
            const start = Number(String(ranges[0]).split('-')[0])
            if (Number.isFinite(start)) offset = start
            else offset = end + 1
          } else {
            offset = end + 1
          }
          if (onProgress) onProgress(offset, total)
          continue
        }
        if (res.status === 200 || res.status === 201) {
          if (onProgress) onProgress(total, total)
          const j = await res.json()
          return { remoteId: j.id }
        }
        throw new Error(`onedrive_chunk_failed:${res.status}`)
      }
      throw new Error('onedrive_upload_incomplete')
    })
  } catch (err) {
    if (!_restarted && err instanceof Error && err.message === 'onedrive_session_404') {
      // Session expired — restart the whole upload once.
      return upload(ctx, localPath, remoteName, onProgress, true)
    }
    throw err
  }
}

export async function list(ctx) {
  const res = await fetchRetry(
    `${GRAPH}/me/drive/special/approot/children?$select=id,name,size,createdDateTime&$top=999`,
    { headers: { authorization: await authHeader(ctx) } },
  )
  if (!res.ok) throw new Error(`onedrive_list_failed:${res.status}`)
  const j = await res.json()
  return (j.value || []).map((f) => ({
    remoteId: f.id,
    name: f.name,
    sizeBytes: typeof f.size === 'number' ? f.size : 0,
    createdAt: f.createdDateTime || null,
  }))
}

export async function download(ctx, remoteId, destPath, onProgress) {
  // Graph 302-redirects /content to a pre-authenticated CDN URL; fetch follows.
  const res = await fetchRetry(`${GRAPH}/me/drive/items/${remoteId}/content`, {
    headers: { authorization: await authHeader(ctx) },
    redirect: 'follow',
  })
  if (!res.ok || !res.body) throw new Error(`onedrive_download_failed:${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let seen = 0
  const body = Readable.fromWeb(res.body)
  if (onProgress && total) {
    body.on('data', (c) => {
      seen += c.length
      onProgress(seen, total)
    })
  }
  await pipeline(body, createWriteStream(destPath, { mode: 0o600 }))
  return { destPath }
}

export async function remove(ctx, remoteId) {
  const res = await fetchRetry(`${GRAPH}/me/drive/items/${remoteId}`, {
    method: 'DELETE',
    headers: { authorization: await authHeader(ctx) },
  })
  if (!res.ok && res.status !== 404) throw new Error(`onedrive_delete_failed:${res.status}`)
}

export async function quota(ctx) {
  const res = await fetchRetry(`${GRAPH}/me/drive?$select=quota`, {
    headers: { authorization: await authHeader(ctx) },
  })
  if (!res.ok) return null
  const j = await res.json()
  const q = j.quota || {}
  return {
    usedBytes: typeof q.used === 'number' ? q.used : null,
    totalBytes: typeof q.total === 'number' ? q.total : null,
  }
}
