import { z } from 'zod'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import {
  saveBlock,
  saveBlockMeta,
  StaleBlockVersionError,
  StalePageVersionError,
  NotFoundError,
  WrongKindError,
  InvalidMetaJsonError,
} from '@/lib/cms/saveBlock'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { isDuplicateKey } from '@/lib/db/errors'
import { tagsForBlockSave } from '@/lib/cache/tags'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import {
  ColumnMetaSchema,
  SectionMetaSchema,
  WidgetMetaSchema,
  type BlockKind,
} from '@/lib/cms/blockMeta'

// PR-3 dual-axis optimistic-lock body. The save TX locks pages BEFORE
// content_blocks, so the FE MUST supply BOTH the page-version and
// block-version optimistic-lock tokens AND the page id (used to verify
// the block actually belongs to the page the FE thinks it does — a
// forged pageId targeting a foreign block surfaces as 404 not_found
// rather than a cross-page leak).
//
// `data` is for widget rows; `meta` is for section/column container
// rows. Exactly one of the two MUST be present — the handler reads
// the row's kind and dispatches to saveBlock (widget) or saveBlockMeta
// (container). A request that supplies the wrong field for the row's
// kind surfaces as 400 wrong_field_for_kind.
const PatchBody = z
  .object({
    pageId: z.number().int().positive(),
    blockVersion: z.number().int().nonnegative(),
    pageVersion: z.number().int().nonnegative(),
    data: z.unknown().optional(),
    meta: z.unknown().optional(),
  })
  .strict()

type RouteCtx = { params: Promise<{ id: string }> }

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Per-page htmlId uniqueness check. The htmlId becomes the `id` attribute
// of the rendered wrapper — two living blocks on the same page sharing
// one would produce duplicate DOM ids, breaking #anchor links and CSS
// id selectors. The Schema validates SHAPE; this query enforces SCOPE.
//
// JSON_EXTRACT returns the JSON literal — for a string value that's
// `"foo"` including quotes. We compare against the JSON-encoded form
// via JSON_QUOTE so the literal matches. NULL meta or meta without an
// htmlId key returns NULL from JSON_EXTRACT and never collides.
//
// `excludeBlockId` is the current row on PATCH (a block's own htmlId
// doesn't collide with itself). On POST pass `null`.
//
// The application-level SELECT is best-effort — the AUTHORITATIVE gate
// is the `uniq_content_blocks_page_html_id_live` UNIQUE index added in
// migration 0014, which lifts JSON_EXTRACT(meta, '$.htmlId') into a
// generated stored column (`html_id_live`) and constrains (page_id,
// html_id_live). Soft-deleted rows null out the generated column via
// the deleted_at-gated CASE expression, so a soft-deleted block
// doesn't block a fresh live row from claiming the same htmlId.
//
// Two concurrent PATCHes that both pass the pre-check will then race
// to the saveBlockMeta INSERT/UPDATE; the second one's write fails
// with a MariaDB 1062 duplicate-key error which saveBlockMeta surfaces
// via the route's outer catch as an `html_id_collision` 409 — the
// same operator-facing error code, raised at a strictly atomic
// boundary instead of the app-level TOCTOU window.
async function assertHtmlIdUnique(
  exec: typeof db,
  pageId: number,
  htmlId: string,
  excludeBlockId: number | null,
): Promise<void> {
  const [rows] = (await exec.execute(sql`
    SELECT id FROM content_blocks
    WHERE page_id = ${pageId}
      AND deleted_at IS NULL
      AND JSON_EXTRACT(meta, '$.htmlId') = JSON_QUOTE(${htmlId})
      ${excludeBlockId === null ? sql`` : sql`AND id != ${excludeBlockId}`}
    LIMIT 1
  `)) as unknown as [Array<{ id: number }>]
  if (rows.length > 0) {
    throw new HttpError(409, 'html_id_collision')
  }
}

