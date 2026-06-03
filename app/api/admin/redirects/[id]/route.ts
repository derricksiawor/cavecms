import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { isDuplicateKey } from '@/lib/db/errors'
import { validateRedirect } from '@/lib/cms/redirects'

interface UpdateResult {
  affectedRows: number
}

// A PATCH is either a full edit (validated redirect fields) OR a lightweight
// toggle/reorder (enabled and/or position only). Discriminate on the keys.
const ToggleReorder = z
  .object({
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()

function parseId(idStr: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(idStr)) throw new HttpError(400, 'invalid_id')
  return Number(idStr)
}

export const PATCH = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const id = parseId((await params).id)
    const meta = auditMetaFromRequest(req)
    const raw = await readJsonBody(req)

    // Toggle/reorder fast path: body has ONLY enabled/position keys.
    const keys = Object.keys((raw ?? {}) as object)
    const isLight =
      keys.length > 0 && keys.every((k) => k === 'enabled' || k === 'position')
    if (isLight) {
      const t = ToggleReorder.parse(raw)
      await db.transaction(async (tx) => {
        const sets: ReturnType<typeof sql>[] = []
        if (t.enabled !== undefined) sets.push(sql`enabled = ${t.enabled ? 1 : 0}`)
        if (t.position !== undefined) sets.push(sql`position = ${t.position}`)
        if (sets.length === 0) throw new HttpError(400, 'nothing_to_update')
        const [res] = (await tx.execute(
          sql`UPDATE redirects SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`,
        )) as unknown as [UpdateResult]
        if (!res.affectedRows) throw new HttpError(404, 'not_found')
        await tx.insert(auditLog).values({
          userId: ctx.userId,
          action: 'redirect_update',
          resourceType: 'redirect',
          resourceId: String(id),
          diff: t as unknown as object,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        })
      })
      return new Response(null, {
        status: 204,
        headers: { 'cache-control': 'private, no-store' },
      })
    }

    // Full edit.
    const v = validateRedirect(raw)
    if (!v.ok) throw new HttpError(400, v.error)
    const r = v.value
    try {
      await db.transaction(async (tx) => {
        const [res] = (await tx.execute(sql`
          UPDATE redirects SET
            source = ${r.source}, match_type = ${r.matchType}, action = ${r.action},
            target = ${r.action === 'gone' ? null : r.target},
            status_code = ${r.action === 'gone' ? null : r.statusCode},
            query_handling = ${r.queryHandling},
            case_insensitive = ${r.caseInsensitive ? 1 : 0},
            enabled = ${r.enabled ? 1 : 0}, notes = ${r.notes ?? null}
          WHERE id = ${id}
        `)) as unknown as [UpdateResult]
        if (!res.affectedRows) throw new HttpError(404, 'not_found')
        await tx.insert(auditLog).values({
          userId: ctx.userId,
          action: 'redirect_update',
          resourceType: 'redirect',
          resourceId: String(id),
          diff: { source: r.source, matchType: r.matchType, target: r.target } as unknown as object,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        })
      })
    } catch (err: unknown) {
      if (isDuplicateKey(err)) {
        throw new HttpError(409, 'A rule with this source and match type already exists')
      }
      throw err
    }
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    })
  },
)

export const DELETE = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const id = parseId((await params).id)
    const meta = auditMetaFromRequest(req)
    await db.transaction(async (tx) => {
      const [res] = (await tx.execute(
        sql`DELETE FROM redirects WHERE id = ${id}`,
      )) as unknown as [UpdateResult]
      if (!res.affectedRows) throw new HttpError(404, 'not_found')
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'redirect_delete',
        resourceType: 'redirect',
        resourceId: String(id),
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })
    })
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    })
  },
)
