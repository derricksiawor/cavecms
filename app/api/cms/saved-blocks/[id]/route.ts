import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate, checkReadRate } from '@/lib/auth/cmsRateLimit'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import type { SavedBlockDetail } from '@/lib/cms/savedBlocks'

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

interface SavedBlockRow {
  id: number
  name: string
  blockType: string
  data: unknown
  meta: unknown
  createdAt: Date | string
}

// GET /api/cms/saved-blocks/[id]
// Fetch one saved block by id WITH its full data + meta payload (the
// list endpoint omits these to keep the panel-load roundtrip small).
//
// Ownership: a row belonging to a different user surfaces as 404
// not_found — NOT 403. The discrimination would let a probing operator
// enumerate the existence of other users' saved-block ids.
export const GET = withError<{ params: Promise<{ id: string }> }>(
  async (_req, { params }) => {
    const { id: rawId } = await params
    if (!ID_PATTERN.test(rawId)) throw new HttpError(400, 'invalid_id')
    const id = Number(rawId)

    const ctx = await requireRole(['admin', 'editor'])
    checkReadRate(ctx.userId)
    requireScope(ctx, 'blocks', 'read')

    const [rows] = (await db.execute(sql`
      SELECT id, name, block_type AS blockType, data, meta, created_at AS createdAt
      FROM saved_blocks
      WHERE id = ${id} AND user_id = ${ctx.userId}
      LIMIT 1
    `)) as unknown as [SavedBlockRow[]]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')

    const detail: SavedBlockDetail = {
      id: row.id,
      name: row.name,
      blockType: row.blockType,
      data: row.data,
      meta: row.meta,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
    }

    return new Response(JSON.stringify(detail), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  },
)

// DELETE /api/cms/saved-blocks/[id]
// Hard-delete (no soft-delete in V1 — the operator can re-save anytime
// from the source widget, and a soft-delete tier would clutter the
// library with tombstones the panel would have to filter). Same 404-
// for-not-owned semantics as GET so id enumeration is closed.
export const DELETE = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const { id: rawId } = await params
    if (!ID_PATTERN.test(rawId)) throw new HttpError(400, 'invalid_id')
    const id = Number(rawId)

    const ctx = await requireRole(['admin', 'editor'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    // Hard (irreversible) delete of a saved-block library row → delete rank,
    // not write. A token scoped only blocks:write must not destroy rows.
    requireScope(ctx, 'blocks', 'delete')
    checkCmsMutationRate(ctx)

    const headerObj: Record<string, string | undefined> = {}
    req.headers.forEach((v, k) => {
      headerObj[k] = v
    })
    const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
    const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
    const requestId = getRequestId(req)

    const deleted = await db.transaction(async (tx) => {
      // SELECT FOR UPDATE pins the row against a concurrent DELETE so a
      // double-click can't race two DELETE TXs to the audit log layer
      // (the second TX would see 0 affected rows and the audit would
      // claim a delete that didn't happen).
      const [rows] = (await tx.execute(sql`
        SELECT id, name, block_type AS blockType
        FROM saved_blocks
        WHERE id = ${id} AND user_id = ${ctx.userId}
        FOR UPDATE
      `)) as unknown as [
        Array<{ id: number; name: string; blockType: string }>,
      ]
      const row = rows[0]
      if (!row) return null

      await tx.execute(sql`
        DELETE FROM saved_blocks
        WHERE id = ${id} AND user_id = ${ctx.userId}
      `)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'delete',
        resourceType: 'saved_block',
        resourceId: String(id),
        diff: {
          kind: AUDIT_KIND.savedBlockDelete,
          block_type: row.blockType,
          name: row.name,
        },
        ip,
        userAgent,
        requestId,
      })

      return row
    })

    if (deleted === null) throw new HttpError(404, 'not_found')

    return new Response(null, {
      status: 200,
      headers: { 'cache-control': 'private, no-store' },
    })
  },
)
