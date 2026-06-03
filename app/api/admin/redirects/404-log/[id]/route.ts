import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'

interface DelResult {
  affectedRows: number
}

export const DELETE = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const idStr = (await params).id
    if (!/^[1-9][0-9]{0,9}$/.test(idStr)) throw new HttpError(400, 'invalid_id')
    const [res] = (await db.execute(
      sql`DELETE FROM not_found_log WHERE id = ${Number(idStr)}`,
    )) as unknown as [DelResult]
    if (!res.affectedRows) throw new HttpError(404, 'not_found')
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    })
  },
)
