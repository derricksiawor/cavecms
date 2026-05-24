import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { parseIdCursor, formatIdCursor } from '@/lib/api/cursor'

const Query = z.object({
  resource_type: z
    .string()
    .max(40)
    .regex(/^[a-z_]+$/i, 'invalid_resource_type')
    .optional(),
  action: z
    .string()
    .max(40)
    .regex(/^[a-z_]+$/i, 'invalid_action')
    .optional(),
  // Validated via the shared parseIdCursor helper below — keep the
  // schema lenient here (just bound length) and let the helper own
  // shape + numeric range.
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

interface AuditRow {
  id: number
  user_id: number | null
  user_email: string | null
  action: string
  resource_type: string
  resource_id: string | null
  diff: unknown
  created_at: Date
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const sp = Object.fromEntries(new URL(req.url).searchParams)
  const q = Query.parse(sp)
  const beforeId = parseIdCursor(q.cursor)?.beforeId ?? null

  const conds: SQL[] = []
  if (q.resource_type) conds.push(sql`a.resource_type = ${q.resource_type}`)
  if (q.action) conds.push(sql`a.action = ${q.action}`)
  if (beforeId !== null) conds.push(sql`a.id < ${beforeId}`)
  const where =
    conds.length === 0 ? sql`` : sql`WHERE ${sql.join(conds, sql` AND `)}`

  const limitPlus = q.limit + 1
  const [rows] = (await db.execute(sql`
    SELECT a.id, a.user_id, u.email AS user_email,
           a.action, a.resource_type, a.resource_id,
           a.diff, a.created_at
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.id DESC
    LIMIT ${limitPlus}
  `)) as unknown as [AuditRow[]]

  const hasMore = rows.length > q.limit
  const page = hasMore ? rows.slice(0, q.limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? formatIdCursor(last.id) : null

  return new Response(JSON.stringify({ items: page, nextCursor }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
