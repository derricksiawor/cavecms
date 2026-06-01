import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { fileTypeFromBuffer } from 'file-type'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkCmsUploadRate } from '@/lib/auth/cmsRateLimit'
import {
  PATHS,
  cleanupTmp,
  tmpDirFor,
  writeFinal,
} from '@/lib/media/storage'
import { processImage, MimeFormatMismatchError } from '@/lib/media/sharp'

const MAX_IMAGE = 10 * 1024 * 1024
const MAX_PDF = 25 * 1024 * 1024
const ALLOWED_IMG = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
])
const ALT_MAX = 320
const MAX_LIMIT = 50
const DEFAULT_LIMIT = 30

interface InsertResult {
  insertId: number
}

// Per-process semaphore. Acceptable on single-instance PM2 (matches the
// in-memory rate-limit Map decision in Plan 01). For multi-instance
// scaling switch to an `upload_locks` table with SELECT … FOR UPDATE +
// stale-lock TTL sweep. Tracked in Plan 09 deferred list.
//
// Token-based to defeat the watchdog/finally race: each handler owns a
// Symbol; the handler's finally only clears `busyToken` if the current
// token still matches its own. The watchdog (30s safety net) clears
// unconditionally — so a stuck request's finally won't trip over a
// later request's slot. Without the token, watchdog-clear + new-request-
// set + stuck-request-finally would clear the SECOND request's gate
// while it was still running, admitting a THIRD.
let busyToken: symbol | null = null

