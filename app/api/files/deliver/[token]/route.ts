import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { verifyFileDeliveryToken } from '@/lib/auth/fileDeliveryToken'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { PATHS } from '@/lib/media/storage'

// media.filename_uuid is assigned by the upload pipeline and is always
// [A-Za-z0-9._-]; this regex is belt-and-braces against a hypothetical INSERT
// bypass that wrote `..` or `/` into the column. Mismatch → 410, never read.
const FILENAME_OK = /^[A-Za-z0-9._-]{1,80}$/

// Cap on a delivered file. A misconfigured 2GB PDF burns bandwidth on every
// redemption (no-store, so no CDN help). 50MB matches the brochure cap.
const MAX_FILE_BYTES = 50 * 1024 * 1024

// Per-IP rate-limit — each invalid token costs a DB SELECT + HMAC. 30/min is
// generous for a real user (open one link, maybe retry) and caps fuzz attacks.
const limit = rateLimit('file-deliver:ip', { limit: 30, windowSec: 60 })

type RouteCtx = { params: Promise<{ token: string }> }

// A readable, safe download filename from the operator-uploaded original_name:
// strip to an ASCII slug, force a .pdf extension, fall back to download.pdf.
function safeDownloadName(original: string | null): string {
  const base = (original ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .slice(0, 80)
  return (base || 'download') + '.pdf'
}

// Generic gated-file delivery — the generalization of /api/brochure/[token].
// Verifies a signed file-delivery token (HMAC + exp), resolves the media row,
// and streams the PDF from brochures-private. Reusable within the token TTL
// (no single-use CAS — see fileDeliveryToken.ts). Defense ordered cheapest-
// first so adversarial probes pay minimum:
//   1. Rate limit per IP — drops floods before crypto.
//   2. verifyFileDeliveryToken: HMAC + exp on a length-capped base64url payload.
//   3. SELECT the media row; 410 if soft-deleted / missing / not a PDF.
//   4. stat() the file; refuse if missing or oversized.
// cache-control: private, no-store + x-robots-tag noindex + accept-ranges none
// so a gated file never reaches a CDN or search index.
export const GET = withError<RouteCtx>(async (req, { params }) => {
  const { token } = await params

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: { 'cache-control': 'private, no-store', 'retry-after': '60' },
    })
  }

  const payload = verifyFileDeliveryToken(token)
  if (!payload) return new Response('Gone', { status: 410 })

  const [rows] = (await db.execute(sql`
    SELECT filename_uuid, mime_type, original_name
    FROM media
    WHERE id = ${payload.media_id}
      AND deleted_at IS NULL
  `)) as unknown as [
    Array<{ filename_uuid: string; mime_type: string; original_name: string | null }>,
  ]
  const m = rows[0]
  if (!m) return new Response('Gone', { status: 410 })
  // Only PDFs are gated (images live in the public /uploads/variants tree). A
  // deliver_file MediaPicker is accept:'pdf', so a non-PDF here is a misconfig.
  if (m.mime_type !== 'application/pdf') return new Response('Gone', { status: 410 })
  if (!FILENAME_OK.test(m.filename_uuid)) return new Response('Gone', { status: 410 })

  const filePath = path.join(PATHS.brochures, `${m.filename_uuid}.pdf`)
  let stats
  try {
    stats = await stat(filePath)
  } catch {
    return new Response('Gone', { status: 410 })
  }
  if (stats.size > MAX_FILE_BYTES) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'deliver_file_oversized',
        media_id: payload.media_id,
        size_bytes: stats.size,
      }),
    )
    return new Response('Gone', { status: 410 })
  }

  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(stats.size),
      'content-disposition': `attachment; filename="${safeDownloadName(m.original_name)}"`,
      'accept-ranges': 'none',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
    },
  })
})
