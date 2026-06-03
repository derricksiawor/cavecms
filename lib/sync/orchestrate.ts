// In-process push/pull engine for the local↔remote content sync.
//
// This is the SERVER-SIDE counterpart to the `cavecms push` / `cavecms pull`
// CLI commands: it lets the operator's AI (via the HTTP API or an MCP tool)
// drive a publish from one terminal, WITHOUT the CLI's cross-HTTP self-call to
// its own /export. Two legs, deliberately asymmetric:
//
//   • THIS install's content is assembled IN-PROCESS — buildBundleContent()
//     reads the DB directly and media files are copied straight off disk
//     (PATHS.variants / PATHS.brochures), never re-downloaded over HTTP. This
//     is the SAME content the GET /api/cms/sync/export route serializes, so the
//     bundle is byte-for-byte equivalent to what the CLI would assemble — minus
//     the network round trip.
//
//   • The OTHER install (the push target / pull source) is ALWAYS reached over
//     HTTP, with the target's bearer token, mirroring the CLI's syncRequest
//     wire contract (browser-ish UA, sane timeout, raw application/gzip stage
//     body). The token is held only in the ResolvedTarget for the duration of
//     one transfer and is NEVER logged or returned to a caller.
//
// pushTo:  assemble THIS install → tar → remote GET /hash (informational) →
//          POST /stage (?validateOnly=1 when dryRun) → POST /cutover (unless dryRun).
// pullFrom: remote GET /export + /hash → download media into a temp bundle dir
//          → stageBundleFromDir (the SHARED apply path, in-process) → runCutover.

import 'server-only'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { buildBundleContent, contentGraphOf } from '@/lib/sync/serializeLocal'
import { canonicalContentHash } from '@/lib/sync/contentHash'
import { BUNDLE_FORMAT_VERSION } from '@/lib/sync/bundleTypes'
import { PATHS } from '@/lib/media/storage'
import { stageBundleFromDir } from '@/lib/sync/stageFromDir'
import { runCutover } from '@/lib/sync/cutover'
import type { ResolvedTarget } from '@/lib/sync/syncTargets'

// Browser-ish UA so a Cloudflare-fronted target (Bot Fight Mode) doesn't 403
// the request the way it does a bare node-fetch/curl from a datacenter IP —
// matches the CLI's RELEASE_FETCH_UA.
const SYNC_FETCH_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
// Wall-clock budget per remote request. A large bundle's /stage upload + the
// /cutover swap can each take a while; the API route's own 600s handler timeout
// is the outer bound — this is the per-request socket timeout.
const REQUEST_TIMEOUT_MS = 300_000

// The image variants the serializer emits, with their on-disk extension.
const IMG_VARIANTS = [
  ['thumb', 'webp'],
  ['md', 'webp'],
  ['lg', 'webp'],
  ['og', 'jpg'],
] as const

interface RemoteResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

// One raw HTTP(S) request to a remote install. Mirrors the CLI's syncRequest:
// browser UA, optional Bearer token, hard socket timeout. NEVER logs the token.
function remoteRequest(
  method: string,
  urlStr: string,
  { token, headers = {}, body }: { token?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(urlStr)
    } catch {
      reject(new Error(`invalid_url:${urlStr}`))
      return
    }
    const lib = u.protocol === 'https:' ? https : http
    const h: Record<string, string> = { 'user-agent': SYNC_FETCH_UA, ...headers }
    if (token) h.authorization = `Bearer ${token}`
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: h,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('request_timed_out')))
    if (body) req.write(body)
    req.end()
  })
}

function tryJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// ── push ────────────────────────────────────────────────────────────────────

export interface PushResult {
  ok: boolean
  // True when this was a validate-only dry run (nothing written on the target).
  dryRun: boolean
  // The remote stage id (present once /stage succeeds, on both dry and real runs).
  stageId?: string
  // The pushed bundle's content hash (self-integrity + what the target becomes).
  contentHash: string
  // Preflight / cutover summary counts, when the remote returned them.
  summary?: unknown
  // The cutover's per-entity applied counts (real, non-dry runs only).
  swapped?: unknown
  // True when the target refused the cutover because it changed since this
  // bundle's baseline — the caller can re-invoke with force to overwrite.
  drift?: boolean
  // Operator-facing message (internals-free; the target's bearer token is never
  // included, only its redacted name).
  message: string
}

