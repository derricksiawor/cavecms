import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'

const IdParam = z.coerce.number().int().positive().max(2 ** 31 - 1)

// Restore a soft-deleted lead. Mirrors /api/cms/posts/[id]/restore +
// /api/cms/projects/[id]/restore. Refuses if the row was never
// soft-deleted (idempotency surface: a no-op 404 keeps the contract
// honest — "there's nothing here to restore").
export const POST = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const { id } = await params
    const leadId = IdParam.parse(id)
    const meta = auditMetaFromRequest(req)

    return db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT id, source, status FROM leads
        WHERE id = ${leadId} AND deleted_at IS NOT NULL
        FOR UPDATE
      `)) as unknown as [
        Array<{ id: number; source: string; status: string }>,
      ]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const row = rows[0]

      await tx.execute(sql`
        UPDATE leads SET deleted_at = NULL WHERE id = ${leadId}
      `)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'restore',
        resourceType: 'lead',
        resourceId: String(leadId),
        diff: { source: row.source, status: row.status } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      })
    })
  },
)
