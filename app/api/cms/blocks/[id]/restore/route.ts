import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { parseForRead } from '@/lib/cms/parse'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import type { BlockKind } from '@/lib/cms/blockMeta'

// Chunk J — optional body envelope. `cascade: true` is the undo path
// for a section/column delete: un-soft-deletes the root row AND every
// descendant that was soft-deleted by the same gesture. Without it
// (the pre-chunk-J behaviour), restore only un-deletes the root row
// and the descendants stay soft-deleted (suitable for a widget restore
// where there are no descendants). Body is OPTIONAL — pre-Chunk-J
// callers POST with no body and get the same behaviour as before.
//
// `position` + `parentId` (slot-aware restore): when supplied the
// restored row lands at the exact (parentId, position) the operator
// requested instead of the page-tail default. Used by the FE undo
// path for a single-block delete so the block reappears EXACTLY
// where it was, not at the bottom of the page. Both must be present
// together — supplying one without the other is rejected with 400
// rather than guessing the other half.
const PostBody = z
  .object({
    cascade: z.boolean().optional().default(false),
    // Bisect-target sibling position. The downstream resolver computes
    // an actual insert position by bisecting siblings around this
    // value, so semantically this is "where in the sibling list" not
    // "what `position` column value". Accepting 0 is intentional —
    // it's the head-insert sentinel (insert before all siblings); the
    // resolver rejects it with `position_gap_exhausted` when siblings
    // already occupy positions ≤1000 (operator can pick a later slot
    // or omit the field to tail-append). int32 ceiling — comfortably
    // below MySQL signed-int32 limit (2_147_483_647).
    position: z.number().int().min(0).max(2_000_000_000).optional(),
    parentId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .optional()

type RouteCtx = { params: Promise<{ id: string }> }

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

// Sentinel thrown inside the TX when the soft-deleted row's data
// fails parseForRead. Carries the operator + row metadata so the
// surrounding handler can write a forensic audit row AFTER the TX
// rolls back (the audit insert would otherwise rollback alongside
// the restore). Distinct from HttpError so the catch can disambiguate.
interface BlockDataInvalidPayload {
  userId: number
  blockId: number
  blockType: string
  version: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}
class BlockDataInvalidError extends Error {
  readonly payload: BlockDataInvalidPayload
  constructor(payload: BlockDataInvalidPayload) {
    super('block_data_invalid')
    this.payload = payload
  }
}

// Kind-transition validation for slot-aware restore. Mirrors POST
// /api/cms/blocks and reorder route — sections live top-level,
// columns under sections, widgets under columns or top-level.
function validateRestoreSlot(
  blockKind: BlockKind,
  newParentKind: BlockKind | null,
): string | null {
  if (blockKind === 'section' && newParentKind !== null) {
    return 'section_cannot_have_parent'
  }
  if (blockKind === 'column') {
    if (newParentKind === null) return 'column_parent_required'
    if (newParentKind !== 'section') return 'column_parent_must_be_section'
  }
  if (blockKind === 'widget' && newParentKind !== null && newParentKind !== 'column') {
    return 'widget_parent_must_be_column'
  }
  return null
}

// Restore a soft-deleted block. Re-appends to the tail position of its
// page (master spec §4: position = MAX+1000), restores media_references
// from the data JSON walker, and clears deleted_at. Fixed-key restoration
// is allowed (a fixed-key block may have been soft-deleted by an admin
// bypass; restore puts it back where the template expects it).
export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'blocks', 'write')
  checkCmsMutationRate(ctx)

  // Chunk J — parse optional body. Empty body / no body is the
  // pre-Chunk-J default (cascade: false). cascade: true is the undo
  // path for DELETE-CONTAINER.
  //
  // Surface malformed bodies as 400. Earlier draft silently defaulted
  // to cascade=false on any parse failure — an operator who typo'd
  // `cascade: "yes"` (string) would get a non-cascade restore with no
  // indication their intent was dropped (agent-review MEDIUM info-leak
  // / downgrade finding).
  let cascade = false
  let requestedPosition: number | undefined
  let requestedParentId: number | null | undefined
  const raw = (await readJsonBody(req).catch(() => null)) as unknown
  if (raw !== null && raw !== undefined && raw !== '') {
    try {
      const parsed = PostBody.parse(raw)
      cascade = parsed?.cascade ?? false
      requestedPosition = parsed?.position
      requestedParentId = parsed?.parentId
    } catch {
      throw new HttpError(400, 'invalid_body')
    }
  }
  const hasSlotPosition = requestedPosition !== undefined
  const hasSlotParent = requestedParentId !== undefined
  if (hasSlotPosition !== hasSlotParent) {
    // Slot-aware restore requires BOTH halves. Half-supplied bodies
    // are operator bugs — refuse rather than guess the other half.
    throw new HttpError(400, 'position_and_parent_id_required_together')
  }
  const slotAwareRestore = hasSlotPosition && hasSlotParent

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  // Cron-purge horizon. The purge worker hard-deletes soft-deleted
  // rows whose deleted_at < NOW() - 30 days. The FE's undo path needs
  // to distinguish "row was purged, fall back to recreate" from "row
  // never existed" — both 404 but distinct machine-readable codes.
  // The horizon below is informational for the response code only;
  // the canonical purge cron + interval lives in lib/cms/purge.ts.
  const PURGE_HORIZON_DAYS = 30

  let txResult: {
    newVersion: number
    newPageVersion: number
    resolvedParentId: number | null
    nextPos: number
    queueRowId: number
    tags: string[]
  }
  try {
    txResult = await db.transaction(async (tx) => {
    // Lock the pages row FIRST (deadlock pre-emption — same lock order
    // as saveBlock: pages → content_blocks). Restore bumps
    // pages.version below; without this FIRST-position lock, a
    // concurrent saveBlock could grab pages then wait for our
    // content_blocks lock while we wait for pages on the bump path.
    const [pageLockRows] = (await tx.execute(sql`
      SELECT id, version, slug, deleted_at FROM pages
      WHERE id = (SELECT page_id FROM content_blocks WHERE id = ${id})
      FOR UPDATE
    `)) as unknown as [
      Array<{
        id: number
        version: number
        slug: string
        deleted_at: Date | string | null
      }>,
    ]
    const pageLock = pageLockRows[0]
    if (!pageLock) {
      // Either content_blocks row doesn't exist OR pages row vanished
      // — both surface as 404 block_purged so the FE undo path routes
      // to recreate.
      throw new HttpError(404, 'block_purged')
    }
    if (pageLock.deleted_at !== null) {
      // Page is in trash — operator must restore the page first. Same
      // code as the per-block trashed-page branch below for consistency.
      throw new HttpError(404, 'not_found')
    }

    // Pre-check: row exists but is hard-deleted OR row exists but is
    // past the purge horizon. Both surface as 404 block_purged so the
    // FE can route the undo to a recreate flow. A row that NEVER
    // existed stays 404 not_found.
    //
    // The SELECT is intentionally permissive (no deleted_at filter)
    // so we can read the row state and decide which 404 code to
    // emit. The page-trashed branch also keeps surfacing as
    // not_found — same as before; no operator can usefully recover
    // from a page in trash without restoring the page first.
    const [allRows] = (await tx.execute(sql`
      SELECT cb.id, cb.page_id, cb.kind, cb.block_type, cb.data, cb.version, cb.deleted_at, p.slug, p.deleted_at AS page_deleted_at
      FROM content_blocks cb
      JOIN pages p ON p.id = cb.page_id
      WHERE cb.id = ${id}
      FOR UPDATE
    `)) as unknown as [
      Array<{
        id: number
        page_id: number
        kind: BlockKind
        block_type: string
        data: string
        version: number
        deleted_at: Date | string | null
        slug: string
        page_deleted_at: Date | string | null
      }>,
    ]
    const candidate = allRows[0]
    if (!candidate) {
      // Row genuinely missing — never existed OR cron-purged + the
      // row is gone from the table entirely. FE distinguishes via
      // the machine-readable code below.
      throw new HttpError(404, 'block_purged')
    }
    if (candidate.page_deleted_at !== null) {
      // Page is in trash — same as "missing" from operator POV.
      throw new HttpError(404, 'not_found')
    }
    if (candidate.deleted_at === null) {
      // Row is alive — operator already restored it elsewhere OR is
      // restoring a row that was never deleted. Distinct code so the
      // FE can no-op the optimistic state instead of erroring.
      throw new HttpError(409, 'already_restored')
    }
    // Past-horizon check. The row is still in the table (cron hasn't
    // hard-deleted it yet) but its deleted_at is older than the
    // purge horizon, so the FE should NOT trust the restore to
    // succeed at the next purge tick. Emit the same machine-readable
    // code as a fully-purged row so the FE recreate path triggers
    // regardless of whether the cron has run yet.
    const deletedAtMs =
      candidate.deleted_at instanceof Date
        ? candidate.deleted_at.getTime()
        : new Date(candidate.deleted_at).getTime()
    const purgeHorizonMs = Date.now() - PURGE_HORIZON_DAYS * 24 * 60 * 60 * 1000
    if (deletedAtMs < purgeHorizonMs) {
      throw new HttpError(404, 'block_purged')
    }
    const row = candidate

    // Re-validate the soft-deleted payload through the read boundary BEFORE
    // we revive media_references. If a row was authored under an older /
    // looser schema (or via a manual SQL INSERT bypass), restoring its
    // unsanitized refs would inject stale paths into the index; the row
    // itself would then fail parseForRead at next render, blanking the
    // block. Better to refuse the restore with a clear 409 than ship a
    // broken row + ghost refs.
    let parsed: unknown
    try {
      const raw = JSON.parse(row.data)
      parsed = parseForRead(row.block_type, raw)
    } catch {
      // F6: write an audit row capturing the rejection so silent
      // restore failures are forensically visible. The audit insert
      // is INSIDE the TX but the TX gets rolled back by the throw
      // below — so we capture the diff payload for a separate
      // best-effort write AFTER the rollback.
      throw new BlockDataInvalidError({
        userId: ctx.userId,
        blockId: row.id,
        blockType: row.block_type,
        version: row.version,
        ip,
        userAgent,
        requestId,
      })
    }

    // Slot-aware restore: the FE undo path supplies the (parentId,
    // position) the operator originally occupied so the restored row
    // lands EXACTLY where it was, not at the page tail. Pre-Chunk-K
    // callers omit both fields and fall through to the tail-append
    // behaviour below.
    let resolvedParentId: number | null
    let nextPos: number
    // Track whether the slot-aware path successfully validated; if the
    // requested parent is gone we fall back to the tail-append branch
    // below so the operator's ⌘Z still succeeds (with the restored row
    // at the end rather than the original slot — better than refusing
    // every undo that follows a cascading delete).
    let slotAwarePathTaken = false
    if (slotAwareRestore) {
      const requestedParent = requestedParentId as number | null
      // Validate the requested parent (kind transition + same-page +
      // not soft-deleted). null = top-level.
      let parentKind: BlockKind | null = null
      let parentGone = false
      if (requestedParent !== null) {
        const [parentRows] = (await tx.execute(sql`
          SELECT id, kind, page_id
          FROM content_blocks
          WHERE id = ${requestedParent}
            AND deleted_at IS NULL
          FOR UPDATE
        `)) as unknown as [
          Array<{ id: number; kind: BlockKind; page_id: number }>,
        ]
        const parentRow = parentRows[0]
        if (!parentRow || parentRow.page_id !== row.page_id) {
          // Captured parent was deleted (or never matched this page)
          // between the original delete and this restore — e.g. the
          // operator ⌘Z'd a widget AFTER also deleting its parent
          // column. Degrade to tail-append at top-level rather than
          // refusing — operator-visible undo with no surprise 409.
          // Log structured so the soft slot-loss is observable.
          parentGone = true
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'restore_captured_parent_gone_falling_back_to_tail',
              block_id: row.id,
              requested_parent: requestedParent,
              page_id: row.page_id,
            }),
          )
        } else {
          parentKind = parentRow.kind
        }
      }
      if (!parentGone) {
        const transitionErr = validateRestoreSlot(row.kind, parentKind)
        if (transitionErr !== null) {
          throw new HttpError(409, transitionErr)
        }
        resolvedParentId = requestedParent
        slotAwarePathTaken = true
      } else {
        resolvedParentId = null
      }
    } else {
      resolvedParentId = null
    }
    if (slotAwarePathTaken) {

      // Bisect siblings around the requested position. The restored
      // row lands at the EXACT requested position when the gap is
      // free, otherwise bisects with the nearest pair. If no gap
      // exists (positions rebalanced since the delete), 409 — the FE
      // can refresh + retry with the freshest tree.
      const [siblings] = (await tx.execute(sql`
        SELECT id, position
        FROM content_blocks
        WHERE page_id = ${row.page_id}
          AND deleted_at IS NULL
          AND parent_id ${resolvedParentId === null ? sql`IS NULL` : sql`= ${resolvedParentId}`}
        ORDER BY position
      `)) as unknown as [Array<{ id: number; position: number }>]
      const targetPos = requestedPosition as number
      // Find the first sibling whose position is >= targetPos. The
      // restored row inserts BEFORE that sibling (bisect with its
      // predecessor). If no such sibling exists, append to tail.
      const afterIdx = siblings.findIndex((s) => s.position >= targetPos)
      if (afterIdx === -1) {
        // Tail-append within parent.
        nextPos =
          siblings.length === 0
            ? 1000
            : siblings[siblings.length - 1]!.position + 1000
      } else if (siblings[afterIdx]!.position > targetPos) {
        // Gap exists at the exact requested position — use it.
        if (afterIdx === 0) {
          // No predecessor — head insert.
          nextPos = targetPos
          if (nextPos <= 0 || nextPos >= siblings[0]!.position) {
            throw new HttpError(409, 'position_gap_exhausted')
          }
        } else {
          // Predecessor exists — verify targetPos is between them.
          const prev = siblings[afterIdx - 1]!.position
          if (targetPos > prev && targetPos < siblings[afterIdx]!.position) {
            nextPos = targetPos
          } else {
            // Requested position doesn't fit — bisect predecessor + successor.
            nextPos = Math.floor((prev + siblings[afterIdx]!.position) / 2)
            if (nextPos <= prev || nextPos >= siblings[afterIdx]!.position) {
              throw new HttpError(409, 'position_gap_exhausted')
            }
          }
        }
      } else {
        // Exact collision (siblings[afterIdx].position === targetPos).
        // Bisect with the next sibling (or tail-append if last).
        const nextSibling = siblings[afterIdx + 1]
        if (!nextSibling) {
          nextPos = siblings[afterIdx]!.position + 1000
        } else {
          nextPos = Math.floor(
            (siblings[afterIdx]!.position + nextSibling.position) / 2,
          )
          if (
            nextPos <= siblings[afterIdx]!.position ||
            nextPos >= nextSibling.position
          ) {
            throw new HttpError(409, 'position_gap_exhausted')
          }
        }
      }
    } else {
      // Pre-Chunk-K tail-append fallback. Keeps current parent
      // (which for soft-deleted rows is the original parent at
      // delete time — DELETE doesn't null parent_id).
      const [origParentRows] = (await tx.execute(sql`
        SELECT parent_id FROM content_blocks WHERE id = ${id}
      `)) as unknown as [Array<{ parent_id: number | null }>]
      resolvedParentId = origParentRows[0]?.parent_id ?? null
      const [maxRows] = (await tx.execute(sql`
        SELECT COALESCE(MAX(position), 0) AS maxPos
        FROM content_blocks
        WHERE page_id = ${row.page_id} AND deleted_at IS NULL
      `)) as unknown as [Array<{ maxPos: number }>]
      nextPos = Number(maxRows[0]?.maxPos ?? 0) + 1000
    }

    // Apply restore: clear deleted_at, set new position, bump version,
    // and (for slot-aware restore) set parent_id to the resolved
    // target. `slotAwarePathTaken` is true only when the requested
    // parent validated; when the parent was gone we silently fell back
    // to tail-append at top-level and we also need to re-parent (so the
    // restored row doesn't keep pointing at the soft-deleted parent_id).
    if (slotAwarePathTaken) {
      await tx.execute(sql`
        UPDATE content_blocks
        SET deleted_at = NULL,
            position = ${nextPos},
            parent_id = ${resolvedParentId},
            version = version + 1,
            updated_by = ${ctx.userId}
        WHERE id = ${id}
      `)
    } else if (slotAwareRestore) {
      // Slot-aware was requested but degraded (parent gone). Re-parent
      // to null (top-level) and tail-append, same shape as the legacy
      // fallback UPDATE.
      await tx.execute(sql`
        UPDATE content_blocks
        SET deleted_at = NULL,
            position = ${nextPos},
            parent_id = NULL,
            version = version + 1,
            updated_by = ${ctx.userId}
        WHERE id = ${id}
      `)
    } else {
      await tx.execute(sql`
        UPDATE content_blocks
        SET deleted_at = NULL, position = ${nextPos}, version = version + 1, updated_by = ${ctx.userId}
        WHERE id = ${id}
      `)
    }

    // Chunk J — cascade restore for DELETE-CONTAINER undo. The CTE
    // walks the descendant tree filtered to rows whose `deleted_at`
    // EXACTLY MATCHES the root's `deleted_at`. The DELETE recursive
    // cascade (in /api/cms/blocks/[id] DELETE handler) writes a single
    // NOW(3) value to every cascaded row in one batched UPDATE, so the
    // gesture's deleted_at timestamp is uniform across the subtree.
    //
    // WITHOUT this exact-match filter the cascade would un-delete rows
    // that were soft-deleted by a SEPARATE earlier gesture and happen
    // to sit under the root's subtree. Example: widget W was deleted
    // last week; section S (containing W's column) was deleted today;
    // restoring S today would resurrect W against the operator's
    // intent. The agent-review CRITICAL finding #1 — fixed by scoping
    // the cascade to gesture-timestamp.
    //
    // `row.deleted_at` is the root's value captured in the lock SELECT
    // above. The descendants must be == that value (millisecond
    // precision — NOW(3) on the DELETE handler is fractional seconds).
    let cascadedIds: number[] = []
    if (cascade) {
      const rootDeletedAt = row.deleted_at
      const [descRows] = (await tx.execute(sql`
        WITH RECURSIVE soft_descendants AS (
          SELECT id, deleted_at
            FROM content_blocks
           WHERE parent_id = ${id}
             AND deleted_at = ${rootDeletedAt}
          UNION ALL
          SELECT cb.id, cb.deleted_at
            FROM content_blocks cb
            INNER JOIN soft_descendants d ON cb.parent_id = d.id
           WHERE cb.deleted_at = ${rootDeletedAt}
        )
        SELECT id FROM soft_descendants
      `)) as unknown as [Array<{ id: number }>]
      cascadedIds = descRows.map((r) => r.id)
      if (cascadedIds.length > 0) {
        await tx.execute(sql`
          UPDATE content_blocks
          SET deleted_at = NULL,
              version = version + 1,
              updated_by = ${ctx.userId}
          WHERE id IN (${sql.join(cascadedIds, sql.raw(','))})
        `)
      }
    }

    // Restore media_references from the validated payload. Lock + verify
    // the media rows are still alive — a media row deleted while the
    // block was soft-deleted must not be silently re-referenced on
    // restore (404 media_missing; admin needs to upload the replacement).
    const refs = collectMediaPaths(parsed)
    const mediaIds = [...new Set(refs.map((r) => r.mediaId))]
    await assertMediaAvailable(tx, mediaIds)
    for (const r of refs) {
      await tx.execute(sql`
        INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
        VALUES (${r.mediaId}, 'content_block', ${id}, ${r.field})
      `)
    }

    await tx.insert(auditLog).values({
      userId: ctx.userId,
      tokenId: ctx.tokenId,
      action: 'restore',
      resourceType: 'content_block',
      resourceId: String(id),
      diff: {
        kind: AUDIT_KIND.restore,
        block_type: row.block_type,
        version: row.version + 1,
      } as unknown as object,
      ip,
      userAgent,
      requestId,
    })

    // Bump pages.version so a concurrent in-flight PATCH that holds a
    // stale page-cursor surfaces as 409 stale_page_version. The page
    // row was already locked FOR UPDATE at the top of the TX
    // (deadlock pre-emption — pages → content_blocks lock order
    // matches saveBlock).
    await tx.execute(sql`
      UPDATE pages
      SET version = version + 1, updated_at = NOW(3), updated_by = ${ctx.userId}
      WHERE id = ${row.page_id}
    `)
    const newPageVersion = pageLock.version + 1

    const tags = tagsForBlockSave(row.slug, row.block_type).tags
    const queueRowId = await enqueueRevalidate(tx, tags)
    return {
      newVersion: row.version + 1,
      newPageVersion,
      resolvedParentId,
      nextPos,
      queueRowId,
      tags,
    }
    })
  } catch (e) {
    // F6: parseForRead rejection emits a forensic audit row AFTER the
    // TX rolls back (a write inside the rolled-back TX would vanish
    // alongside the restore attempt). Best-effort — if the audit
    // insert itself fails we still surface the 409 to the operator;
    // the silent-rejection problem we're solving is "no record at all"
    // not "double record" so failure-to-log degrades gracefully to
    // pre-Chunk-K behaviour. Operator-facing message stays generic.
    if (e instanceof BlockDataInvalidError) {
      try {
        await db.insert(auditLog).values({
          userId: e.payload.userId,
          tokenId: ctx.tokenId,
          action: 'restore',
          resourceType: 'content_block',
          resourceId: String(e.payload.blockId),
          diff: {
            kind: AUDIT_KIND.restoreRejectedInvalidData,
            block_type: e.payload.blockType,
            version: e.payload.version,
          } as unknown as object,
          ip: e.payload.ip,
          userAgent: e.payload.userAgent,
          requestId: e.payload.requestId,
        })
      } catch {
        // Audit insert failed (DB temporarily unavailable, etc.).
        // The 409 below still surfaces to the operator; the missing
        // audit row is the worse-case fallback. Intentionally
        // swallow rather than masking the original 409 with a 500.
      }
      throw new HttpError(409, 'block_data_invalid')
    }
    throw e
  }

  queueMicrotask(() => {
    void drainRevalidate(txResult.queueRowId, txResult.tags)
  })
  return new Response(
    JSON.stringify({
      restored: true,
      version: txResult.newVersion,
      pageVersion: txResult.newPageVersion,
      parentId: txResult.resolvedParentId,
      position: txResult.nextPos,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    },
  )
})
