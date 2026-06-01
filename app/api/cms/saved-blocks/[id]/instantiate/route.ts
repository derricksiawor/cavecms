import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import {
  blockSchemas,
  FIXED_BLOCK_KEYS_PER_PAGE,
} from '@/lib/cms/block-registry'
import { WidgetMetaSchema, type BlockKind } from '@/lib/cms/blockMeta'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import { respaceParent } from '@/app/api/cms/blocks/route'
import { SavedBlockInstantiateBody } from '@/lib/cms/savedBlocks'

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

interface SavedBlockRow {
  id: number
  block_type: string
  data: unknown
  meta: unknown
}

interface ParentRow {
  id: number
  kind: BlockKind
  page_id: number
}

interface InsertResult {
  insertId: number
}

// POST /api/cms/saved-blocks/[id]/instantiate
// Paste a library row into a page. Mirrors the position-bisect +
// fixed-slot + parent-validation contract of POST /api/cms/blocks
// (same lock order, same auto-respace on gap exhaustion) so the paste
// gesture is indistinguishable from an inline add at the position-
// integrity layer.
//
// Re-validates data + meta at the paste boundary even though they
// were validated at create time — a deploy that tightened a Zod gate
// between save + paste would otherwise commit currently-invalid rows.
// Failure surfaces as 422 invalid_saved_block so the FE can present
// a clear "this saved block is no longer valid; delete + recreate"
// path rather than a generic invalid_request.
export const POST = withError<{ params: Promise<{ id: string }> }>(
  async (req, { params }) => {
    const { id: rawId } = await params
    if (!ID_PATTERN.test(rawId)) throw new HttpError(400, 'invalid_id')
    const savedBlockId = Number(rawId)

    const ctx = await requireRole(['admin', 'editor'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    requireScope(ctx, 'blocks', 'write')
    checkCmsMutationRate(ctx)

    const body = SavedBlockInstantiateBody.parse(await readJsonBody(req))

    if (body.afterBlockId !== undefined && body.beforeBlockId !== undefined) {
      throw new HttpError(400, 'after_and_before_are_mutually_exclusive')
    }

    const parentId: number | null =
      typeof body.parentId === 'number' ? body.parentId : null

    // Step 1: load the saved row outside the TX. Ownership check —
    // not-found AND not-owned both surface as 404 to close enumeration.
    const [savedRows] = (await db.execute(sql`
      SELECT id, block_type, data, meta
      FROM saved_blocks
      WHERE id = ${savedBlockId} AND user_id = ${ctx.userId}
      LIMIT 1
    `)) as unknown as [SavedBlockRow[]]
    const saved = savedRows[0]
    if (!saved) throw new HttpError(404, 'not_found')

    // Step 2: registry membership + re-validate at the paste boundary.
    // A schema-tightening deploy between save + paste could otherwise
    // commit currently-invalid data. Failure → 422 with a distinct code
    // so the FE can present "this saved block is no longer valid" copy
    // rather than the generic invalid_request.
    if (!(saved.block_type in blockSchemas)) {
      throw new HttpError(422, 'invalid_saved_block')
    }
    let parsedData: unknown
    try {
      parsedData = parseAndSanitize(saved.block_type, saved.data)
    } catch {
      throw new HttpError(422, 'invalid_saved_block')
    }

    // Re-validate meta. The saved row already had htmlId stripped at
    // create time but defence-in-depth: strip again before WidgetMetaSchema.
    let widgetMetaJson: string | null = null
    if (saved.meta !== null && saved.meta !== undefined) {
      const metaObj =
        typeof saved.meta === 'object' && !Array.isArray(saved.meta)
          ? { ...(saved.meta as Record<string, unknown>) }
          : null
      if (metaObj !== null) {
        delete metaObj['htmlId']
        const result = WidgetMetaSchema.safeParse(metaObj)
        if (!result.success) {
          throw new HttpError(422, 'invalid_saved_block')
        }
        if (Object.keys(result.data).length > 0) {
          widgetMetaJson = JSON.stringify(result.data)
        }
      }
    }

    const headerObj: Record<string, string | undefined> = {}
    req.headers.forEach((v, k) => {
      headerObj[k] = v
    })
    const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
    const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
    const requestId = getRequestId(req)

    // mayRespace gates whether we lock pages FOR UPDATE — symmetric
    // with POST /api/cms/blocks. Tail-append never triggers a respace
    // so the weaker non-locking SELECT stays sufficient there.
    const mayRespace =
      typeof body.afterBlockId === 'number' ||
      typeof body.beforeBlockId === 'number'

    const txResult = await db.transaction(async (tx) => {
      // Page existence + slug for cache tags.
      const [pageRows] = mayRespace
        ? ((await tx.execute(sql`
            SELECT slug FROM pages
            WHERE id = ${body.pageId} AND deleted_at IS NULL
            FOR UPDATE
          `)) as unknown as [Array<{ slug: string }>])
        : ((await tx.execute(sql`
            SELECT slug FROM pages
            WHERE id = ${body.pageId} AND deleted_at IS NULL
          `)) as unknown as [Array<{ slug: string }>])
      const pageSlug = pageRows[0]?.slug
      if (!pageSlug) throw new HttpError(404, 'page_not_found')

      // Parent validation — widget MUST go under a column (or top-level
      // null for legacy loose-widget mode). Cross-page parents surface as
      // 404 to close enumeration.
      if (parentId !== null) {
        const [parentRows] = (await tx.execute(sql`
          SELECT id, kind, page_id
          FROM content_blocks
          WHERE id = ${parentId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [ParentRow[]]
        const parent = parentRows[0]
        if (!parent) throw new HttpError(404, 'parent_not_found')
        if (parent.page_id !== body.pageId) {
          throw new HttpError(404, 'parent_not_found')
        }
        if (parent.kind !== 'column') {
          throw new HttpError(400, 'widget_parent_must_be_column')
        }
      }

      // Fixed-slot guard. A saved widget whose block_type is reserved
      // for a fixed template slot on this page would render as a duplicate
      // alongside the page-template's own copy. Refuse with the same
      // 409 code POST /api/cms/blocks uses.
      const fixedTypesForPage = (FIXED_BLOCK_KEYS_PER_PAGE[pageSlug] ??
        []) as readonly string[]
      if (fixedTypesForPage.includes(saved.block_type)) {
        throw new HttpError(409, 'block_type_reserved_for_fixed_slot')
      }

      // Position bisect. Same algorithm as POST /api/cms/blocks's `bisect()`
      // closure — see app/api/cms/blocks/route.ts:402 for the rationale on
      // 1000-spacing + the auto-respace fallback. Duplicated here (vs
      // factored into a shared helper) to keep the saved-blocks paste
      // route self-contained and to avoid leaking unrelated container
      // creation surface into a widget-only paste path.
      const bisect = async (): Promise<number | null> => {
        if (typeof body.beforeBlockId === 'number') {
          const [siblings] = (await tx.execute(sql`
            SELECT id, position
            FROM content_blocks
            WHERE page_id = ${body.pageId}
              AND deleted_at IS NULL
              AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
            ORDER BY position
          `)) as unknown as [Array<{ id: number; position: number }>]
          const idx = siblings.findIndex((r) => r.id === body.beforeBlockId)
          if (idx === 0) {
            const p = Math.floor(siblings[0]!.position / 2)
            if (p < 1 || p >= siblings[0]!.position) return null
            return p
          }
          if (idx > 0) {
            const p = Math.floor(
              (siblings[idx - 1]!.position + siblings[idx]!.position) / 2,
            )
            if (
              p <= siblings[idx - 1]!.position ||
              p >= siblings[idx]!.position
            ) {
              return null
            }
            return p
          }
          const [maxRows] = (await tx.execute(sql`
            SELECT COALESCE(MAX(position), 0) AS maxPos
            FROM content_blocks
            WHERE page_id = ${body.pageId}
              AND deleted_at IS NULL
              AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
          `)) as unknown as [Array<{ maxPos: number }>]
          return Number(maxRows[0]?.maxPos ?? 0) + 1000
        }
        if (typeof body.afterBlockId === 'number') {
          const [siblings] = (await tx.execute(sql`
            SELECT id, position
            FROM content_blocks
            WHERE page_id = ${body.pageId}
              AND deleted_at IS NULL
              AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
            ORDER BY position
          `)) as unknown as [Array<{ id: number; position: number }>]
          const idx = siblings.findIndex((r) => r.id === body.afterBlockId)
          if (idx >= 0 && idx < siblings.length - 1) {
            const p = Math.floor(
              (siblings[idx]!.position + siblings[idx + 1]!.position) / 2,
            )
            if (
              p <= siblings[idx]!.position ||
              p >= siblings[idx + 1]!.position
            ) {
              return null
            }
            return p
          }
          if (idx >= 0) {
            return siblings[idx]!.position + 1000
          }
          const [maxRows] = (await tx.execute(sql`
            SELECT COALESCE(MAX(position), 0) AS maxPos
            FROM content_blocks
            WHERE page_id = ${body.pageId}
              AND deleted_at IS NULL
              AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
          `)) as unknown as [Array<{ maxPos: number }>]
          return Number(maxRows[0]?.maxPos ?? 0) + 1000
        }
        const [maxRows] = (await tx.execute(sql`
          SELECT COALESCE(MAX(position), 0) AS maxPos
          FROM content_blocks
          WHERE page_id = ${body.pageId}
            AND deleted_at IS NULL
            AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
        `)) as unknown as [Array<{ maxPos: number }>]
        return Number(maxRows[0]?.maxPos ?? 0) + 1000
      }

      let nextPos: number | null = await bisect()
      if (nextPos === null) {
        await respaceParent(tx, parentId, body.pageId, ctx.userId)
        nextPos = await bisect()
        if (nextPos === null) {
          throw new HttpError(409, 'position_gap_exhausted')
        }
      }

      // INSERT. block_key stays NULL (freeform; saved blocks never
      // map to fixed slots — guarded above). kind='widget' is the only
      // legal value today (saved_blocks.kind ENUM has one entry).
      const [insertArr] = (await tx.execute(sql`
        INSERT INTO content_blocks
          (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
        VALUES (
          ${body.pageId},
          ${parentId},
          'widget',
          ${saved.block_type},
          ${nextPos},
          ${JSON.stringify(parsedData)},
          ${widgetMetaJson},
          0,
          ${ctx.userId}
        )
      `)) as unknown as [InsertResult]
      const blockId = Number(insertArr.insertId)

      // Media references — same pattern as POST /api/cms/blocks. Widget
      // data may carry media_id references that must be tracked so the
      // referenced media isn't pruned out from under the new row.
      const refs = collectMediaPaths(parsedData)
      const mediaIds = [...new Set(refs.map((r) => r.mediaId))]
      await assertMediaAvailable(tx, mediaIds)
      for (const r of refs) {
        await tx.execute(sql`
          INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
          VALUES (${r.mediaId}, 'content_block', ${blockId}, ${r.field})
        `)
      }

      // Audit. Two rows — one on the content_block (so the page's
      // forensic timeline shows the new row), one on the saved_block
      // (so the library's timeline shows the paste). Both in the same
      // TX as the INSERT so partial-commit can't ship one without the
      // other.
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'create',
        resourceType: 'content_block',
        resourceId: String(blockId),
        diff: {
          kind: AUDIT_KIND.savedBlockInstantiate,
          block_type: saved.block_type,
          saved_block_id: savedBlockId,
        },
        ip,
        userAgent,
        requestId,
      })
      await tx.insert(auditLog).values({
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        action: 'instantiate',
        resourceType: 'saved_block',
        resourceId: String(savedBlockId),
        diff: {
          kind: AUDIT_KIND.savedBlockInstantiate,
          block_type: saved.block_type,
          new_block_id: blockId,
          page_id: body.pageId,
        },
        ip,
        userAgent,
        requestId,
      })

      const tags = tagsForBlockSave(pageSlug, saved.block_type).tags
      const queueRowId = await enqueueRevalidate(tx, tags)
      return { blockId, queueRowId, tags, position: nextPos }
    })

    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId, txResult.tags)
    })

    return new Response(
      JSON.stringify({
        id: txResult.blockId,
        version: 0,
        position: txResult.position,
        parentId,
      }),
      {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      },
    )
  },
)
