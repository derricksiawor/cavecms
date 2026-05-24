import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

// Mark an unresolved notification_failures row as resolved. Admin-only.
// Sets resolved_at = NOW(3), which removes the row from the live alerts
// feed (GET /api/admin/alerts filters on resolved_at IS NULL) but keeps
// it in the table for forensic lookup. The cron-purge sweeps resolved
// rows after NOTIFICATION_FAILURES_RETENTION_DAYS.
//
// No state inspection: the operator's "mark resolved" gesture is the
// human decision that the underlying issue is no longer worth alerting
// on. If the issue re-occurs the failing path will INSERT a fresh row
// (notification_failures is append-only in normal flow).

type RouteCtx = { params: Promise<{ id: string }> }

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, kind FROM notification_failures
      WHERE id = ${id} AND resolved_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; kind: string }>]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    await tx.execute(sql`
      UPDATE notification_failures
      SET resolved_at = NOW(3)
      WHERE id = ${id}
    `)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'resolve',
      resourceType: 'notification_failure',
      resourceId: String(id),
      diff: { kind: row.kind } as unknown as object,
      ip,
      userAgent,
      requestId,
    })
  })

  // Canonical success shape `{ ok: true }` — matches every other
  // admin mutation endpoint. ActivityClient only reads `res.ok` so
  // the rename is consumer-safe.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
