import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { MAX_SECTION_COLUMNS, type BlockKind } from '@/lib/cms/blockMeta'

// Per-block optimistic-lock token. Migration 0011 makes `position`
// per-parent. This endpoint serves THREE modes that all collapse to
// the same atomic UPDATE pass:
//
//   1. Legacy within-parent reorder (pre-Chunk-B callers): body has
//      no `parentId` and no per-block `newParentId`. The handler
//      infers the parent from the first submitted block and requires
//      homogeneity.
//   2. Explicit within-parent reorder (Chunk B callers): body has
//      `parentId` (number or null). All blocks must currently belong
//      to that parent. Per-block `newParentId` MUST be omitted.
//   3. Cross-parent multi-move (Chunk D / DnD callers): at least one
//      block carries `newParentId`. Each block's newParentId becomes
//      its post-move parent. Body's top-level `parentId` MUST be
//      omitted to avoid ambiguity. The submission MUST be COMPLETE
//      for every affected parent (source AND destination) — drift
//      check rejects partial submissions to avoid leaving siblings at
//      stale positions.
//
// Lock order (deadlock pre-emption per saveBlock contract): pages
// FOR UPDATE first, then content_blocks FOR UPDATE. All content_blocks
// locks within a single TX are acquired in ONE bulk SELECT … ORDER BY
// id so concurrent reorders that touch overlapping parents serialise
// instead of deadlocking on cross-acquired row locks.
const Body = z
  .object({
    pageId: z.number().int().positive(),
    parentId: z.number().int().positive().nullable().optional(),
    blocks: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            version: z.number().int().nonnegative().optional(),
            expectedVersion: z.number().int().nonnegative().optional(),
            // Cross-parent move target. Number = column/section id;
            // null = top-level (loose widget or section). Undefined =
            // keep current parent (within-parent reorder).
            newParentId: z
              .union([z.number().int().positive(), z.null()])
              .optional(),
          })
          .refine(
            (b) => b.version !== undefined || b.expectedVersion !== undefined,
            'version_required',
          )
          // Reject mismatched dual fields so a legacy alias can't
          // bypass the optimistic-lock check by carrying a stale
          // `expectedVersion` alongside the current `version`. Equal
          // values are permitted (idiomatic redundancy).
          .refine(
            (b) =>
              b.version === undefined ||
              b.expectedVersion === undefined ||
              b.version === b.expectedVersion,
            'version_expected_version_mismatch',
          )
          .transform((b) => ({
            id: b.id,
            version: (b.version ?? b.expectedVersion) as number,
            newParentId: b.newParentId,
          })),
      )
      .min(1)
      .max(200),
  })
  // Reject unknown envelope keys — aligns with PatchBody and the
  // container meta schemas; closes a forge-extra-field surface.
  .strict()

interface SubmittedRow {
  id: number
  version: number
  parent_id: number | null
  kind: BlockKind
}

interface LivingChild {
  id: number
  parent_id: number | null
}

