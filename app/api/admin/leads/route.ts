import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import {
  parseCreatedAtIdCursor,
  formatCreatedAtIdCursor,
} from '@/lib/api/cursor'
import { maskLead } from '@/lib/leads/mask'

// Cursor format `<iso-created-at>_<id>` is parsed via the shared
// helper in lib/api/cursor.ts so the format invariant + length cap +
// validation rules live in one place across all admin endpoints.
// The (created_at, id) keyset matches the idx_leads_source_status_-
// created index suffix — pagination scans only the rows past the
// cursor instead of OFFSET-skipping prior pages.
const Query = z.object({
  source: z.enum(['contact', 'brochure', 'inquiry']).optional(),
  status: z.enum(['new', 'contacted', 'won', 'lost']).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // `trashed=1` flips the list from "active inbox" to "soft-deleted
  // recovery window" (`deleted_at IS NOT NULL AND > now - 30 days`).
  // Any other value treats the row as untrashed.
  trashed: z.enum(['0', '1']).optional(),
})

interface LeadRow {
  id: number
  source: string
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  status: string
  created_at: Date
  project_slug: string | null
  project_name: string | null
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  checkReadRate(ctx.userId)
  const url = new URL(req.url)
  const q = Query.parse(Object.fromEntries(url.searchParams))

  // Invalid cursors fall back to the first page rather than 400-ing
  // — a stale browser tab paginating against a list it cached
  // earlier shouldn't error. Shared parser rejects malformed input
  // (length > 60, non-positive id, drift-correcting Date strings).
  const parsedCursor = parseCreatedAtIdCursor(q.cursor)
  const createdBefore = parsedCursor?.beforeCreatedAt ?? null
  const idBefore = parsedCursor?.beforeId ?? null

  // Drizzle's sql tagged template supports conditional fragments via
  // sql.empty() / a chained sql`...` builder. Building WHERE clauses
  // by appending typed fragments keeps parameterization end-to-end —
  // no string concatenation, no manual binds. Cap LIMIT at 100 via
  // Zod; the +1 trick (limit+1) detects "more rows exist" without an
  // extra COUNT query.
  const showTrashed = q.trashed === '1'
  const conds: SQL[] = []
  if (showTrashed) {
    // Recovery window — soft-deleted within the last 30 days.
    // Matches the posts + content_blocks pattern; rows past the
    // window are out-of-scope for restore (a future cron purge will
    // hard-remove them).
    conds.push(sql`l.deleted_at IS NOT NULL`)
    conds.push(sql`l.deleted_at > NOW(3) - INTERVAL 30 DAY`)
  } else {
    conds.push(sql`l.deleted_at IS NULL`)
  }
  if (q.source) conds.push(sql`l.source = ${q.source}`)
  if (q.status) conds.push(sql`l.status = ${q.status}`)
  if (createdBefore !== null && idBefore !== null) {
    conds.push(sql`(l.created_at, l.id) < (${createdBefore}, ${idBefore})`)
  }
  const where = sql`WHERE ${sql.join(conds, sql` AND `)}`

  const limitPlus = q.limit + 1
  const [rows] = (await db.execute(sql`
    SELECT l.id, l.source, l.name, l.email, l.phone, l.message,
           l.status, l.created_at,
           p.slug AS project_slug, p.name AS project_name
    FROM leads l
    LEFT JOIN projects p ON p.id = l.project_id AND p.deleted_at IS NULL
    ${where}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limitPlus}
  `)) as unknown as [LeadRow[]]

  const hasMore = rows.length > q.limit
  const page = hasMore ? rows.slice(0, q.limit) : rows
  // Mask AFTER trim so the cursor (built from the last item) sees the
  // real created_at, not a masked stub.
  const last = page[page.length - 1]
  const nextCursor =
    hasMore && last
      ? formatCreatedAtIdCursor(last.created_at, last.id)
      : null

  const items = page.map((r) => maskLead(r, ctx.role))

  return new Response(JSON.stringify({ items, nextCursor }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