export const POST = withError(async (req) => {
  const ctx = await requireRole(adminPolicy('uploadMedia'))
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  // Upload is a media WRITE — a scoped token must hold media:write (no-op for
  // cookie sessions / NULL-scope tokens). checkCmsUploadRate gives a token its
  // OWN upload bucket so an agent's uploads don't starve the human's per-user
  // upload budget (cookie sessions still draw on the per-user bucket).
  requireScope(ctx, 'media', 'write')
  checkCmsUploadRate(ctx)

  if (busyToken !== null) {
    return new Response(JSON.stringify({ error: 'busy' }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '5',
        'cache-control': 'private, no-store',
      },
    })
  }
  const myToken = Symbol('upload')
  busyToken = myToken
  // Watchdog: a stuck sharp / disk-IO call could leave the gate held past
  // the handler timeout; the inner try/finally is inside the withError
  // timeout race so its release only fires when the handler actually
  // returns. Wall-clock timer releases the gate after a hard ceiling —
  // BUT only if the current owner is still us, otherwise we'd clear a
  // later request's slot.
  const watchdog = setTimeout(() => {
    if (busyToken === myToken) busyToken = null
  }, 30_000)
  watchdog.unref()
  try {
    // (Same-fs check moved to boot — instrumentation.ts calls
    // assertSameFs once and refuses to start the worker when the mount
    // is misconfigured. Per-request was wasted IO.)

    // Reject oversize bodies BEFORE buffering. req.formData() materializes
    // the entire multipart payload into memory; a 1GB body OOM-kills the
    // worker even with the busy semaphore. content-length is advisory
    // (clients can lie) but a truthful one lets us 413 cheaply; the post-
    // buffer byteLength check below still backstops liars.
    //
    // The pre-sniff ceiling is the LARGER of the two type caps (PDF, 25MB)
    // because we don't know the content type yet — we'd need to consume
    // bytes to sniff. An image upload that lies about being a 20MB PDF
    // wastes ~15MB of buffer before the type-specific check rejects it;
    // bounded and acceptable. Tightening this further would require
    // streaming the multipart parse and sniffing on a 4KB prefix, which
    // is a much bigger change than the marginal memory win justifies.
    const declared = Number(req.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_PDF + 16 * 1024) {
      // +16KB covers multipart boundary framing for either kind.
      throw new HttpError(413, 'too_large')
    }

    const form = await req.formData()
    const file = form.get('file')
    const altText = String(form.get('alt') ?? '').slice(0, ALT_MAX).trim()
    if (!altText) throw new HttpError(400, 'alt_required')
    if (!(file instanceof File)) throw new HttpError(400, 'file_required')

    const buf = Buffer.from(await file.arrayBuffer())
    // Content sniffing — never trust the client Content-Type header.
    const sniff = await fileTypeFromBuffer(buf)
    if (!sniff) throw new HttpError(400, 'mime_unknown')
    const isPdf = sniff.mime === 'application/pdf'
    if (!isPdf && !ALLOWED_IMG.has(sniff.mime)) {
      throw new HttpError(400, 'mime_rejected')
    }
    if (
      (isPdf && buf.byteLength > MAX_PDF) ||
      (!isPdf && buf.byteLength > MAX_IMAGE)
    ) {
      throw new HttpError(413, 'too_large')
    }

    const uuid = randomUUID()
    const tmpDir = await tmpDirFor(uuid)

    // Sanitize the client-supplied filename for storage. Strip control
    // characters (\x00–\x1F + \x7F) which can corrupt log lines or break
    // shell tooling, and bound to 255 chars. HTML-escaping is the JOB OF
    // THE RENDERER — the admin UI (Plan 03 / Plan 08) MUST escape
    // original_name on display, since an editor uploading
    // `<img src=x onerror=alert(1)>.png` would otherwise execute on the
    // gallery view. Storing the raw value (minus control chars) keeps
    // forensic context intact; escape is presentation-only.
    const safeOriginalName =
      file.name
        ? file.name.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 255)
        : null

    // 1. Insert media row FIRST with variants=NULL. Renderer treats NULL
    //    as "still processing" and the parse boundary refuses to bind a
    //    media_id whose variants are missing. Guarantees no half-written
    //    row referenced by a save before the files exist.
    const [insertArr] = (await db.execute(sql`
      INSERT INTO media (filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, uploaded_by)
      VALUES (${uuid}, ${safeOriginalName}, ${sniff.mime}, ${altText}, ${null}, ${null}, ${buf.byteLength}, ${ctx.userId})
    `)) as unknown as [InsertResult]
    const insertId = Number(insertArr.insertId)

    try {
      if (isPdf) {
        // PDFs: no transformation. Write to tmp, then rename into the
        // private brochures dir (not served by nginx). Variants JSON points
        // at the gated /api/brochure/by-uuid/<uuid> endpoint, NOT a file URL.
        const tmpPdf = `${tmpDir}/upload.pdf`
        await writeFile(tmpPdf, buf, { mode: 0o640 })
        await writeFinal(tmpPdf, `${PATHS.brochures}/${uuid}.pdf`)
        await db.execute(sql`
          UPDATE media
          SET variants = ${JSON.stringify({ pdf: `/api/brochure/by-uuid/${uuid}` })}
          WHERE id = ${insertId}
        `)
      } else {
        // Images: process to 4 variants under tmpDir, archive the original,
        // then atomic-rename everything in. UPDATE variants last — that
        // is the row's "I'm ready" flip.
        let processed: Awaited<ReturnType<typeof processImage>>
        try {
          processed = await processImage(buf, tmpDir, uuid, sniff.mime)
        } catch (e) {
          if (e instanceof MimeFormatMismatchError) {
            throw new HttpError(400, 'mime_format_mismatch')
          }
          throw e
        }
        const { width, height, variants } = processed
        const tmpOriginal = `${tmpDir}/original`
        await writeFile(tmpOriginal, buf, { mode: 0o640 })

        // Track every final path written so a partial-failure can roll
        // back the renames into orphaned files we DON'T leak. Cleanup is
        // best-effort (the catch already soft-deletes the DB row; this
        // just frees disk).
        const writtenFinals: string[] = []
        try {
          await writeFinal(tmpOriginal, `${PATHS.originals}/${uuid}`)
          writtenFinals.push(`${PATHS.originals}/${uuid}`)
          for (const v of ['thumb', 'md', 'lg'] as const) {
            const dest = `${PATHS.variants}/${uuid}-${v}.webp`
            await writeFinal(`${tmpDir}/${v}.webp`, dest)
            writtenFinals.push(dest)
          }
          const ogDest = `${PATHS.variants}/${uuid}-og.jpg`
          await writeFinal(`${tmpDir}/og.jpg`, ogDest)
          writtenFinals.push(ogDest)
          await db.execute(sql`
            UPDATE media
            SET width = ${width}, height = ${height}, variants = ${JSON.stringify(variants)}
            WHERE id = ${insertId}
          `)
        } catch (renameErr) {
          // Rollback: unlink everything we did rename, leave the variants
          // dir clean. tmpDir contents are wiped in the outer finally.
          for (const f of writtenFinals) {
            await rm(f, { force: true }).catch(() => {})
          }
          throw renameErr
        }
      }
    } catch (innerErr) {
      // File ops failed after the DB row landed. Soft-delete the row so
      // nothing in the renderer can ever bind to a phantom media_id, and
      // re-throw so the client sees the failure (withError → 500). The
      // nightly purge will hard-delete on retention; orphan files in
      // tmpDir are wiped in the outer finally below.
      await db
        .execute(sql`UPDATE media SET deleted_at = NOW(3) WHERE id = ${insertId}`)
        .catch(() => {})
      throw innerErr
    } finally {
      // Always wipe the per-upload tmpDir — success or failure. rename(2)
      // moves the variant files OUT of tmpDir, so a successful run finds
      // an empty (or near-empty) directory here; a failed run leaves
      // partial files we don't want to leak. Log on cleanup failure so
      // EACCES / ENOSPC isn't silent — orphan tmp dirs accumulating is
      // a slow disk-leak signal worth a warn line.
      await cleanupTmp(uuid).catch((err: unknown) => {
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'media_cleanup_tmp_failed',
          uuid,
          err: err instanceof Error ? err.message : String(err),
        }))
      })
    }

    return new Response(JSON.stringify({ id: insertId, uuid }), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } finally {
    clearTimeout(watchdog)
    // Only release the slot if we still own it. Watchdog may have already
    // released after 30s and a new request may have taken the slot — in
    // that case we MUST NOT clear, or we'd admit a third request.
    if (busyToken === myToken) busyToken = null
  }
})

