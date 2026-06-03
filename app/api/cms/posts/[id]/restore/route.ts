import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForPostRestore } from '@/lib/cache/tags'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'

// Restore a soft-deleted post. Mirrors
// /api/cms/projects/[id]/restore — clears deleted_at, restores the row
// in an UNPUBLISHED state (admin must explicitly re-publish), runs the
// slug-collision guard, audits, busts caches.
//
// Why unpublished-on-restore: a post that was trashed for content
// reasons shouldn't pop back live on the public blog just because
// someone clicked Restore. The publish toggle stays as an explicit
// "back on the live site" gesture.

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
      SELECT id, slug, version, body_page_id
      FROM posts
      WHERE id = ${id} AND deleted_at IS NOT NULL
      FOR UPDATE
    `)) as unknown as [
      Array<{
        id: number
        slug: string
        version: number
        body_page_id: number | null
      }>,
    ]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    // Slug collision: a different post may have claimed this slug
    // while the row sat in trash. The operator must rename one before
    // restore — refuse with 409 rather than silently overwrite or
    // produce a duplicate-slug ranking conflict on the public blog.
    const [collision] = (await tx.execute(sql`
      SELECT id FROM posts
      WHERE slug = ${row.slug}
        AND deleted_at IS NULL
        AND id <> ${id}
      LIMIT 1
    `)) as unknown as [Array<{ id: number }>]
    if (collision.length > 0) {
      throw new HttpError(409, 'slug_taken')
    }

    await tx.execute(sql`
      UPDATE posts
      SET deleted_at = NULL,
          published = FALSE,
          version = version + 1,
          updated_by = ${ctx.userId}
      WHERE id = ${id}
    `)

    // Restore the hidden body page in lockstep (spec §4.5) so its block
    // tree becomes editable again the moment the post is restored. Scoped
    // to kind='post_body' as defence in depth. preview_epoch bump keeps
    // the body page's epoch monotonic across the trash→restore cycle.
    if (row.body_page_id !== null) {
      await tx.execute(sql`
        UPDATE pages
        SET deleted_at = NULL,
            preview_epoch = preview_epoch + 1,
            updated_by = ${ctx.userId}
        WHERE id = ${row.body_page_id}
          AND kind = 'post_body'
      `)
    }

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'restore',
      resourceType: 'post',
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

    const tags = tagsForPostRestore(row.slug).tags
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