// Build the OR-clause fragment that locks all rows whose parent_id
// matches any element of `parents` (null included). MariaDB doesn't
// permit NULL inside an IN-list, so the NULL bucket needs its own
// `parent_id IS NULL` disjunct. Empty input returns a falsy fragment
// so the caller can short-circuit.
function parentMatchFragment(parents: Array<number | null>) {
  const nonNull = parents.filter((p): p is number => p !== null).sort((a, b) => a - b)
  const hasNull = parents.includes(null)
  if (nonNull.length === 0 && !hasNull) return null
  if (nonNull.length === 0) return sql`parent_id IS NULL`
  const inList = sql`parent_id IN (${sql.join(nonNull, sql.raw(','))})`
  return hasNull ? sql`(${inList} OR parent_id IS NULL)` : inList
}

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'blocks', 'write')
  checkCmsMutationRate(ctx)

  const body = Body.parse(await readJsonBody(req))

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  const submittedIds = new Set(body.blocks.map((b) => b.id))
  if (submittedIds.size !== body.blocks.length) {
    throw new HttpError(409, 'duplicate_block_id')
  }

  // Mode discrimination. If ANY block has explicit newParentId we
  // enter the cross-parent path; body.parentId then conflicts with
  // the explicit per-block targets and is rejected with a descriptive
  // 400 rather than silently overwriting.
  const anyExplicitNewParent = body.blocks.some(
    (b) => b.newParentId !== undefined,
  )
  if (anyExplicitNewParent && body.parentId !== undefined) {
    throw new HttpError(400, 'parent_id_conflicts_with_new_parent_id')
  }

  const txResult = await db.transaction(async (tx) => {
    // Step 1: lock the pages row first (lock-order discipline). F11 —
    // also read the current pages.version so we can return the bumped
    // value at commit; reorder mutates the page's structural ordering
    // and any concurrent block PATCH holding a pre-reorder pageVersion
    // cursor would otherwise silently commit unaware that sibling
    // positions shifted under it.
    const [pageRows] = (await tx.execute(sql`
      SELECT slug, version FROM pages
      WHERE id = ${body.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ slug: string; version: number }>]
    const pageSlug = pageRows[0]?.slug
    if (!pageSlug) throw new HttpError(404, 'page_not_found')

    // Step 2: lock + fetch every submitted block in PK order so
    // concurrent reorders that overlap on rows acquire locks in the
    // same sequence (no cross-acquired deadlock). The page_id filter
    // catches forged ids from other pages → drift.
    const submittedIdList = [...submittedIds].sort((a, b) => a - b)
    const [submittedRows] = (await tx.execute(sql`
      SELECT id, version, parent_id, kind
      FROM content_blocks
      WHERE page_id = ${body.pageId}
        AND deleted_at IS NULL
        AND id IN (${sql.join(submittedIdList, sql.raw(','))})
      ORDER BY id
      FOR UPDATE
    `)) as unknown as [SubmittedRow[]]
    if (submittedRows.length !== submittedIds.size) {
      throw new HttpError(409, 'drift')
    }
    const currentById = new Map(submittedRows.map((r) => [r.id, r]))

    // Step 3: optimistic-lock check on every submitted block.
    for (const b of body.blocks) {
      const cur = currentById.get(b.id)
      if (!cur) throw new HttpError(409, 'drift')
      if (cur.version !== b.version) {
        throw new HttpError(409, 'stale_version')
      }
    }

    // Step 4: resolve newParent per block according to mode.
    const resolvedParentById = new Map<number, number | null>()
    if (anyExplicitNewParent) {
      // Mode 3 — per-block newParentId (default to current).
      for (const b of body.blocks) {
        const cur = currentById.get(b.id)!
        resolvedParentById.set(
          b.id,
          b.newParentId === undefined ? cur.parent_id : b.newParentId,
        )
      }
    } else if (body.parentId !== undefined) {
      // Mode 2 — explicit single parent. Verify homogeneity so the
      // error code is descriptive instead of surfacing as drift.
      for (const r of submittedRows) {
        if (r.parent_id !== body.parentId) {
          throw new HttpError(400, 'cross_parent_reorder_not_allowed')
        }
      }
      for (const b of body.blocks) {
        resolvedParentById.set(b.id, body.parentId)
      }
    } else {
      // Mode 1 — legacy inference + homogeneity guard.
      const inferred = submittedRows[0]!.parent_id
      for (const r of submittedRows) {
        if (r.parent_id !== inferred) {
          throw new HttpError(400, 'cross_parent_reorder_not_allowed')
        }
      }
      for (const b of body.blocks) {
        resolvedParentById.set(b.id, inferred)
      }
    }

    // Step 5: lock any NEW parents that aren't already in the
    // submitted set (current parents are already locked via Step 2).
    // ONE bulk SELECT in PK order — preserves the global lock-order
    // discipline AND saves N round-trips vs. per-parent locking.
    const newParentLookupIds = Array.from(
      new Set(
        body.blocks
          .map((b) => resolvedParentById.get(b.id))
          .filter((p): p is number => p !== null && p !== undefined && !currentById.has(p)),
      ),
    ).sort((a, b) => a - b)
    const parentKindCache = new Map<number, BlockKind>()
    // Submitted rows whose kind we already know — surface for kind
    // validation below.
    for (const r of submittedRows) parentKindCache.set(r.id, r.kind)
    if (newParentLookupIds.length > 0) {
      const [parentRows] = (await tx.execute(sql`
        SELECT id, kind, page_id
        FROM content_blocks
        WHERE id IN (${sql.join(newParentLookupIds, sql.raw(','))})
          AND deleted_at IS NULL
        ORDER BY id
        FOR UPDATE
      `)) as unknown as [
        Array<{ id: number; kind: BlockKind; page_id: number }>,
      ]
      const fetchedById = new Map(parentRows.map((r) => [r.id, r]))
      for (const pid of newParentLookupIds) {
        const row = fetchedById.get(pid)
        if (!row) throw new HttpError(404, 'parent_not_found')
        if (row.page_id !== body.pageId) {
          // Cross-page parent — same code as missing for no info-leak.
          throw new HttpError(404, 'parent_not_found')
        }
        parentKindCache.set(pid, row.kind)
      }
    }

    // Step 6: kind-transition validation for every block whose parent
    // is actually changing. Sections always live at top-level; columns
    // always live under sections; widgets live under columns OR loose
    // at the top level.
    for (const b of body.blocks) {
      const cur = currentById.get(b.id)!
      const newParent = resolvedParentById.get(b.id) as number | null
      if (newParent === cur.parent_id) continue
      if (cur.kind === 'section' && newParent !== null) {
        throw new HttpError(400, 'section_cannot_have_parent')
      }
      if (cur.kind === 'column' && newParent === null) {
        throw new HttpError(400, 'column_parent_required')
      }
      if (newParent !== null) {
        const parentKind = parentKindCache.get(newParent)
        if (parentKind === undefined) throw new HttpError(404, 'parent_not_found')
        if (cur.kind === 'column' && parentKind !== 'section') {
          throw new HttpError(400, 'column_parent_must_be_section')
        }
        if (cur.kind === 'widget' && parentKind !== 'column') {
          throw new HttpError(400, 'widget_parent_must_be_column')
        }
      }
    }

    // Step 7: drift check — for every AFFECTED parent (source or
    // destination), the submission must list every currently-living
    // child of that parent. ONE bulk SELECT covers all affected
    // parents at once, eliminating the per-parent round-trip loop
    // that previously created a deadlock window when two TXs visited
    // overlapping parents in different JS-set iteration orders.
    const affectedParents = new Set<number | null>()
    for (const r of submittedRows) affectedParents.add(r.parent_id)
    for (const p of resolvedParentById.values()) affectedParents.add(p)
    const affectedParentsArr = [...affectedParents]
    const parentFragment = parentMatchFragment(affectedParentsArr)
    if (parentFragment !== null) {
      const [livingRows] = (await tx.execute(sql`
        SELECT id, parent_id
        FROM content_blocks
        WHERE page_id = ${body.pageId}
          AND deleted_at IS NULL
          AND (${parentFragment})
        ORDER BY id
        FOR UPDATE
      `)) as unknown as [LivingChild[]]
      const livingByParent = new Map<number | null, Set<number>>()
      for (const r of livingRows) {
        const bucket = livingByParent.get(r.parent_id) ?? new Set<number>()
        bucket.add(r.id)
        livingByParent.set(r.parent_id, bucket)
      }
      for (const p of affectedParentsArr) {
        const living = livingByParent.get(p) ?? new Set<number>()
        const submittedHere = submittedRows
          .filter((r) => r.parent_id === p)
          .map((r) => r.id)
        if (submittedHere.length !== living.size) {
          throw new HttpError(409, 'drift')
        }
        for (const id of submittedHere) {
          if (!living.has(id)) throw new HttpError(409, 'drift')
        }
      }

      // Step 7b: SERVER-SIDE column-count cap. Cross-parent moves
      // that land a column under a section already at the cap would
      // otherwise produce a partial row in the renderer (grid tracks
      // are clamped at MAX_SECTION_COLUMNS; extras wrap). Client cap
      // is a UX hint; this is the authority.
      //
      // ONLY enforced when the move INCREASES a section's column
      // count — pre-existing corrupt data (a section already past
      // the cap, e.g. via manual UPDATE) can still be reordered
      // within itself without this check getting in the operator's
      // way.
      const incomingByParent = new Map<number, number>()
      const leavingByParent = new Map<number, number>()
      for (const b of body.blocks) {
        const cur = currentById.get(b.id)!
        if (cur.kind !== 'column') continue
        const newParent = resolvedParentById.get(b.id) as number | null
        if (newParent !== null && cur.parent_id !== newParent) {
          incomingByParent.set(
            newParent,
            (incomingByParent.get(newParent) ?? 0) + 1,
          )
        }
        if (cur.parent_id !== null && cur.parent_id !== newParent) {
          leavingByParent.set(
            cur.parent_id,
            (leavingByParent.get(cur.parent_id) ?? 0) + 1,
          )
        }
      }
      for (const [parent, incoming] of incomingByParent.entries()) {
        const preMove = livingByParent.get(parent)?.size ?? 0
        const leaving = leavingByParent.get(parent) ?? 0
        const postMove = preMove - leaving + incoming
        if (postMove > MAX_SECTION_COLUMNS) {
          throw new HttpError(409, 'column_count_exceeded')
        }
      }
    }

    // Step 8: apply via a SINGLE batched UPDATE with CASE expressions
    // — collapses N per-block round-trips (which previously held
    // page-wide row-locks during each network RTT) into one. Position
    // is assigned by submission order within each resolved-parent
    // bucket; version bumps by 1; updated_by stamps the actor.
    const orderByParent = new Map<number | null, number[]>()
    for (const b of body.blocks) {
      const p = resolvedParentById.get(b.id) as number | null
      const arr = orderByParent.get(p) ?? []
      arr.push(b.id)
      orderByParent.set(p, arr)
    }

    const positionCases = body.blocks.map((b) => {
      const newParent = resolvedParentById.get(b.id) as number | null
      const orderInGroup = orderByParent.get(newParent)!.indexOf(b.id)
      const newPos = (orderInGroup + 1) * 1000
      return sql`WHEN ${b.id} THEN ${newPos}`
    })
    const parentCases = body.blocks.map((b) => {
      const newParent = resolvedParentById.get(b.id) as number | null
      return sql`WHEN ${b.id} THEN ${newParent}`
    })
    const idList = body.blocks.map((b) => b.id)
    await tx.execute(sql`
      UPDATE content_blocks
      SET position  = CASE id ${sql.join(positionCases, sql.raw(' '))} END,
          parent_id = CASE id ${sql.join(parentCases, sql.raw(' '))} END,
          version   = version + 1,
          updated_by = ${ctx.userId}
      WHERE id IN (${sql.join(idList, sql.raw(','))})
        AND page_id = ${body.pageId}
        AND deleted_at IS NULL
    `)
    const result = body.blocks.map((b) => {
      const newParent = resolvedParentById.get(b.id) as number | null
      const orderInGroup = orderByParent.get(newParent)!.indexOf(b.id)
      return {
        id: b.id,
        version: b.version + 1,
        position: (orderInGroup + 1) * 1000,
        parentId: newParent,
      }
    })

    // F11 — bump pages.version in the SAME TX. Reorder mutates the
    // page's structural ordering, which is the same axis any block
    // PATCH or DELETE serialises through pageVersion. Without this
    // bump, a concurrent PATCH holding the pre-reorder pageVersion
    // would commit successfully against a tree that has shifted —
    // operator A's reorder lands; operator B's pageVersion-cursored
    // PATCH then commits unaware. Bumping here closes that window:
    // any in-flight PATCH against the old pageVersion now 409s and
    // the FE refreshes to pick up the new order.
    await tx.execute(sql`
      UPDATE pages
      SET version = version + 1,
          updated_at = NOW(3),
          updated_by = ${ctx.userId}
      WHERE id = ${body.pageId}
    `)
    const newPageVersion = (pageRows[0]?.version ?? 0) + 1

    // Step 9: audit. ONE row per reorder gesture, capturing the
    // per-parent groups so a forensic replay can reconstruct both
    // the ordering AND any cross-parent moves. Affected parents that
    // got DRAINED (no resolved children — every child moved out)
    // emit an empty-order entry so the audit shows "parent X
    // emptied" explicitly rather than forcing the replay tool to
    // infer it from missing rows.
    const groups: Array<{ parent_id: number | null; order: number[] }> = []
    for (const [p, ids] of orderByParent.entries()) {
      groups.push({ parent_id: p, order: ids })
    }
    const recordedParents = new Set(groups.map((g) => g.parent_id))
    for (const p of affectedParents) {
      if (!recordedParents.has(p)) {
        groups.push({ parent_id: p, order: [] })
      }
    }
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      action: 'reorder',
      resourceType: 'page',
      resourceId: String(body.pageId),
      diff: {
        kind: AUDIT_KIND.reorder,
        cross_parent: anyExplicitNewParent,
        groups,
      } as unknown as object,
      ip,
      userAgent,
      requestId,
    })

    const tags = tagsForBlockSave(pageSlug).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return { result, queueRowId, tags, pageVersion: newPageVersion }
  })

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })
  // F11 — return pageVersion so clients can advance their cursors.
  // Existing callers reading only `blocks` keep working; new callers
  // can opt in by reading `pageVersion`.
  return new Response(
    JSON.stringify({
      blocks: txResult.result,
      pageVersion: txResult.pageVersion,
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
