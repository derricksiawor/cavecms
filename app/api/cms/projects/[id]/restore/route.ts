import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForProjectRestore } from '@/lib/cache/tags'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'

// Restore a soft-deleted project. Inverse of DELETE
// /api/cms/projects/[id]: clears deleted_at, bumps preview_epoch (so any
// preview tokens minted against the archived version refuse), audits the
// action, and revalidates the same tag set the archive flow touched.
// Restored projects come back UNPUBLISHED — the publish toggle is the
// operator's explicit "back on the live site" gesture, independent from
// restore (avoids accidentally re-exposing a project that was archived
// because of an issue with its content).

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

  const txResult = await db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, slug, version
      FROM projects
      WHERE id = ${id} AND deleted_at IS NOT NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    // Slug-uniqueness check. A different project could have claimed the
    // archived project's slug while it was in trash (since deleted rows
    // are exempted from the live slug check at create-time). Refuse the
    // restore in that case — the operator must rename one of them first.
    const [collision] = (await tx.execute(sql`
      SELECT id FROM projects
      WHERE slug = ${row.slug}
        AND deleted_at IS NULL
        AND id <> ${id}
      LIMIT 1
    `)) as unknown as [Array<{ id: number }>]
    if (collision.length > 0) {
      throw new HttpError(409, 'slug_taken')
    }

    await tx.execute(sql`
      UPDATE projects
      SET deleted_at = NULL,
          published = FALSE,
          preview_epoch = preview_epoch + 1,
          version = version + 1,
          updated_by = ${ctx.userId}
      WHERE id = ${id}
    `)

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'restore',
      resourceType: 'project',
      resourceId: String(id),
      diff: {
        kind: AUDIT_KIND.restore,
        slug: row.slug,
        from_version: row.version,
      } as unknown as object,
      ip,
      userAgent,
      requestId,
    })

    // Symmetric with the soft-delete invalidation so the bar's
    // Edit link reappears immediately after restore.
    const tags = tagsForProjectRestore(row.slug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { newVersion: row.version + 1, queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(
    JSON.stringify({ restored: true, version: txResult.newVersion }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    },
  )
})
