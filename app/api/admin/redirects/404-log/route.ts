import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'

interface LogRow {
  id: number
  path: string
  hits: number
  last_seen_at: string
  referrer: string | null
}

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const [rows] = (await db.execute(sql`
    SELECT id, path, hits, last_seen_at, referrer
    FROM not_found_log
    ORDER BY last_seen_at DESC
    LIMIT 500
  `)) as unknown as [LogRow[]]
  return new Response(JSON.stringify({ items: rows }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