// Materialize THIS install's content into `outDir` as a bundle directory in the
// exact layout the stage route's tar extraction expects (manifest.json +
// content/*.json + media/manifest.json + media/files/*). Media files are copied
// straight off disk — no HTTP self-call.
async function assembleLocalBundleDir(outDir: string): Promise<{ contentHash: string }> {
  const content = await buildBundleContent()
  const contentHash = canonicalContentHash(contentGraphOf(content))

  const filesDir = path.join(outDir, 'media', 'files')
  mkdirSync(path.join(outDir, 'content'), { recursive: true })
  mkdirSync(filesDir, { recursive: true })

  // Rewrite each media entry's `files` from the export's URL form to the
  // bundle-relative form, copying the on-disk source into media/files/.
  const mediaOut = content.media.map((m) => {
    const files: Record<string, string> = {}
    if (m.kind === 'pdf') {
      // export form: { pdf: '/api/cms/sync/media/pdf/<uuid>' } → disk
      // PATHS.brochures/<uuid>.pdf. The bundleKey names the in-bundle file.
      const url = m.files.pdf
      if (url) {
        const uuid = url.split('/').pop() ?? ''
        const src = path.join(PATHS.brochures, `${uuid}.pdf`)
        const rel = `media/files/${m.bundleKey}.pdf`
        copyFileSync(src, path.join(outDir, rel))
        files.pdf = rel
      }
    } else {
      for (const [variant, ext] of IMG_VARIANTS) {
        // export form: '/uploads/variants/<name>' → disk PATHS.variants/<name>.
        const url = m.files[variant]
        if (!url) continue
        const name = url.split('/').pop() ?? ''
        const src = path.join(PATHS.variants, name)
        const rel = `media/files/${m.bundleKey}-${variant}.${ext}`
        copyFileSync(src, path.join(outDir, rel))
        files[variant] = rel
      }
    }
    return { ...m, files }
  })

  const manifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    // The bundle's provenance is THIS install; baseline is null because a
    // local→remote push has no prod-pull baseline (the stage route recomputes
    // the real target baseline server-side anyway).
    sourceUrl: 'cavecms://local',
    baselineContentHash: null,
    contentHash,
    counts: {
      pages: content.pages.length,
      posts: content.posts.length,
      projects: content.projects.length,
      media: mediaOut.length,
      settings: Object.keys(content.settings).length,
    },
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(path.join(outDir, 'content', 'pages.json'), JSON.stringify(content.pages))
  writeFileSync(path.join(outDir, 'content', 'posts.json'), JSON.stringify(content.posts))
  writeFileSync(path.join(outDir, 'content', 'projects.json'), JSON.stringify(content.projects))
  writeFileSync(path.join(outDir, 'content', 'settings.json'), JSON.stringify(content.settings))
  writeFileSync(
    path.join(outDir, 'content', 'settings-media-refs.json'),
    JSON.stringify(content.settingsMediaRefs ?? {}),
  )
  writeFileSync(path.join(outDir, 'media', 'manifest.json'), JSON.stringify(mediaOut))
  return { contentHash }
}

/**
 * Push THIS install's content to a remote target. The local bundle is assembled
 * + tarred in-process; only the target is reached over HTTP. `dryRun` runs the
 * target's preflight (?validateOnly=1) and writes nothing. A 409 drift_detected
 * on cutover maps to `{ ok: false, drift: true }` — the caller retries with
 * `force`. The temp dir + tarball are removed on EVERY exit path; the token is
 * never logged.
 */