// Read htmlId from a parsed Section / Column / Widget meta object.
// Returns undefined when the field is absent or empty.
function extractHtmlId(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const v = (meta as { htmlId?: unknown }).htmlId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

export const PATCH = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'blocks', 'write')
  checkCmsMutationRate(ctx)

  const body = PatchBody.parse(await readJsonBody(req))

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  // Lightweight non-locking read to discover the row's kind so we can
  // dispatch to the correct save helper. The TX-internal kind check
  // inside saveBlockMeta closes the (vanishingly small) race window
  // where the row gets flipped between this read and the locked
  // SELECT — kind is set at create and never mutated, so the race is
  // not real, but the TX guard removes the implicit invariant.
  const [kindRows] = (await db.execute(sql`
    SELECT kind FROM content_blocks
    WHERE id = ${id}
      AND page_id = ${body.pageId}
      AND deleted_at IS NULL
    LIMIT 1
  `)) as unknown as [Array<{ kind: BlockKind }>]
  const kind = kindRows[0]?.kind
  if (!kind) throw new HttpError(404, 'not_found')

  try {
    if (kind === 'widget') {
      // Chunk E: widgets accept EITHER data (registry-validated widget
      // payload via saveBlock) OR meta (spacing-only WidgetMetaSchema
      // via saveBlockMeta). Exactly one — both is a malformed request,
      // neither is too. Routing on which field is present preserves
      // the BlockKind ↔ payload-shape contract from PR-3 while letting
      // the same widget row carry per-side spacing without touching
      // its data payload.
      if (body.data === undefined && body.meta === undefined) {
        throw new HttpError(400, 'data_or_meta_required_for_widget')
      }
      if (body.data !== undefined && body.meta !== undefined) {
        throw new HttpError(400, 'wrong_field_for_kind')
      }
      if (body.data !== undefined) {
        const { blockVersion, pageVersion } = await saveBlock({
          blockId: id,
          userId: ctx.userId,
          tokenId: ctx.tokenId,
          ip,
          userAgent,
          requestId,
          pageId: body.pageId,
          expectedBlockVersion: body.blockVersion,
          expectedPageVersion: body.pageVersion,
          data: body.data,
        })
        return new Response(JSON.stringify({ blockVersion, pageVersion }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          },
        })
      }
      // Widget meta path. WidgetMetaSchema.strict() rejects any attempt
      // to slip widget data fields through the meta channel.
      const parsedMeta = WidgetMetaSchema.parse(body.meta)
      const newHtmlId = extractHtmlId(parsedMeta)
      if (newHtmlId !== undefined) {
        await assertHtmlIdUnique(db, body.pageId, newHtmlId, id)
      }
      const { blockVersion, pageVersion } = await saveBlockMeta({
        blockId: id,
        userId: ctx.userId,
        tokenId: ctx.tokenId,
        ip,
        userAgent,
        requestId,
        pageId: body.pageId,
        expectedBlockVersion: body.blockVersion,
        expectedPageVersion: body.pageVersion,
        expectedKind: 'widget',
        metaJson: JSON.stringify(parsedMeta),
      })
      return new Response(JSON.stringify({ blockVersion, pageVersion }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      })
    }

    // Container path — section / column meta update.
    if (body.meta === undefined) {
      throw new HttpError(400, 'meta_required_for_container')
    }
    if (body.data !== undefined) {
      throw new HttpError(400, 'wrong_field_for_kind')
    }
    const parsedMeta =
      kind === 'section'
        ? SectionMetaSchema.parse(body.meta)
        : ColumnMetaSchema.parse(body.meta)
    const newHtmlId = extractHtmlId(parsedMeta)
    if (newHtmlId !== undefined) {
      await assertHtmlIdUnique(db, body.pageId, newHtmlId, id)
    }
    const { blockVersion, pageVersion } = await saveBlockMeta({
      blockId: id,
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      ip,
      userAgent,
      requestId,
      pageId: body.pageId,
      expectedBlockVersion: body.blockVersion,
      expectedPageVersion: body.pageVersion,
      expectedKind: kind,
      metaJson: JSON.stringify(parsedMeta),
    })
    return new Response(JSON.stringify({ blockVersion, pageVersion }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    // Distinct 409 codes so the FE recovery banner can route the
    // buffered diff to the right merge UI. NotFoundError covers BOTH
    // a missing block AND a forged pageId (block belongs to a
    // different page) — same code, no info-leak to a probe.
    if (e instanceof StaleBlockVersionError) throw new HttpError(409, 'stale_block_version')
    if (e instanceof StalePageVersionError) throw new HttpError(409, 'stale_page_version')
    if (e instanceof NotFoundError) throw new HttpError(404, 'not_found')
    if (e instanceof WrongKindError) throw new HttpError(409, 'wrong_kind')
    if (e instanceof InvalidMetaJsonError) throw new HttpError(400, 'invalid_meta_json')
    // The htmlId UNIQUE index (migration 0014) is the authoritative
    // gate on per-page html_id collisions; the app-level check before
    // the TX is best-effort and races. When the index hits on commit,
    // surface 409 html_id_collision (matches the documented client
    // contract) instead of letting the raw mysql error become a 500.
    if (isDuplicateKey(e)) throw new HttpError(409, 'html_id_collision')
    throw e
  }
})

