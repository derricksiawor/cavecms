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
import { maskNewsletterEmail } from '@/lib/leads/mask'

// Cursor format `<iso-created-at>_<id>` reused from the leads endpoint —
// keyset pagination over (created_at, id) DESC matches the implicit
// scan order the unique idx_newsletter_email leaves on the table when
// no covering index exists. ~10k rows max is well inside that bound.
const Query = z.object({
  status: z
    .enum(['active', 'unsubscribed', 'pending_confirmation'])
    .optional(),
  // Email PREFIX search ("starts with"). Anchored at the front so the
  // query plan uses the unique idx_newsletter_email B-tree index
  // (`LIKE 'foo%'` is sargable; `LIKE '%foo%'` is not and forces a
  // full table scan on every keystroke from the debounced client).
  // Caller validates max-180 to match the column width; we escape
  // LIKE wildcards (% _) defensively so a user typing "%" doesn't
  // widen the predicate beyond their intent.
  search: z.string().max(180).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

interface SubscriberRow {
  id: number
  email: string
  status: string
  source: string | null
  created_at: Date
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin', 'editor', 'viewer'])
  checkReadRate(ctx.userId)
  const url = new URL(req.url)
  const q = Query.parse(Object.fromEntries(url.searchParams))

  const parsedCursor = parseCreatedAtIdCursor(q.cursor)
  const createdBefore = parsedCursor?.beforeCreatedAt ?? null
  const idBefore = parsedCursor?.beforeId ?? null

  // SOFT-DELETE INVARIANT: newsletter_subscribers has no `deleted_at`
  // column (unsubscribe is the terminal state). If a future migration
  // adds soft-delete, every WHERE in this file AND in [id]/route.ts
  // AND in export/route.ts must gain a `deleted_at IS NULL` predicate
  // — otherwise soft-deleted rows reappear here, in the detail PATCH,
  // and in the CSV export.
  const conds: SQL[] = []
  if (q.status) conds.push(sql`status = ${q.status}`)
  if (q.search && q.search.trim().length > 0) {
    const needle = escapeLike(q.search.trim()) + '%'
    conds.push(sql`email LIKE ${needle} ESCAPE '\\'`)
  }
  if (createdBefore !== null && idBefore !== null) {
    conds.push(sql`(created_at, id) < (${createdBefore}, ${idBefore})`)
  }
  const where =
    conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``

  const limitPlus = q.limit + 1
  const [rows] = (await db.execute(sql`
    SELECT id, email, status, source, created_at
    FROM newsletter_subscribers
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limitPlus}
  `)) as unknown as [SubscriberRow[]]

  const hasMore = rows.length > q.limit
  const page = hasMore ? rows.slice(0, q.limit) : rows
  const last = page[page.length - 1]
  const nextCursor =
    hasMore && last
      ? formatCreatedAtIdCursor(last.created_at, last.id)
      : null

  // Viewer-role masking: only the email column carries PII on this
  // table (no name/phone/message), so we masquerade just that one
  // field. Admin + editor see the raw address.
  const items = page.map((r) => ({
    ...r,
    email: maskNewsletterEmail(r.email, ctx.role),
  }))

  return new Response(JSON.stringify({ items, nextCursor }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