export async function pushTo({
  target,
  force = false,
  dryRun = false,
}: {
  target: ResolvedTarget
  force?: boolean
  dryRun?: boolean
}): Promise<PushResult> {
  const work = mkdtempSync(path.join(tmpdir(), 'cavecms-push-'))
  const bundleDir = path.join(work, 'bundle')
  const tgz = path.join(work, 'bundle.tgz')
  try {
    mkdirSync(bundleDir, { recursive: true })
    const { contentHash } = await assembleLocalBundleDir(bundleDir)

    // tar the bundle dir — same posture + member list as the stage upload tar
    // (manifest.json + content + media), so the remote's link/member guards see
    // the identical structure they expect.
    const tar = spawnSync(
      'tar',
      ['-czf', tgz, '-C', bundleDir, 'manifest.json', 'content', 'media'],
      { encoding: 'utf8', timeout: 300_000 },
    )
    if (tar.error || tar.status !== 0) {
      return { ok: false, dryRun, contentHash, message: 'could not package the local bundle (tar failed)' }
    }
    const tgzBuf = readFileSync(tgz)

    // Informational baseline probe (the target recomputes its own drift baseline
    // server-side at stage time; this is purely for the caller's message).
    await remoteRequest('GET', `${target.url}/api/cms/sync/hash`, {
      token: target.token,
      headers: { accept: 'application/json' },
    }).catch(() => null)

    // STAGE — raw application/gzip body (lets the target stream to disk under a
    // hard cap; multipart would force a full-heap buffer on the receiver).
    const stagePath = dryRun
      ? `${target.url}/api/cms/sync/stage?validateOnly=1`
      : `${target.url}/api/cms/sync/stage`
    const stageRes = await remoteRequest('POST', stagePath, {
      token: target.token,
      headers: {
        'content-type': 'application/gzip',
        accept: 'application/json',
        'content-length': String(tgzBuf.length),
      },
      body: tgzBuf,
    })
    const stageJson = asRecord(tryJson(stageRes.body))
    if (stageRes.status === 401 || stageRes.status === 403) {
      return { ok: false, dryRun, contentHash, message: `${target.name} rejected the API token (re-check the target's credentials)` }
    }
    if (stageRes.status !== 200 || !stageJson || stageJson.ok !== true) {
      // Carry the preflight errors/summary up so the caller can surface them.
      return {
        ok: false,
        dryRun,
        contentHash,
        summary: stageJson?.summary,
        message:
          stageJson && Array.isArray(stageJson.errors)
            ? `${target.name} rejected the bundle (${stageJson.errors.length} preflight error(s))`
            : `staging to ${target.name} failed (HTTP ${stageRes.status})`,
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        contentHash,
        summary: stageJson.summary,
        message: `dry run OK — ${target.name} accepted the bundle; nothing was written`,
      }
    }

    const stageId = typeof stageJson.stageId === 'string' ? stageJson.stageId : undefined
    if (!stageId) {
      return { ok: false, dryRun, contentHash, summary: stageJson.summary, message: `${target.name} staged without returning a stage id` }
    }

    // CUTOVER — only stageId + force travel; the drift baseline is the target's
    // immutable staged record. A direct caller can't null it to skip drift.
    const cutRes = await remoteRequest('POST', `${target.url}/api/cms/sync/cutover`, {
      token: target.token,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: Buffer.from(JSON.stringify({ stageId, force })),
    })
    const cutJson = asRecord(tryJson(cutRes.body))
    if (cutRes.status === 409 && cutJson?.reason === 'drift_detected') {
      return {
        ok: false,
        dryRun: false,
        stageId,
        contentHash,
        drift: true,
        message: `${target.name} changed since this bundle was built — re-run with force to overwrite`,
      }
    }
    if (cutRes.status === 409 && cutJson?.reason === 'busy') {
      return { ok: false, dryRun: false, stageId, contentHash, message: `${target.name} is busy with another operation — retry shortly` }
    }
    if (cutRes.status !== 200 || !cutJson || cutJson.ok !== true) {
      const reason = typeof cutJson?.reason === 'string' ? cutJson.reason : `HTTP ${cutRes.status}`
      return { ok: false, dryRun: false, stageId, contentHash, message: `cutover on ${target.name} failed (${reason})` }
    }
    return {
      ok: true,
      dryRun: false,
      stageId,
      contentHash: typeof cutJson.contentHash === 'string' ? cutJson.contentHash : contentHash,
      swapped: cutJson.swapped,
      message: `published to ${target.name}`,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── pull ──────────────────────────────────────────────────────────────────

export interface PullResult {
  ok: boolean
  // The applied content hash on THIS install once the cutover lands.
  contentHash?: string
  // The cutover's per-entity applied counts (success only).
  swapped?: unknown
  // True when the local cutover refused because THIS install changed since the
  // pull's baseline — the caller can re-pull (the source is authoritative).
  drift?: boolean
  message: string
}

// Download a single media file from the source over HTTP into the bundle dir.
async function downloadInto(
  url: string,
  token: string,
  dest: string,
): Promise<void> {
  const res = await remoteRequest('GET', url, { token, headers: { accept: 'image/*,application/pdf' } })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`media_download_failed:${res.status}`)
  }
  // A 200 with an HTML body is a CDN/proxy challenge, not the file — writing it
  // would silently corrupt the bundle. Require an image/pdf content-type.
  const ct = String(res.headers['content-type'] ?? '')
  if (!/^(image\/|application\/pdf)/i.test(ct)) {
    throw new Error(`media_download_not_a_file:${ct || 'none'}`)
  }
  if (res.body.length < 4) throw new Error('media_download_truncated')
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, res.body)
}

/**
 * Pull a remote source's content INTO this install. The source is read over
 * HTTP (/export + /hash + each media file); the apply is fully in-process,
 * REUSING the stage route's hardened post-extraction path via stageBundleFromDir
 * → runCutover. runCutover acquires the shared op-lock (mutually exclusive with
 * update/backup/a concurrent cutover), so a 'busy' is surfaced cleanly. The
 * temp bundle dir is removed on every exit path; the token is never logged.
 */
