import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
  unlinkSync,
  createReadStream,
  createWriteStream,
} from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform, Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { db } from '@/db/client'
import { SyncBundle } from '@/lib/sync/bundleTypes'
import { validateBundle } from '@/lib/sync/preflight'
import { provisionBundleMedia, resolveStagedContent } from '@/lib/sync/mediaRemap'
import { putStage, sweepExpiredStages } from '@/lib/sync/stageStore'
import { buildBundleContent, contentGraphOf } from '@/lib/sync/serializeLocal'
import { canonicalContentHash } from '@/lib/sync/contentHash'
import { getResolvedLoginPath } from '@/lib/security/getResolvedLoginPath'

export const runtime = 'nodejs'

const MAX_BUNDLE_BYTES = 200 * 1024 * 1024 // compressed upload cap
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024 // decompression-bomb ceiling
const MAX_JSON_BYTES = 64 * 1024 * 1024 // per content/*.json parse cap
const MAX_TAR_MEMBERS = 250_000 // inode-bomb ceiling (≈50k-media site headroom)

// POST /api/cms/sync/stage  (raw application/gzip body = the bundle .tgz)
//   ?validateOnly=1 → preflight only, returns errors + summary, writes nothing.
//   otherwise → validate + upload media (additive) + persist staged payload,
//   atomically (media rows + stage row in one transaction).
export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  // Opportunistic cleanup of expired staging rows (their quarantined media is
  // already soft-deleted and reaped by the nightly media purge).
  await sweepExpiredStages().catch(() => {})

  const validateOnly = new URL(req.url).searchParams.get('validateOnly') === '1'

  // Reject an over-cap upload via the declared content-length BEFORE we read a
  // single byte. A forged/absent/understated content-length is still bounded by
  // the streamed write cap below (which aborts mid-flow at MAX_BUNDLE_BYTES).
  const declaredLen = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BUNDLE_BYTES) {
    throw new HttpError(413, 'bundle_too_large')
  }

  const work = mkdtempSync(path.join(tmpdir(), 'cavecms-sync-stage-'))
  const tgz = path.join(work, 'bundle.tgz')
  const tarPath = path.join(work, 'bundle.tar')
  const extract = path.join(work, 'x')
  const written: string[] = []
  try {
    // 0. STREAM the raw request body straight to disk under a HARD byte cap —
    //    never buffer the whole compressed bundle in heap. `req.formData()` /
    //    `arrayBuffer()` would buffer it all before any size check could fire,
    //    so a forged request that omits/understates content-length could OOM
    //    the shared host. Streaming with an inline counter aborts the moment the
    //    body exceeds MAX_BUNDLE_BYTES, regardless of the declared length.
    if (!req.body) throw new HttpError(400, 'bundle_required')
    let received = 0
    const sizeCap = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length
        if (received > MAX_BUNDLE_BYTES) {
          cb(new HttpError(413, 'bundle_too_large'))
          return
        }
        cb(null, chunk)
      },
    })
    try {
      // Cast: req.body is the DOM ReadableStream type; Readable.fromWeb wants
      // node:stream/web's — structurally identical at runtime.
      const webStream = req.body as unknown as Parameters<typeof Readable.fromWeb>[0]
      await pipeline(Readable.fromWeb(webStream), sizeCap, createWriteStream(tgz))
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(400, 'bundle_unreadable')
    }
    if (received === 0) throw new HttpError(400, 'bundle_required')

    // 1. Stream-decompress gzip → tar with a HARD uncompressed cap enforced
    //    WHILE bytes flow — so a decompression bomb is aborted mid-stream,
    //    before it ever lands on the shared-host filesystem (the prior post-
    //    extraction `du` check fired only after the bomb had already written).
    let total = 0
    const cap = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length
        if (total > MAX_EXTRACTED_BYTES) {
          cb(new HttpError(413, 'bundle_too_large_unpacked'))
          return
        }
        cb(null, chunk)
      },
    })
    try {
      await pipeline(createReadStream(tgz), createGunzip(), cap, createWriteStream(tarPath))
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(400, 'bundle_unreadable')
    }

    // 2. List members and reject symlink/hardlink members BEFORE extracting —
    //    a tar symlink-then-write-through escape happens DURING extraction, so a
    //    post-extraction check is too late. `tar -tv` prints the type as the
    //    first char of each line (l = symlink, h = hardlink). FAIL CLOSED.
    const listed = spawnSync('tar', ['-tvf', tarPath], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (listed.error || listed.status !== 0) throw new HttpError(400, 'bundle_unreadable')
    let members = 0
    for (const line of listed.stdout.split('\n')) {
      if (line.length === 0) continue
      if (line[0] === 'l' || line[0] === 'h') throw new HttpError(422, 'bundle_contains_link')
      // Member-count cap: the byte ceiling alone doesn't stop an inode bomb
      // (millions of zero-byte entries pass MAX_EXTRACTED_BYTES yet exhaust
      // inodes / pin IO on the shared host). A real bundle is manifest + ~6
      // content JSON + up to ~4 variant files per media — generous headroom
      // for even a 50k-media site, but far below a malicious member flood.
      if (++members > MAX_TAR_MEMBERS) throw new HttpError(422, 'bundle_too_many_members')
    }

    // 3. Extract the size-bounded, link-free tar, confined to `extract`.
    mkdirSync(extract, { recursive: true })
    const tar = spawnSync(
      'tar',
      ['-xf', tarPath, '-C', extract, '-m', '--no-same-owner', '--no-same-permissions'],
      { encoding: 'utf8', timeout: 120_000 },
    )
    if (tar.error) throw new HttpError(500, 'tar_unavailable')
    if (tar.status !== 0) throw new HttpError(400, 'bundle_extract_failed')

    // 4. Defence-in-depth: assert no symlink survived (fail closed if `find` is
    //    missing) before any safeCopy reads from the tree.
    const links = spawnSync('find', [extract, '-type', 'l'], { encoding: 'utf8', timeout: 30_000 })
    if (links.error || links.status !== 0) throw new HttpError(500, 'find_unavailable')
    if ((links.stdout ?? '').trim() !== '') throw new HttpError(422, 'bundle_contains_symlink')

    const read = (rel: string): unknown => {
      const p = path.join(extract, rel)
      if (!existsSync(p)) throw new HttpError(400, `bundle_missing:${rel}`)
      if (statSync(p).size > MAX_JSON_BYTES) throw new HttpError(413, `bundle_json_too_large:${rel}`)
      return JSON.parse(readFileSync(p, 'utf8'))
    }
    const readOptional = (rel: string, fallback: unknown): unknown => {
      const p = path.join(extract, rel)
      if (!existsSync(p)) return fallback
      if (statSync(p).size > MAX_JSON_BYTES) throw new HttpError(413, `bundle_json_too_large:${rel}`)
      return JSON.parse(readFileSync(p, 'utf8'))
    }
    const candidate = {
      manifest: read('manifest.json'),
      pages: read('content/pages.json'),
      posts: read('content/posts.json'),
      projects: read('content/projects.json'),
      settings: read('content/settings.json'),
      settingsMediaRefs: readOptional('content/settings-media-refs.json', {}),
      media: read('media/manifest.json'),
    }
    const parsed = SyncBundle.safeParse(candidate)
    if (!parsed.success) throw new HttpError(422, 'bundle_malformed')
    const bundle = parsed.data

    // Resolve the target's live login path so preflight can reject a pushed
    // page that would shadow it (best-effort — a resolver hiccup just skips the
    // login-path check; RESERVED slugs are still enforced).
    const loginPath = await getResolvedLoginPath().catch(() => undefined)
    const pre = validateBundle(bundle, { loginPath })
    if (!pre.ok) {
      return json(422, { ok: false, errors: pre.errors, summary: pre.summary })
    }
    if (validateOnly) {
      return json(200, { ok: true, validateOnly: true, summary: pre.summary, contentHash: bundle.manifest.contentHash })
    }

    // Drift baseline = the TARGET's content hash AT STAGE TIME, computed
    // server-side. The cutover later compares the target's live hash against
    // THIS, so it detects a concurrent edit landing between stage and cutover.
    // (The bundle's own manifest.baselineContentHash is source-side provenance
    // and meaningless as a target baseline — using it made every local→prod
    // push fire drift and forced --force.)
    const targetBaseline = canonicalContentHash(contentGraphOf(await buildBundleContent()))

    // Atomic: media rows + the stage row commit together. On rollback the media
    // ROWS are gone; the catch below unlinks the copied FILES (in `written`).
    const stageId = await db.transaction(async (tx) => {
      const keyToMedia = await provisionBundleMedia(tx, bundle.media, extract, written)
      const staged = resolveStagedContent(
        {
          pages: bundle.pages,
          posts: bundle.posts,
          projects: bundle.projects,
          settings: bundle.settings,
          settingsMediaRefs: bundle.settingsMediaRefs,
        },
        keyToMedia,
      )
      return putStage(staged, bundle.manifest.contentHash, targetBaseline, ctx.userId, tx)
    })

    return json(200, {
      ok: true,
      stageId,
      contentHash: bundle.manifest.contentHash,
      summary: pre.summary,
    })
  } catch (e) {
    // Unlink media files copied before a mid-stage failure (the rows are gone
    // with the rolled-back transaction; only the files would leak).
    for (const p of written) {
      try {
        unlinkSync(p)
      } catch {
        /* already gone */
      }
    }
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}, { timeoutMs: 600_000 }) // tar extract + media upload of a large bundle can exceed the 15s default

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
