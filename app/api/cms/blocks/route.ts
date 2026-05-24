import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { blockSchemas, FIXED_BLOCK_KEYS_PER_PAGE } from '@/lib/cms/block-registry'
import { AUDIT_DIFF_CAP } from '@/lib/cms/saveBlock'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import {
  ColumnMetaSchema,
  MAX_SECTION_COLUMNS,
  SectionMetaSchema,
  WidgetMetaSchema,
  type BlockKind,
} from '@/lib/cms/blockMeta'

// Body envelope. `kind` defaults to 'widget' so all pre-Chunk-B callers
// (EditableBlock duplicate, EditModeEmptyState, InsertBlockHere, the
// OutlinePanel add-block menu) continue to POST without modification.
//
// Field rules per kind (enforced in code below — Zod accepts the
// superset; the handler narrows + rejects mismatches):
//   widget:  blockType (required, must be in blockSchemas), data
//            (required), parentId may be NULL or a kind='column' row
//            on the same page, meta MUST be omitted.
//   section: parentId MUST be omitted/null, blockType + data are
//            ignored (server forces 'section' + '{}'), meta is the
//            section settings (parsed via SectionMetaSchema).
//   column:  parentId REQUIRED + must point to a kind='section' row on
//            the same page, blockType + data are ignored (server forces
//            'column' + '{}'), meta is the column settings (parsed via
//            ColumnMetaSchema).
const PostBody = z
  .object({
    pageId: z.number().int().positive(),
    kind: z.enum(['section', 'column', 'widget']).optional().default('widget'),
    // Optional for ALL kinds at the Zod layer. The handler enforces:
    //   widget POST without blockType → 400 missing_block_type
    //   widget blockType not in blockSchemas → 400 unknown_block_type
    blockType: z.string().min(1).max(50).optional(),
    data: z.unknown().optional(),
    // Optional null = explicit top-level placement; undefined = treat as
    // null (back-compat with pre-Chunk-B body shape that omitted parentId).
    parentId: z.number().int().positive().nullable().optional(),
    // Per-kind container settings. For widgets the handler rejects any
    // non-null/non-empty meta with 400 widget_meta_not_allowed.
    meta: z.unknown().optional(),
    // Position-aware insert — server bisects `afterBlockId` and the next
    // sibling within the SAME parent. Pre-Chunk-B callers pass it as a
    // page-level neighbour id; the handler still treats it correctly
    // because the new sibling-scoped lookup is a strict refinement.
    afterBlockId: z.number().int().positive().optional(),
    // Inverse of afterBlockId: insert IMMEDIATELY BEFORE this sibling.
    // Required for the "+ Add block here" pill rendered ABOVE the first
    // widget in a column (or above the first top-level entry on the
    // page). Without this, the prior client used afterBlockId=null,
    // which the server interpreted as "no preference → append-to-tail"
    // — the new block landed at the BOTTOM instead of the top.
    // Mutually exclusive with afterBlockId; handler returns 400 if both
    // are provided.
    beforeBlockId: z.number().int().positive().optional(),
    // Section-shape preset (Chunk C). When kind='section' and
    // withColumns is provided, the same TX creates the section AND
    // N child columns. Atomic — either every row commits or none
    // do. Out of range / wrong-kind combinations are 400'd by the
    // handler before the TX opens.
    withColumns: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
  })
  // .strict() rejects unknown keys at the parse boundary so a forged
  // payload can't smuggle extra fields past the handler. Aligns with
  // PatchBody (which is already strict) and the container Meta schemas.
  .strict()

interface InsertResult {
  insertId: number
}

interface ParentRow {
  id: number
  kind: BlockKind
  page_id: number
}

