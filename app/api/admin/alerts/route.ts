import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { parseIdCursor, formatIdCursor } from '@/lib/api/cursor'

// Operator-facing alerts: unresolved rows in notification_failures.
// Grouped by `kind` so a dashboard card can deep-link with a filter
// (e.g. ?kind=smtp surfaces only email-pipeline alarms). Resolved
// rows are excluded because retried/cleared events shouldn't clutter
// the operator's view — they exist in the table for forensic lookups
// but the live alerts feed is "what currently needs attention".
const KIND_GROUPS: Record<string, ReadonlyArray<string>> = {
  smtp: ['smtp_send', 'smtp_breaker_open', 'lead_email_enqueue_failed'],
  revalidate: ['revalidate_pending', 'revalidate_failed'],
  recaptcha: ['recaptcha_degraded'],
  rbac: ['rbac_field_reject'],
  hydrate: ['hydrate_block_parse_failed', 'hydrate_project_section_parse_failed'],
  runtime: ['unhandled_rejection'],
  crm: ['crm_dispatch_failed'],
}

const Query = z.object({
  kind: z
    .string()
    .max(40)
    .regex(/^[a-z_]+$/i, 'invalid_kind')
    .optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

interface AlertRow {
  id: number
  kind: string
  ref_table: string | null
  ref_id: number | null
  payload: unknown
  attempts: number
  last_error: string | null
  next_retry_at: Date | null
  created_at: Date
}

export const GET = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const sp = Object.fromEntries(new URL(req.url).searchParams)
  const q = Query.parse(sp)
  const beforeId = parseIdCursor(q.cursor)?.beforeId ?? null

  const conds: SQL[] = [sql`resolved_at IS NULL`]
  if (q.kind) {
    // Group filter ("smtp" → IN ('smtp_send', ...)) OR exact match
    // (a literal kind value passed by deep link / test).
    const group = KIND_GROUPS[q.kind]
    if (group) {
      conds.push(sql`kind IN (${sql.join(group.map((k) => sql`${k}`), sql`,`)})`)
    } else {
      conds.push(sql`kind = ${q.kind}`)
    }
  }
  if (beforeId !== null) conds.push(sql`id < ${beforeId}`)
  const where = sql`WHERE ${sql.join(conds, sql` AND `)}`

  const limitPlus = q.limit + 1
  const [rows] = (await db.execute(sql`
    SELECT id, kind, ref_table, ref_id, payload, attempts,
           last_error, next_retry_at, created_at
    FROM notification_failures
    ${where}
    ORDER BY id DESC
    LIMIT ${limitPlus}
  `)) as unknown as [AlertRow[]]

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
