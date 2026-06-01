import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { safeRevalidate } from '@/lib/cache/revalidate'

type RouteCtx = { params: Promise<{ id: string }> }

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Single-row lookup. The MediaPicker field in the edit drawer uses
// this to resolve a pre-set value's thumbnail without having to open
// the picker modal first (which is the only path that populates the
// in-memory thumb cache in MediaPickerProvider). Pulls the same
// columns as the list endpoint so the consumer's shape is identical
// to one row out of the paginated list response.
export const GET = withError<RouteCtx>(async (_req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(adminPolicy('uploadMedia'))
  checkReadRate(ctx.userId)

  const [rows] = (await db.execute(sql`
    SELECT id, filename_uuid, mime_type, alt_text, width, height, byte_size, variants, created_at
    FROM media
    WHERE id = ${id} AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<Record<string, unknown>>]
  const row = rows[0]
  if (!row) throw new HttpError(404, 'not_found')

  // mysql2 hands JSON columns back as strings on raw SQL — parse the
  // variants column so consumers don't have to (mirrors the list
  // endpoint's normalisation).
  const item = {
    ...row,
    variants:
      typeof row['variants'] === 'string'
        ? JSON.parse(row['variants'] as string)
        : row['variants'],
  }
  return new Response(JSON.stringify(item), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})

// Soft-delete a media row. Refuses (409 still_referenced) while ANY row
// in media_references still points at it — the defense against dangling
// pointers happens here, not in a sweeper. Locked SELECT + recheck inside
// the TX prevents the TOCTOU window of "another writer just removed the
// last ref before our DELETE".
//
// Admin only — editors can upload but not delete (matches master spec
// §4.3 admin/editor RBAC).
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'media', 'delete')
  checkCmsMutationRate(ctx)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  return db.transaction(async (tx) => {
    // Lock the media row first — guarantees the ref check below sees a
    // consistent picture across the read-then-write window.
    const [mediaRows] = (await tx.execute(sql`
      SELECT id FROM media WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE
    `)) as unknown as [Array<{ id: number }>]
    if (mediaRows.length === 0) throw new HttpError(404, 'not_found')

    // Surface up to 10 referent rows so the admin tool can show "what's
    // blocking this delete?" instead of a bare 409. Capped to keep the
    // response bounded; full list lives in the table.
    const [refRows] = (await tx.execute(sql`
      SELECT referent_type, referent_id, field
      FROM media_references
      WHERE media_id = ${id}
      LIMIT 10
      FOR UPDATE
    `)) as unknown as [
      Array<{ referent_type: string; referent_id: number; field: string }>,
    ]
    if (refRows.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'still_referenced',
          references: refRows,
        }),
        {
          status: 409,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          },
        },
      )
    }

    await tx.execute(sql`UPDATE media SET deleted_at = NOW(3) WHERE id = ${id}`)
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'delete',
      resourceType: 'media',
      resourceId: String(id),
      diff: { kind: AUDIT_KIND.delete } as unknown as object,
      ip,
      userAgent,
      requestId,
    })
    // Bust the resolveMedia cache so SiteHeader/SiteFooter pick up
    // the soft-delete on the next render — otherwise a stale logo
    // would keep rendering for up to the 60s TTL.
    safeRevalidate(['media'])
    return new Response(null, { status: 204 })
  })
})
