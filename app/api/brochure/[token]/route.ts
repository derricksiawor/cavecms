import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { verifyBrochureToken } from '@/lib/auth/brochureToken'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { PATHS } from '@/lib/media/storage'

// Filename charset for the on-disk lookup. media.filename_uuid is
// assigned by the upload pipeline and is always [A-Za-z0-9._-]; the
// regex here is belt-and-braces against a hypothetical INSERT bypass
// that wrote `..` or `/` into the column. Mismatch → 410, never read
// the file.
const FILENAME_OK = /^[A-Za-z0-9._-]{1,80}$/

// Upper bound on brochure file size. A misconfigured 2GB PDF stream
// burns bandwidth on every redemption (cache-control: no-store, so
// CDN won't help). 50MB is generous for a typical sales brochure
// and well under any legitimate use.
const MAX_BROCHURE_BYTES = 50 * 1024 * 1024

// Per-IP rate-limit on brochure attempts. Each invalid token is at
// minimum a DB SELECT and a hot-path string parse + HMAC. A single
// IP probing /api/brochure/<random> for hours would otherwise be
// uncapped. 30 attempts per minute is generous for a real user
// (typical UX: open one email link, maybe retry on flaky network)
// and tight enough to cap fuzz attacks.
const limit = rateLimit('brochure:ip', { limit: 30, windowSec: 60 })

type RouteCtx = { params: Promise<{ token: string }> }

// Signed-token brochure download. Defense ordered cheapest-first so
// adversarial probes pay minimum:
//
//   1. Rate limit per IP — drops floods before token verification.
//   2. verifyBrochureToken: HMAC + exp check on a base64url payload.
//      Length-capped to defend against multi-MB tokens.
//   3. SELECT the project's brochure_pdf_id + filename. If the
//      project is unpublished / soft-deleted, or the media row is
//      soft-deleted, return 410 WITHOUT consuming the token.
//   4. Atomic CAS on leads.brochure_token_used_at. Marks the lead's
//      token consumed ONLY now that we know we can actually serve
//      the file. Zero affected rows = already-redeemed → 410. The
//      single-use semantics live HERE, not in the token.
//   5. stat() the file; refuse if missing or oversized. The stat
//      happens after CAS so a missing file does burn the token —
//      acceptable because the project's brochure_pdf_id is admin-
//      controlled and a missing file is an operator misconfiguration
//      the user can't retry around.
//
// cache-control: private, no-store + x-robots-tag noindex + no
// accept-ranges so a brochure never reaches a CDN, search index, or
// retry-via-Range-request that would race the CAS.
export const GET = withError<RouteCtx>(async (req, { params }) => {
  const { token } = await params

  // Cheap IP guard before any crypto.
  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: {
        'cache-control': 'private, no-store',
        'retry-after': '60',
      },
    })
  }

  const payload = verifyBrochureToken(token)
  if (!payload) return new Response('Gone', { status: 410 })

  // Resolve the project + media row BEFORE consuming the token. If
  // the PDF is missing (unpublished project, soft-deleted media,
  // bad config), we return 410 without burning the lead's single
  // attempt — user can request a new one.
  const [rows] = (await db.execute(sql`
    SELECT m.filename_uuid
    FROM projects p
    JOIN media m ON m.id = p.brochure_pdf_id
    WHERE p.id = ${payload.project_id}
      AND p.published = TRUE
      AND p.deleted_at IS NULL
      AND m.deleted_at IS NULL
  `)) as unknown as [Array<{ filename_uuid: string }>]
  const m = rows[0]
  if (!m) return new Response('Gone', { status: 410 })
  if (!FILENAME_OK.test(m.filename_uuid)) {
    return new Response('Gone', { status: 410 })
  }

  // Atomic CAS — only now that we know we can serve. Concurrent
  // double-click on the email link races here; MySQL guarantees
  // exactly one UPDATE matches.
  const [updateResult] = (await db.execute(sql`
    UPDATE leads
    SET brochure_token_used_at = NOW(3)
    WHERE id = ${payload.lead_id}
      AND source = 'brochure'
      AND project_id = ${payload.project_id}
      AND brochure_token_used_at IS NULL
  `)) as unknown as [{ affectedRows: number }]
  if (updateResult.affectedRows === 0) {
    return new Response('Gone', { status: 410 })
  }

  const filePath = path.join(PATHS.brochures, `${m.filename_uuid}.pdf`)
  let stats
  try {
    stats = await stat(filePath)
  } catch {
    // File missing on disk (storage drift, accidental rm). Token
    // was already consumed above — operator fix required. Return
    // 410 so the user gets a clean message; admin tooling
    // (Plan 09 media-verify cron) surfaces the orphaned row.
    return new Response('Gone', { status: 410 })
  }
  if (stats.size > MAX_BROCHURE_BYTES) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'brochure_oversized',
        project_id: payload.project_id,
        size_bytes: stats.size,
        filename: m.filename_uuid,
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
      'content-disposition': 'attachment; filename="brochure.pdf"',
      // accept-ranges: none discourages PDF viewers from retrying
      // with Range against an already-consumed token.
      'accept-ranges': 'none',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
    },
  })
})
