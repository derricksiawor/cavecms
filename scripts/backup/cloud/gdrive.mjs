// Google Drive destination (zero-dep, raw REST). Scope drive.file: the app
// only sees files it created, but the owner sees them in their Drive. Resumable
// upload per https://developers.google.com/drive/api/guides/manage-uploads.

import { statSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fetchRetry, readChunk, withOpenFile, chunkSize } from './destination.mjs'

const FOLDER_NAME = 'CaveCMS Backups'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'

async function authHeader(ctx, forceRefresh = false) {
  return `Bearer ${await ctx.token.getAccessToken(forceRefresh)}`
}

// Create the "CaveCMS Backups" folder once; return its id. If ctx.folderId is
// already set, reuse it.
export async function ensureFolder(ctx) {
  if (ctx.folderId) return ctx.folderId
  const res = await fetchRetry(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { authorization: await authHeader(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
  if (!res.ok) throw new Error(`gdrive_folder_failed:${res.status}`)
  const j = await res.json()
  ctx.folderId = j.id
  return j.id
}

// Resumable upload. Returns { remoteId }.
export async function upload(ctx, localPath, remoteName, onProgress) {
  const folderId = await ensureFolder(ctx)
  const total = statSync(localPath).size

  // 1. Initiate the resumable session.
  const init = await fetchRetry(UPLOAD, {
    method: 'POST',
    headers: {
      authorization: await authHeader(ctx),
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(total),
    },
    body: JSON.stringify({ name: remoteName, parents: [folderId] }),
  })
  if (!init.ok) throw new Error(`gdrive_session_failed:${init.status}`)
  const sessionUri = init.headers.get('location')
  if (!sessionUri) throw new Error('gdrive_no_session_uri')

  // 2. PUT chunks with Content-Range. 308 between, 200/201 on the last. On any
  // mid-upload failure, best-effort abandon the resumable session so it doesn't
  // linger on the provider until it auto-expires.
  return withOpenFile(localPath, async (fh) => {
    let offset = 0
    // Handle the empty-file edge: send a single zero-length finalizing PUT.
    if (total === 0) {
      const res = await fetchRetry(sessionUri, {
        method: 'PUT',
        headers: { 'content-range': `bytes */0` },
      })
      if (!res.ok) throw new Error(`gdrive_empty_put_failed:${res.status}`)
      const j = await res.json()
      return { remoteId: j.id }
    }
    while (offset < total) {
      const len = Math.min(chunkSize(), total - offset)
      const chunk = await readChunk(fh, offset, len)
      const end = offset + chunk.length - 1
      const res = await fetchRetry(sessionUri, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.length),
          'content-range': `bytes ${offset}-${end}/${total}`,
        },
        body: chunk,
      })
      if (res.status === 308) {
        // Resume Incomplete — advance using the Range header the server ack'd.
        const range = res.headers.get('range') // e.g. "bytes=0-10485759"
        if (range) {
          const m = /bytes=0-(\d+)/.exec(range)
          if (m) offset = Number(m[1]) + 1
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
      throw new Error(`gdrive_chunk_failed:${res.status}`)
    }
    throw new Error('gdrive_upload_incomplete')
  }).catch(async (err) => {
    try {
      await fetch(sessionUri, { method: 'DELETE', signal: AbortSignal.timeout(15_000) })
    } catch {
      /* best-effort abandon */
    }
    throw err
  })
}

// List backup archives in the folder. Returns [{ remoteId, name, sizeBytes, createdAt }].
export async function list(ctx) {
  const folderId = await ensureFolder(ctx)
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
  const fields = encodeURIComponent('files(id,name,size,createdTime)')
  const res = await fetchRetry(
    `${API}/files?q=${q}&fields=${fields}&orderBy=createdTime desc&pageSize=1000`,
    { headers: { authorization: await authHeader(ctx) } },
  )
  if (!res.ok) throw new Error(`gdrive_list_failed:${res.status}`)
  const j = await res.json()
  return (j.files || []).map((f) => ({
    remoteId: f.id,
    name: f.name,
    sizeBytes: f.size ? Number(f.size) : 0,
    createdAt: f.createdTime || null,
  }))
}

export async function download(ctx, remoteId, destPath, onProgress) {
  const res = await fetchRetry(`${API}/files/${remoteId}?alt=media`, {
    headers: { authorization: await authHeader(ctx) },
  })
  if (!res.ok || !res.body) throw new Error(`gdrive_download_failed:${res.status}`)
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
  const res = await fetchRetry(`${API}/files/${remoteId}`, {
    method: 'DELETE',
    headers: { authorization: await authHeader(ctx) },
  })
  // 204 No Content on success; 404 already-gone is fine.
  if (!res.ok && res.status !== 404) throw new Error(`gdrive_delete_failed:${res.status}`)
}

export async function quota(ctx) {
  const res = await fetchRetry(`${API}/about?fields=storageQuota`, {
    headers: { authorization: await authHeader(ctx) },
  })
  if (!res.ok) return null
  const j = await res.json()
  const q = j.storageQuota || {}
  return {
    usedBytes: q.usage ? Number(q.usage) : null,
    totalBytes: q.limit ? Number(q.limit) : null,
  }
}