// GET /api/cms/media — cursor pagination, no CSRF required (read-only).
// Cursor is the smallest id from the previous page; the next page filters
// id < cursor for a stable DESC walk through the table.
export const GET = withError(async (req) => {
  const ctx = await requireRole(adminPolicy('uploadMedia'))
  checkReadRate(ctx.userId)
  requireScope(ctx, 'media', 'read')
  const url = new URL(req.url)
  const cursorRaw = url.searchParams.get('cursor')
  const limitRaw = url.searchParams.get('limit')
  // Defense in depth: parse + bound + reject NaN.
  const cursor = cursorRaw && /^[1-9][0-9]{0,9}$/.test(cursorRaw)
    ? Number(cursorRaw)
    : null
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(limitRaw) || DEFAULT_LIMIT),
  )

  const [rows] = (await db.execute(
    cursor
      ? sql`
        SELECT id, filename_uuid, mime_type, alt_text, width, height, byte_size, variants, created_at
        FROM media
        WHERE deleted_at IS NULL AND id < ${cursor}
        ORDER BY id DESC LIMIT ${limit}
      `
      : sql`
        SELECT id, filename_uuid, mime_type, alt_text, width, height, byte_size, variants, created_at
        FROM media
        WHERE deleted_at IS NULL
        ORDER BY id DESC LIMIT ${limit}
      `,
  )) as unknown as [Array<Record<string, unknown>>]

  const items = rows.map((r) => ({
    ...r,
    // mysql2 hands JSON columns back as strings on raw SQL; parse the
    // variants column so consumers don't have to.
    variants:
      typeof r['variants'] === 'string'
        ? JSON.parse(r['variants'] as string)
        : r['variants'],
  }))
  const last = items[items.length - 1] as { id?: number } | undefined
  const nextCursor =
    items.length === limit && typeof last?.id === 'number' ? last.id : null

  return new Response(JSON.stringify({ items, nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})