export async function pullFrom({
  source,
  userId,
  tokenId,
}: {
  source: ResolvedTarget
  userId: number
  tokenId?: number | null
}): Promise<PullResult> {
  const work = mkdtempSync(path.join(tmpdir(), 'cavecms-pull-'))
  try {
    // 1. Fetch the source's serialized content + drift baseline.
    const expRes = await remoteRequest('GET', `${source.url}/api/cms/sync/export`, {
      token: source.token,
      headers: { accept: 'application/json' },
    })
    if (expRes.status === 401 || expRes.status === 403) {
      return { ok: false, message: `${source.name} rejected the API token (re-check the source's credentials)` }
    }
    if (expRes.status !== 200) {
      return { ok: false, message: `could not read ${source.name} (HTTP ${expRes.status})` }
    }
    const exp = asRecord(tryJson(expRes.body))
    const content = asRecord(exp?.content)
    if (!exp || !content) {
      return { ok: false, message: `${source.name} did not return a CaveCMS sync response` }
    }
    const hashRes = await remoteRequest('GET', `${source.url}/api/cms/sync/hash`, {
      token: source.token,
      headers: { accept: 'application/json' },
    }).catch(() => null)
    const hashJson = hashRes ? asRecord(tryJson(hashRes.body)) : null
    const baselineContentHash =
      hashJson && typeof hashJson.contentHash === 'string' ? hashJson.contentHash : null

    // 2. Materialize the bundle dir (mirrors the CLI's assembleSyncBundle):
    //    write the content JSON + download each media file into media/files/.
    const filesDir = path.join(work, 'media', 'files')
    mkdirSync(path.join(work, 'content'), { recursive: true })
    mkdirSync(filesDir, { recursive: true })

    const mediaArr = Array.isArray(content.media) ? content.media : []
    const mediaOut: Array<Record<string, unknown>> = []
    for (const raw of mediaArr) {
      const m = asRecord(raw)
      if (!m) continue
      const bundleKey = String(m.bundleKey ?? '')
      const srcFiles = asRecord(m.files) ?? {}
      const files: Record<string, string> = {}
      if (m.kind === 'pdf') {
        const url = typeof srcFiles.pdf === 'string' ? srcFiles.pdf : null
        if (url) {
          const rel = `media/files/${bundleKey}.pdf`
          await downloadInto(`${source.url}${url}`, source.token, path.join(work, rel))
          files.pdf = rel
        }
      } else {
        for (const [variant, ext] of IMG_VARIANTS) {
          const url = typeof srcFiles[variant] === 'string' ? (srcFiles[variant] as string) : null
          if (!url) continue
          const rel = `media/files/${bundleKey}-${variant}.${ext}`
          await downloadInto(`${source.url}${url}`, source.token, path.join(work, rel))
          files[variant] = rel
        }
      }
      mediaOut.push({ ...m, files })
    }

    const pages = Array.isArray(content.pages) ? content.pages : []
    const posts = Array.isArray(content.posts) ? content.posts : []
    const projects = Array.isArray(content.projects) ? content.projects : []
    const settings = asRecord(content.settings) ?? {}
    const manifest = {
      formatVersion: typeof exp.formatVersion === 'number' ? exp.formatVersion : BUNDLE_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      sourceUrl: source.url,
      baselineContentHash,
      contentHash: typeof exp.contentHash === 'string' ? exp.contentHash : '',
      counts: {
        pages: pages.length,
        posts: posts.length,
        projects: projects.length,
        media: mediaOut.length,
        settings: Object.keys(settings).length,
      },
    }
    writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(path.join(work, 'content', 'pages.json'), JSON.stringify(pages))
    writeFileSync(path.join(work, 'content', 'posts.json'), JSON.stringify(posts))
    writeFileSync(path.join(work, 'content', 'projects.json'), JSON.stringify(projects))
    writeFileSync(path.join(work, 'content', 'settings.json'), JSON.stringify(settings))
    writeFileSync(
      path.join(work, 'content', 'settings-media-refs.json'),
      JSON.stringify(asRecord(content.settingsMediaRefs) ?? {}),
    )
    writeFileSync(path.join(work, 'media', 'manifest.json'), JSON.stringify(mediaOut))

    // 3. Apply IN-PROCESS via the shared stage path, then cut over. The dir was
    //    assembled by us (no untrusted tar), but stageBundleFromDir still
    //    re-validates the bundle + re-asserts media path containment.
    const staged = await stageBundleFromDir(work, userId)
    if (!staged.ok) {
      return {
        ok: false,
        message: `the content from ${source.name} failed validation (${staged.errors.length} error(s))`,
      }
    }
    const out = await runCutover({ stageId: staged.stageId }, { userId, tokenId })
    if (!out.ok) {
      if (out.reason === 'drift_detected') {
        return { ok: false, drift: true, message: `this install changed during the pull — re-run the pull from ${source.name}` }
      }
      if (out.reason === 'busy') {
        return { ok: false, message: 'this install is busy with another operation — retry shortly' }
      }
      return { ok: false, message: `applying ${source.name}'s content failed (${out.reason})` }
    }
    return {
      ok: true,
      contentHash: out.contentHash,
      swapped: out.swapped,
      message: `pulled ${source.name}'s content into this install`,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