// F3: auto-respace siblings under `parentId` to a clean 1000-spaced
// ordering. Called when a bisect can't fit between two siblings AT
// ALL (gap exhausted from repeated mid-bucket inserts). After
// respace the caller retries the bisect against the fresh layout.
// Bumps every renumbered row's version (optimistic-lock cursors
// belonging to in-flight clients on these rows MUST 409 next save,
// because their `position` cache is now stale) AND bumps
// pages.version to surface the page-wide reorder to any concurrent
// PATCH. Acquires FOR UPDATE on every child in PK order, preserving
// the lock-order discipline shared with /reorder.
//
// Exported so /reorder can share the implementation without
// duplicating the SQL. Note: this runs INSIDE an existing TX
// supplied by the caller; the caller's pages-row lock MUST already
// be held (otherwise the version bump would race a concurrent
// saveBlock). See call sites for the precondition.
export async function respaceParent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  parentId: number | null,
  pageId: number,
  userId: number,
): Promise<void> {
  const [children] = (await tx.execute(sql`
    SELECT id FROM content_blocks
    WHERE page_id = ${pageId}
      AND deleted_at IS NULL
      AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
    ORDER BY position, id
    FOR UPDATE
  `)) as unknown as [Array<{ id: number }>]
  if (children.length === 0) return
  // Renumber 1000-spaced. CASE-expression batched UPDATE so the
  // whole bucket flips atomically — preserves the per-(parent_id,
  // position) uniqueness index (migration 0011) during the
  // transition (MariaDB defers the unique check to statement end).
  // Version bumps for every row so any in-flight FE that still
  // holds a stale position cursor for these rows will 409 on its
  // next save and re-fetch.
  const positionCases = children.map(
    (c, i) => sql`WHEN ${c.id} THEN ${(i + 1) * 1000}`,
  )
  const idList = children.map((c) => c.id)
  await tx.execute(sql`
    UPDATE content_blocks
    SET position = CASE id ${sql.join(positionCases, sql.raw(' '))} END,
        version = version + 1,
        updated_by = ${userId}
    WHERE id IN (${sql.join(idList, sql.raw(','))})
      AND page_id = ${pageId}
      AND deleted_at IS NULL
  `)
  // Bump pages.version: a respace IS a page-wide reorder visible
  // to every other in-flight client. Without this, a concurrent
  // PATCH holding the pre-respace page-version cursor would commit
  // unaware that every sibling's position shifted.
  await tx.execute(sql`
    UPDATE pages
    SET version = version + 1, updated_at = NOW(3), updated_by = ${userId}
    WHERE id = ${pageId}
  `)
}

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const body = PostBody.parse(await readJsonBody(req))

  // Normalise parentId — null and undefined collapse to "no parent".
  const parentId: number | null =
    typeof body.parentId === 'number' ? body.parentId : null

  // Per-kind validation done HERE (not in Zod) so the response codes
  // are descriptive and the parent-row check happens INSIDE the TX
  // (atomic with the position calc).
  if (body.kind === 'section') {
    if (parentId !== null) {
      throw new HttpError(400, 'section_parent_must_be_null')
    }
  } else if (body.kind === 'column') {
    if (parentId === null) {
      throw new HttpError(400, 'column_parent_required')
    }
  }
  // Widgets accept either null parentId (loose top-level legacy path)
  // or a column parent — verified in the TX below.

  // withColumns is a section-only preset. Reject non-section uses
  // before the TX so the operator gets a descriptive 400 rather than
  // a confusing partial-create.
  if (body.withColumns !== undefined && body.kind !== 'section') {
    throw new HttpError(400, 'with_columns_requires_section')
  }

  // afterBlockId + beforeBlockId are mutually exclusive — passing
  // both is ambiguous and indicates a bug in the caller, not a
  // legitimate intent the server should resolve silently.
  if (body.afterBlockId !== undefined && body.beforeBlockId !== undefined) {
    throw new HttpError(400, 'after_and_before_are_mutually_exclusive')
  }

  // Widget: blockType + data are required. Pre-Chunk-H widgets refused
  // any meta on create (the spacing toolbar set it via PATCH after).
  // Chunk H allows widget meta on create so the right-click Paste verb
  // can carry the source widget's per-side spacing forward in a single
  // POST. The meta is gated by WidgetMetaSchema (.strict()) so a forged
  // payload can't smuggle non-spacing keys through the meta channel.
  let parsedWidgetData: unknown = null
  let widgetBlockType: string | null = null
  let widgetMetaJson: string | null = null
  if (body.kind === 'widget') {
    if (!body.blockType) {
      throw new HttpError(400, 'missing_block_type')
    }
    if (!(body.blockType in blockSchemas)) {
      throw new HttpError(400, 'unknown_block_type')
    }
    if (body.data === undefined) {
      throw new HttpError(400, 'missing_data')
    }
    widgetBlockType = body.blockType
    parsedWidgetData = parseAndSanitize(body.blockType, body.data)
    // Widget meta is OPTIONAL on create. Empty / undefined / null all
    // pass through as NULL in the column — matching the pre-Chunk-H
    // default for newly-created widgets (no spacing overrides until
    // the operator opens the spacing toolbar).
    if (body.meta !== undefined && body.meta !== null) {
      const parsedMeta = WidgetMetaSchema.parse(body.meta)
      // Only serialise when the parsed meta has at least one key.
      // WidgetMetaSchema.strict() permits an empty object; storing
      // '{}' instead of NULL would burn a JSON column read on every
      // page render for no behavioural difference. NULL is the
      // canonical "no overrides" representation.
      if (Object.keys(parsedMeta).length > 0) {
        widgetMetaJson = JSON.stringify(parsedMeta)
      }
    }
  }

  // Container meta validated through the strict Zod schemas. Empty
  // object accepted — the operator may create a section without
  // overriding any defaults; renderer falls back to DEFAULT_SECTION_META.
  let containerMetaJson: string | null = null
  if (body.kind === 'section') {
    const m = SectionMetaSchema.parse(body.meta ?? {})
    containerMetaJson = JSON.stringify(m)
  } else if (body.kind === 'column') {
    const m = ColumnMetaSchema.parse(body.meta ?? {})
    containerMetaJson = JSON.stringify(m)
  }

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  // Bisect paths (afterBlockId / beforeBlockId) may trigger an
  // auto-respace (F3) which bumps pages.version. To preserve the
  // saveBlock lock order (pages → content_blocks) the page lock
  // MUST be acquired BEFORE the parent block FOR UPDATE below.
  // Pure tail-append (no anchor) never triggers respace, so the
  // weaker non-locking SELECT stays sufficient there.
  const mayRespace =
    typeof body.afterBlockId === 'number' ||
    typeof body.beforeBlockId === 'number'

  const txResult = await db.transaction(async (tx) => {
    // 1. Page must exist AND not be in trash. Same contract as the
    //    DELETE / saveBlock paths; surfaces as page_not_found rather
    //    than a distinct trashed code so a probing client can't
    //    distinguish.
    const [pageRows] = mayRespace
      ? ((await tx.execute(sql`
          SELECT slug FROM pages WHERE id = ${body.pageId} AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [Array<{ slug: string }>])
      : ((await tx.execute(sql`
          SELECT slug FROM pages WHERE id = ${body.pageId} AND deleted_at IS NULL
        `)) as unknown as [Array<{ slug: string }>])
    const pageSlug = pageRows[0]?.slug
    if (!pageSlug) throw new HttpError(404, 'page_not_found')

    // 2. Parent kind validation — atomic with the position calc.
    //    Lock the parent row so it cannot be soft-deleted between the
    //    kind check and the INSERT (which would orphan the new child).
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
        // Cross-page parent. 404 (no info-leak about which page owns
        // the row) — same code as the parent-missing case.
        throw new HttpError(404, 'parent_not_found')
      }
      if (body.kind === 'column' && parent.kind !== 'section') {
        throw new HttpError(400, 'column_parent_must_be_section')
      }
      if (body.kind === 'widget' && parent.kind !== 'column') {
        throw new HttpError(400, 'widget_parent_must_be_column')
      }
      // section never reaches here — parentId === null was enforced above.

      // 2a. Column-count cap enforced SERVER-SIDE — the client cap in
      //     EditableSection/InsertSectionHere is just a UX hint; a
      //     forged POST or a concurrent operator race could otherwise
      //     create the Nth+1 column under a section and the renderer
      //     (which clamps grid tracks at MAX_SECTION_COLUMNS) would
      //     wrap the extras into a broken partial row. The parent
      //     row's FOR UPDATE lock above pins the section so a
      //     concurrent column insert serialises on this check.
      if (body.kind === 'column') {
        const [colCountRows] = (await tx.execute(sql`
          SELECT COUNT(*) AS n FROM content_blocks
          WHERE parent_id = ${parentId} AND deleted_at IS NULL
        `)) as unknown as [Array<{ n: number | bigint }>]
        const currentCount = Number(colCountRows[0]?.n ?? 0)
        if (currentCount >= MAX_SECTION_COLUMNS) {
          throw new HttpError(409, 'column_count_exceeded')
        }
      }
    }

    // 3. Freeform widget creates may NOT use the block_types reserved
    //    for fixed template slots. Sections/columns are container kinds
    //    and never collide with fixed-slot block_types.
    if (body.kind === 'widget' && widgetBlockType !== null) {
      const fixedTypesForPage = FIXED_BLOCK_KEYS_PER_PAGE[pageSlug] ?? []
      if ((fixedTypesForPage as readonly string[]).includes(widgetBlockType)) {
        throw new HttpError(409, 'block_type_reserved_for_fixed_slot')
      }
    }

    // 3a. Per-page htmlId uniqueness. The htmlId becomes the wrapper's
    //     DOM id; two living blocks sharing one would break #anchor
    //     navigation + CSS id selectors. Schema validates SHAPE; this
    //     query enforces SCOPE. JSON_EXTRACT returns the JSON literal
    //     (a string value comes back as `"foo"` with quotes), compared
    //     against JSON_QUOTE() of the candidate so the literals match.
    //     NULL meta or meta lacking the key returns NULL from
    //     JSON_EXTRACT and never collides.
    const candidateHtmlId =
      body.kind === 'widget' && widgetMetaJson !== null
        ? (() => {
            try {
              const parsed = JSON.parse(widgetMetaJson) as { htmlId?: unknown }
              return typeof parsed.htmlId === 'string' && parsed.htmlId.length > 0
                ? parsed.htmlId
                : null
            } catch {
              return null
            }
          })()
        : containerMetaJson !== null
          ? (() => {
              try {
                const parsed = JSON.parse(containerMetaJson) as { htmlId?: unknown }
                return typeof parsed.htmlId === 'string' && parsed.htmlId.length > 0
                  ? parsed.htmlId
                  : null
              } catch {
                return null
              }
            })()
          : null
    if (candidateHtmlId !== null) {
      const [collisionRows] = (await tx.execute(sql`
        SELECT id FROM content_blocks
        WHERE page_id = ${body.pageId}
          AND deleted_at IS NULL
          AND JSON_EXTRACT(meta, '$.htmlId') = JSON_QUOTE(${candidateHtmlId})
        LIMIT 1
      `)) as unknown as [Array<{ id: number }>]
      if (collisionRows.length > 0) {
        throw new HttpError(409, 'html_id_collision')
      }
    }

    // 4. Position. Two paths, BOTH scoped to siblings sharing the SAME
    //    parent_id (NULL or numeric). Migration 0011 makes `position`
    //    a per-parent ordering — the (parent_id, position) index in
    //    db/migrations/0011 covers the per-parent scan.
    //
    //    (a) `afterBlockId` provided + resolves to a live sibling under
    //        the SAME parent: bisect with the next sibling under that
    //        parent. If afterBlockId belongs to a DIFFERENT parent, we
    //        treat it as not-found and fall through to (b).
    //    (b) Append-to-tail: MAX(position) WHERE page_id=? AND
    //        parent_id <=> ? + 1000. (`<=>` MariaDB's NULL-safe equals
    //        so parent_id=NULL matches NULL too.)
    //
    //    1000-spaced positions leave room for unbounded mid-bucket
    //    inserts before a re-bucket reorder is needed.
    // bisect() returns the new position, or null when the gap between
    // the chosen siblings shrank below the 2-integer minimum.
    // On null the caller respaces the parent's children to a fresh
    // 1000-spaced ordering, then retries — operator should never see
    // a position_gap_exhausted 409 from the create path.
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
          if (p <= siblings[idx - 1]!.position || p >= siblings[idx]!.position) {
            return null
          }
          return p
        }
        // beforeBlockId not under this parent — append-to-tail.
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
          // Target is the last sibling — append after it within the parent.
          return siblings[idx]!.position + 1000
        }
        // afterBlockId not under this parent — append-to-tail.
        const [maxRows] = (await tx.execute(sql`
          SELECT COALESCE(MAX(position), 0) AS maxPos
          FROM content_blocks
          WHERE page_id = ${body.pageId}
            AND deleted_at IS NULL
            AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}
        `)) as unknown as [Array<{ maxPos: number }>]
        return Number(maxRows[0]?.maxPos ?? 0) + 1000
      }
      // No anchor — append-to-tail of the parent bucket.
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
      // F3: Gap exhausted between two siblings. Respace the bucket
      // 1000-spaced and retry the bisect ONCE. If the retry still
      // can't fit (essentially impossible after a clean respace —
      // would require the bucket to hit the int32 ceiling, which is
      // ~2.1M siblings under 1000-spacing), surface as 409 so the
      // FE can route to a refresh.
      await respaceParent(tx, parentId, body.pageId, ctx.userId)
      nextPos = await bisect()
      if (nextPos === null) {
        throw new HttpError(409, 'position_gap_exhausted')
      }
    }

    // 5. INSERT. block_key stays NULL (freeform; cannot be a fixed slot
    //    — POST is the only entry point and fixed slots are seeded at
    //    page-template install). For containers, block_type is the
    //    literal kind string; data is the empty-object placeholder
    //    that satisfies the NOT NULL constraint without carrying any
    //    widget shape.
    const insertBlockType =
      body.kind === 'widget' ? widgetBlockType! : body.kind
    const insertData =
      body.kind === 'widget'
        ? JSON.stringify(parsedWidgetData)
        : '{}'
    // Widget meta is OPTIONAL on create (Chunk H). Containers always
    // carry containerMetaJson (built above from SectionMetaSchema /
    // ColumnMetaSchema). For widgets the value is null unless the
    // caller provided a non-empty WidgetMetaSchema payload.
    const insertMetaJson =
      body.kind === 'widget' ? widgetMetaJson : containerMetaJson
    const [insertResultArr] = (await tx.execute(sql`
      INSERT INTO content_blocks
        (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
      VALUES (
        ${body.pageId},
        ${parentId},
        ${body.kind},
        ${insertBlockType},
        ${nextPos},
        ${insertData},
        ${insertMetaJson},
        0,
        ${ctx.userId}
      )
    `)) as unknown as [InsertResult]
    const blockId = Number(insertResultArr.insertId)

    // 6. Wire up media_references for any media_id in the payload.
    //    Containers have empty data so collectMediaPaths returns []
    //    and assertMediaAvailable + the loop both no-op.
    if (body.kind === 'widget') {
      const refs = collectMediaPaths(parsedWidgetData)
      const mediaIds = [...new Set(refs.map((r) => r.mediaId))]
      await assertMediaAvailable(tx, mediaIds)
      for (const r of refs) {
        await tx.execute(sql`
          INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
          VALUES (${r.mediaId}, 'content_block', ${blockId}, ${r.field})
        `)
      }
    }

    // 7a. Section-shape preset — atomically create N child columns
    //     BEFORE the audit row so the audit can record the freshly-
    //     inserted child ids in one consolidated row. Same TX → a
    //     partial create cannot ship a section without its declared
    //     column rows.
    const childColumnIds: number[] = []
    if (body.kind === 'section' && body.withColumns !== undefined) {
      const emptyColumnMeta = '{}'
      for (let i = 0; i < body.withColumns; i += 1) {
        const colPos = (i + 1) * 1000
        const [colInsertArr] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
          VALUES (
            ${body.pageId},
            ${blockId},
            'column',
            'column',
            ${colPos},
            '{}',
            ${emptyColumnMeta},
            0,
            ${ctx.userId}
          )
        `)) as unknown as [InsertResult]
        childColumnIds.push(Number(colInsertArr.insertId))
      }
    }

    // 7b. Audit. action=create; diff is { kind:'create', data: parsed }
    //    for widgets under the cap, { kind:'create_truncated', byteSize }
    //    over the cap. For containers we capture { kind:'create',
    //    container_kind, parent_id, meta } so the audit answers
    //    "operator added a 2-column section under page X" without
    //    storing widget data the row never had. Section-shape presets
    //    extend the diff with `child_column_ids` so the full atomic
    //    create is ONE audit row, not N+1.
    const createPayload =
      body.kind === 'widget'
        ? { kind: AUDIT_KIND.create, data: parsedWidgetData }
        : {
            kind: AUDIT_KIND.create,
            container_kind: body.kind,
            parent_id: parentId,
            meta: containerMetaJson === null ? null : JSON.parse(containerMetaJson),
            ...(childColumnIds.length > 0
              ? { child_column_ids: childColumnIds }
              : {}),
          }
    const serializedLen = JSON.stringify(createPayload).length
    const createDiff =
      serializedLen > AUDIT_DIFF_CAP
        ? { kind: AUDIT_KIND.createTruncated, byteSize: serializedLen }
        : createPayload
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'create',
      resourceType: 'content_block',
      resourceId: String(blockId),
      diff: createDiff as unknown as object,
      ip,
      userAgent,
      requestId,
    })

    // 8. Durable revalidate intent. Containers AND widgets both
    //    invalidate the same page tag — sections/columns rendering
    //    affects every block on the page. block_type passed to
    //    tagsForBlockSave only matters for the cross-cutting
    //    `featured_projects` extra tag (containers never trigger it).
    const tagBlockType =
      body.kind === 'widget' ? widgetBlockType! : undefined
    const tags = tagsForBlockSave(pageSlug, tagBlockType).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { blockId, queueRowId, tags }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })

  return new Response(JSON.stringify({ id: txResult.blockId, version: 0 }), {
    status: 201,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
