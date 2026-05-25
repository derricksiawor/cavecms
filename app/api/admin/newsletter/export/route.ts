import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkExportRate } from '@/lib/auth/cmsRateLimit'
import { env } from '@/lib/env'

// Streamed CSV export of newsletter subscribers — Admin and Editor
// only (viewer's list rows already mask the email, so a CSV would
// leak the raw addresses the viewer never had API access to). A
// viewer who hits the URL directly gets a 302 back to the list
// surface so the export endpoint doesn't 403-confirm the JSON shape
// of an admin-only resource.
//
// CSV-injection + UTF-8 BOM + keyset-batched streaming all match the
// leads export route (see app/api/admin/leads/export/route.ts for the
// long-form rationale).
//
// SOFT-DELETE INVARIANT: newsletter_subscribers has no `deleted_at`
// column. If a future migration adds one, this query must gain a
// `deleted_at IS NULL` predicate too (and the list + PATCH routes).

const BATCH_SIZE = 1000
const PREFIX = /^[=+\-@\t\r\n]/

const Query = z.object({
  status: z
    .enum(['active', 'unsubscribed', 'pending_confirmation'])
    .optional(),
})

function cell(v: unknown): string {
  if (v == null) return ''
  const s = v instanceof Date ? v.toISOString() : String(v)
  const safe = PREFIX.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

interface ExportRow {
  id: number
  email: string
  status: string
  source: string | null
  created_at: Date
}

const HEADER = 'id,email,status,source,created_at\n'

function formatRow(r: ExportRow): string {
  return (
    [r.id, r.email, r.status, r.source, r.created_at]
      .map(cell)
      .join(',') + '\n'
  )
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  if (ctx.role === 'viewer') {
    return new Response(null, {
      status: 302,
      headers: { location: '/admin/leads/newsletter' },
    })
  }
  checkExportRate(ctx.userId)
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams))

  const MAX_ROWS = env.NEWSLETTER_EXPORT_MAX_ROWS

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      try {
        // UTF-8 BOM (U+FEFF) for Excel encoding auto-detection on
        // Windows en-US. Escape form so editors / linters that strip
        // zero-width characters can't accidentally drop the byte.
        controller.enqueue(enc.encode('\ufeff'))
        controller.enqueue(enc.encode(HEADER))

        let lastCreatedAt: Date | null = null
        let lastId: number | null = null
        let total = 0

        for (;;) {
          const remaining = MAX_ROWS - total
          if (remaining <= 0) break
          const batchLimit = Math.min(BATCH_SIZE, remaining)

          const conds: SQL[] = []
          if (q.status) conds.push(sql`status = ${q.status}`)
          if (lastCreatedAt !== null) {
            conds.push(
              sql`(created_at, id) < (${lastCreatedAt}, ${lastId})`,
            )
          }
          const where =
            conds.length > 0
              ? sql`WHERE ${sql.join(conds, sql` AND `)}`
              : sql``

          const [rows] = (await db.execute(sql`
            SELECT id, email, status, source, created_at
            FROM newsletter_subscribers
            ${where}
            ORDER BY created_at DESC, id DESC
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

          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })

  const today = new Date().toISOString().slice(0, 10)
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="cavecms-newsletter-${today}.csv"`,
      'x-accel-buffering': 'no',
      'cache-control': 'private, no-store',
    },
  })
})