// Soft delete. Fixed-key blocks (block_key non-null) refuse — the
// page template guarantees those slots exist, even if briefly empty.
// media_references rows are dropped here, not deferred to a cron, so
// a follow-up media DELETE doesn't wrongly think the row is in use.
//
// Section + column rows cascade their children via the migration-0011
// self-FK ON DELETE CASCADE — but soft-delete doesn't fire FK CASCADE
// (only hard DELETE does). So a soft-deleted section's columns +
// widgets stay alive in the table; the renderer drops them anyway
// because top-level + parent visibility chains through deleted_at on
// every row. Hard-delete via the cron purge cascades correctly.
export const DELETE = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'blocks', 'delete')
  checkCmsMutationRate(ctx)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  const txResult = await db.transaction(async (tx) => {
    // Lock the pages row FIRST (deadlock pre-emption — same lock order
    // as saveBlock). DELETE bumps pages.version below so a concurrent
    // PATCH against any block on this page will 409 stale_page_version
    // and pull the fresh tree, including the soft-deleted row's removal.
    const [pageLockRows] = (await tx.execute(sql`
      SELECT id, version FROM pages
      WHERE id = (SELECT page_id FROM content_blocks WHERE id = ${id})
        AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; version: number }>]
    const pageLock = pageLockRows[0]
    if (!pageLock) throw new HttpError(404, 'not_found')

    const [rows] = (await tx.execute(sql`
      SELECT cb.block_key, cb.kind, cb.block_type, cb.data, cb.version, cb.page_id, p.slug
      FROM content_blocks cb
      JOIN pages p ON p.id = cb.page_id
      WHERE cb.id = ${id} AND cb.deleted_at IS NULL AND p.deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [
      Array<{
        block_key: string | null
        kind: BlockKind
        block_type: string
        data: string
        version: number
        page_id: number
        slug: string
      }>,
    ]
    const row = rows[0]
    if (!row) throw new HttpError(404, 'not_found')
    if (row.block_key !== null) {
      throw new HttpError(409, 'cannot_delete_fixed_block')
    }

    // Soft-delete cascade: when a container is removed, every living
    // descendant must vanish from the public render too. The FK ON
    // DELETE CASCADE only fires on HARD delete, so we mirror it here
    // with a recursive CTE that walks the FULL subtree regardless of
    // depth. Doing this in-TX guarantees the operator's "delete
    // section" gesture atomically removes the entire subtree from the
    // render path; a partial soft-delete would leave orphan columns
    // visible at the next page load.
    //
    // Recursive CTE form (MariaDB 10.2.2+ — preflight enforces 10.6+
    // for the migration system, well above the minimum) handles 2,
    // 3, or N levels with one query: today's spec locks the tree at
    // section→column→widget, but a future row/grid model would land
    // safely without revisiting this handler. The CTE filters
    // `deleted_at IS NULL` on every step so already-deleted ancestors
    // don't reanimate descendants of a different lineage.
    // Collect the FULL set of ids that will be soft-deleted in this
    // gesture. For widgets that's just the target. For sections /
    // columns it's the target plus every living descendant the
    // recursive CTE finds. The id set drives BOTH the bulk UPDATE
    // below AND the SELECT-back that builds the response payload
    // (client needs each row's bumped version + matching deleted_at
    // + parent_id + position to advance optimistic-lock cursors).
    let deletedIds: number[]
    if (row.kind === 'widget') {
      deletedIds = [id]
    } else {
      // Two-step: materialize the descendant id set first, then UPDATE.
      // MariaDB allows CTEs in DML statements but the same-table self-
      // reference (CTE → content_blocks → UPDATE content_blocks) is
      // friction-prone across versions. Two-step is unconditionally
      // safe AND keeps the SQL grep-able from the audit log.
      // Defense-in-depth same-page filter. Business invariants keep
      // parent_id within a single page (the create + reorder routes
      // refuse cross-page parent_id), but a corrupted row OR a future
      // schema change that allowed cross-page parenting would let this
      // CTE harvest descendants from a different page. Filtering on
      // cb.page_id at each recursive step bounds the blast radius to
      // the deleted block's own page.
      const [descRows] = (await tx.execute(sql`
        WITH RECURSIVE descendants AS (
          SELECT id, page_id FROM content_blocks
          WHERE id = ${id} AND deleted_at IS NULL
          UNION ALL
          SELECT cb.id, cb.page_id
          FROM content_blocks cb
          INNER JOIN descendants d ON cb.parent_id = d.id
          WHERE cb.deleted_at IS NULL
            AND cb.page_id = d.page_id
        )
        SELECT id FROM descendants
      `)) as unknown as [Array<{ id: number }>]
      deletedIds = descRows.map((r) => r.id)
      // Defensive: the CTE always returns at least the section row id
      // itself (FOR UPDATE upstream guaranteed it's alive), so the
      // empty-array branch is unreachable.
      if (deletedIds.length === 0) deletedIds = [id]
    }
    // Bump version + stamp deleted_at in ONE batched UPDATE so every
    // row carries the same NOW(3) timestamp (restore's cascade filter
    // depends on the uniform deleted_at across the gesture).
    await tx.execute(sql`
      UPDATE content_blocks
      SET deleted_at = NOW(3),
          version = version + 1,
          updated_by = ${ctx.userId}
      WHERE deleted_at IS NULL
        AND id IN (${sql.join(deletedIds, sql.raw(','))})
    `)

    // Drop media_references for the soft-deleted ROW (containers carry
    // none — collectMediaPaths returns []). For sections + columns the
    // descendant widgets' media_references stay until the cron purge
    // hard-deletes them; the public renderer no longer sees the rows
    // either way. A follow-up media DELETE would refuse if any orphaned
    // descendant ref still exists, which is the safe contract.
    if (row.kind === 'widget') {
      await tx.execute(sql`
        DELETE FROM media_references
        WHERE referent_type = 'content_block' AND referent_id = ${id}
      `)
    }

    // Audit diff. For widgets: hash + size + block_type + version.
    // For containers: kind + block_type + version (no widget data to
    // hash; the row's audit-row create already captured the meta).
    const auditDiff =
      row.kind === 'widget'
        ? {
            kind: AUDIT_KIND.delete,
            block_type: row.block_type,
            version: row.version,
            data_hash: createHash('sha256').update(row.data).digest('hex'),
            byte_size: row.data.length,
          }
        : {
            kind: AUDIT_KIND.delete,
            container_kind: row.kind,
            block_type: row.block_type,
            version: row.version,
          }
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'delete',
      resourceType: 'content_block',
      resourceId: String(id),
      diff: auditDiff as unknown as object,
      ip,
      userAgent,
      requestId,
    })

    // Bump pages.version so concurrent in-flight PATCHes that hold a
    // stale cursor surface as 409 stale_page_version. The client's
    // success path reads the new version from the response below and
    // advances its optimistic-lock cursor without a router.refresh.
    await tx.execute(sql`
      UPDATE pages
      SET version = version + 1, updated_at = NOW(3), updated_by = ${ctx.userId}
      WHERE id = ${row.page_id}
    `)
    const newPageVersion = pageLock.version + 1

    // Read back the bumped versions + uniform deleted_at + position +
    // parent_id for every soft-deleted row. Client uses the per-row
    // version to advance per-block optimistic-lock cursors AND uses
    // (parentId, position) to keep the optimistic tree consistent
    // with the post-delete server state.
    const [deletedRows] = (await tx.execute(sql`
      SELECT id, version, deleted_at, parent_id, position
      FROM content_blocks
      WHERE id IN (${sql.join(deletedIds, sql.raw(','))})
    `)) as unknown as [
      Array<{
        id: number
        version: number
        deleted_at: Date | string
        parent_id: number | null
        position: number
      }>,
    ]

    const tags = tagsForBlockSave(row.slug, row.block_type).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { queueRowId, tags, newPageVersion, deletedRows }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  // 200 + JSON body so the FE can advance optimistic-lock cursors
  // without a router.refresh roundtrip. Body shape locked in this
  // route's contract — { pageVersion, blocks: [{ id, version,
  // deletedAt (ISO string), parentId, position }] }.
  const responseBlocks = txResult.deletedRows.map((r) => ({
    id: r.id,
    version: r.version,
    deletedAt:
      r.deleted_at instanceof Date
        ? r.deleted_at.toISOString()
        : new Date(r.deleted_at).toISOString(),
    parentId: r.parent_id,
    position: r.position,
  }))
  return new Response(
    JSON.stringify({
      pageVersion: txResult.newPageVersion,
      blocks: responseBlocks,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
