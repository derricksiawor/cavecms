import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { parseAndSanitize } from './parse'
import { collectMediaPaths } from './mediaRefs'
import { assertMediaAvailable } from './mediaCheck'
import { NotFoundError, WrongKindError, InvalidMetaJsonError } from './saveBlock'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForPageSave } from '@/lib/cache/tags'
import type { BlockKind } from './blockMeta'

// ─────────────────────────────────────────────────────────────────────────
// Draft → Publish write layer (migration 0028).
//
// The inline editor NEVER mutates the published columns anymore — every edit
// lands in the draft overlay (draft_data / draft_meta / draft_position /
// draft_parent_id + draft_state) and the public site is unaffected until the
// operator clicks Publish. Because the draft is a single operator's private
// working copy, draft writes are LAST-WRITE-WINS — there is no dual-axis
// optimistic lock (that lock, gating every per-block edit on the shared
// pages.version, was the entire source of the "page changed since" undo bug).
// Concurrency across devices is advisory: pages.draft_version advances on each
// write so a second tab can detect "draft changed elsewhere".
//
// draft_state lifecycle per row:
//   live     — no pending change
//   modified — draft_data/draft_meta/draft_position/draft_parent_id hold the edit
//   added    — created in the draft (live cols hold the content; public EXCLUDES it)
//   removed  — deleted in the draft (public KEEPS it until publish; editor EXCLUDES)
//
// Publish materialises COALESCE(draft_*, live) into the live columns in one TX
// (added+modified), soft-deletes 'removed', rebuilds media_references, bumps
// pages.version (the published lock), revalidates, and audits. Discard reverts.
// ─────────────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Bump the page's draft cursor + flag. Returns the new draft_version so the
// client can track it for the advisory "draft changed elsewhere" banner.
async function bumpPageDraft(
  tx: Tx,
  pageId: number,
  userId: number,
): Promise<number> {
  await tx.execute(sql`
    UPDATE pages
    SET draft_version = draft_version + 1,
        has_draft = 1,
        draft_updated_at = NOW(3),
        draft_updated_by = ${userId}
    WHERE id = ${pageId} AND deleted_at IS NULL
  `)
  const [rows] = (await tx.execute(sql`
    SELECT draft_version FROM pages WHERE id = ${pageId}
  `)) as unknown as [Array<{ draft_version: number }>]
  return rows[0]?.draft_version ?? 0
}

/** Save a widget's data into the draft overlay. Last-write-wins. */
export async function saveDraftBlockData(args: {
  blockId: number
  pageId: number
  userId: number
  data: unknown
}): Promise<{ draftVersion: number }> {
  return db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, block_type, kind, draft_state
      FROM content_blocks
      WHERE id = ${args.blockId} AND page_id = ${args.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [
      Array<{ id: number; block_type: string; kind: BlockKind; draft_state: string }>,
    ]
    const row = rows[0]
    if (!row) throw new NotFoundError()
    if (row.kind !== 'widget') throw new WrongKindError()

    // Write boundary (Zod + DOMPurify) — same trust boundary as a live save.
    const parsedJson = JSON.stringify(parseAndSanitize(row.block_type, args.data))
    // An 'added' row keeps its state (it's draft-only either way); a 'live'
    // row becomes 'modified'. 'removed' rows aren't editable from the canvas.
    const nextState = row.draft_state === 'added' ? 'added' : 'modified'
    await tx.execute(sql`
      UPDATE content_blocks
      SET draft_data = ${parsedJson}, draft_state = ${nextState}
      WHERE id = ${args.blockId}
    `)
    const draftVersion = await bumpPageDraft(tx, args.pageId, args.userId)
    return { draftVersion }
  })
}

/** Save a section/column/widget's meta into the draft overlay. */
export async function saveDraftBlockMeta(args: {
  blockId: number
  pageId: number
  userId: number
  expectedKind: BlockKind
  metaJson: string
}): Promise<{ draftVersion: number }> {
  // Validate the JSON shape early (the route already schema-validates the
  // meta; this guards a hand-built payload from a 500).
  try {
    JSON.parse(args.metaJson)
  } catch {
    throw new InvalidMetaJsonError()
  }
  return db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, kind, draft_state
      FROM content_blocks
      WHERE id = ${args.blockId} AND page_id = ${args.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; kind: BlockKind; draft_state: string }>]
    const row = rows[0]
    if (!row) throw new NotFoundError()
    if (row.kind !== args.expectedKind) throw new WrongKindError()

    const nextState = row.draft_state === 'added' ? 'added' : 'modified'
    await tx.execute(sql`
      UPDATE content_blocks
      SET draft_meta = ${args.metaJson}, draft_state = ${nextState}
      WHERE id = ${args.blockId}
    `)
    const draftVersion = await bumpPageDraft(tx, args.pageId, args.userId)
    return { draftVersion }
  })
}

/**
 * Mark a block (and, for containers, its subtree) as removed-in-draft. A row
 * that was 'added' in this same draft never existed publicly, so it is hard-
 * deleted outright; otherwise it flips to 'removed' (public keeps showing it
 * until publish). Mirrors the live DELETE's recursive-subtree semantics.
 */
export async function deleteDraftBlock(args: {
  blockId: number
  pageId: number
  userId: number
}): Promise<{ draftVersion: number; removedIds: number[] }> {
  return db.transaction(async (tx) => {
    const [rows] = (await tx.execute(sql`
      SELECT id, kind, block_key, draft_state
      FROM content_blocks
      WHERE id = ${args.blockId} AND page_id = ${args.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [
      Array<{ id: number; kind: BlockKind; block_key: string | null; draft_state: string }>,
    ]
    const row = rows[0]
    if (!row) throw new NotFoundError()
    // Fixed-slot blocks (site header/footer) can't be deleted — same guard
    // the live DELETE enforces.
    if (row.block_key !== null) throw new WrongKindError()

    // Collect the subtree (section → columns → widgets). Widgets have no
    // children so the set is just the row itself.
    let subtreeIds = [args.blockId]
    if (row.kind !== 'widget') {
      const [kids] = (await tx.execute(sql`
        SELECT id FROM content_blocks
        WHERE page_id = ${args.pageId} AND deleted_at IS NULL
          AND (id = ${args.blockId}
               OR parent_id = ${args.blockId}
               OR draft_parent_id = ${args.blockId}
               OR parent_id IN (SELECT id FROM (
                    SELECT id FROM content_blocks
                    WHERE page_id = ${args.pageId} AND parent_id = ${args.blockId}
                  ) AS cols)
               OR draft_parent_id IN (SELECT id FROM (
                    SELECT id FROM content_blocks
                    WHERE page_id = ${args.pageId} AND parent_id = ${args.blockId}
                  ) AS cols2))
      `)) as unknown as [Array<{ id: number }>]
      subtreeIds = [...new Set([args.blockId, ...kids.map((k) => k.id)])]
    }
    const idList = sql.join(subtreeIds, sql.raw(','))

    // Hard-delete the rows that were added in THIS draft (never published);
    // flip the rest to 'removed'.
    await tx.execute(sql`
      DELETE FROM content_blocks
      WHERE page_id = ${args.pageId} AND id IN (${idList}) AND draft_state = 'added'
    `)
    await tx.execute(sql`
      UPDATE content_blocks
      SET draft_state = 'removed'
      WHERE page_id = ${args.pageId} AND id IN (${idList}) AND draft_state <> 'added'
    `)
    const draftVersion = await bumpPageDraft(tx, args.pageId, args.userId)
    return { draftVersion, removedIds: subtreeIds }
  })
}

/**
 * Apply a draft reorder/reparent: write draft_position + draft_parent_id for
 * each block. `parentId` undefined → unchanged. Blocks that were 'live' flip
 * to 'modified'; 'added' stay 'added'.
 */
export async function setDraftOrder(args: {
  pageId: number
  userId: number
  blocks: Array<{ id: number; position: number; parentId?: number | null }>
}): Promise<{ draftVersion: number }> {
  return db.transaction(async (tx) => {
    for (const b of args.blocks) {
      if (b.parentId === undefined) {
        await tx.execute(sql`
          UPDATE content_blocks
          SET draft_position = ${b.position},
              draft_state = CASE WHEN draft_state = 'added' THEN 'added' ELSE 'modified' END
          WHERE id = ${b.id} AND page_id = ${args.pageId} AND deleted_at IS NULL
        `)
      } else {
        await tx.execute(sql`
          UPDATE content_blocks
          SET draft_position = ${b.position},
              draft_parent_id = ${b.parentId},
              draft_state = CASE WHEN draft_state = 'added' THEN 'added' ELSE 'modified' END
          WHERE id = ${b.id} AND page_id = ${args.pageId} AND deleted_at IS NULL
        `)
      }
    }
    const draftVersion = await bumpPageDraft(tx, args.pageId, args.userId)
    return { draftVersion }
  })
}

export interface DraftStatus {
  hasDraft: boolean
  draftVersion: number
  /** count of rows with a pending change (modified + added + removed) */
  changeCount: number
}

export async function getPageDraftStatus(pageId: number): Promise<DraftStatus> {
  const [pageRows] = (await db.execute(sql`
    SELECT has_draft, draft_version FROM pages WHERE id = ${pageId}
  `)) as unknown as [Array<{ has_draft: number; draft_version: number }>]
  const p = pageRows[0]
  if (!p) return { hasDraft: false, draftVersion: 0, changeCount: 0 }
  const [cnt] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM content_blocks
    WHERE page_id = ${pageId} AND draft_state <> 'live'
      AND (deleted_at IS NULL OR draft_state = 'removed')
  `)) as unknown as [Array<{ n: number }>]
  const changeCount = Number(cnt[0]?.n ?? 0)
  return {
    hasDraft: p.has_draft === 1 || changeCount > 0,
    draftVersion: p.draft_version,
    changeCount,
  }
}

/**
 * Publish a page's draft: materialise the overlay into the live columns in one
 * transaction, soft-delete removed rows, rebuild media_references from the new
 * live content, bump pages.version, set published, revalidate, audit.
 */
export async function publishPageDraft(args: {
  pageId: number
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}): Promise<{ pageVersion: number; published: number }> {
  const txResult = await db.transaction(async (tx) => {
    const [pageRows] = (await tx.execute(sql`
      SELECT id, slug, version, published FROM pages
      WHERE id = ${args.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [
      Array<{ id: number; slug: string; version: number; published: number }>,
    ]
    const pageRow = pageRows[0]
    if (!pageRow) throw new NotFoundError()

    // 1. Soft-delete rows marked removed-in-draft.
    await tx.execute(sql`
      UPDATE content_blocks
      SET deleted_at = NOW(3), version = version + 1,
          draft_state = 'live', draft_data = NULL, draft_meta = NULL,
          draft_position = NULL, draft_parent_id = NULL
      WHERE page_id = ${args.pageId} AND draft_state = 'removed' AND deleted_at IS NULL
    `)

    // 2. Materialise added + modified: COALESCE(draft_*, live) → live.
    await tx.execute(sql`
      UPDATE content_blocks
      SET data = COALESCE(draft_data, data),
          meta = COALESCE(draft_meta, meta),
          position = COALESCE(draft_position, position),
          parent_id = COALESCE(draft_parent_id, parent_id),
          version = version + 1,
          updated_by = ${args.userId},
          draft_data = NULL, draft_meta = NULL,
          draft_position = NULL, draft_parent_id = NULL,
          draft_state = 'live'
      WHERE page_id = ${args.pageId}
        AND draft_state IN ('added', 'modified')
        AND deleted_at IS NULL
    `)

    // 3. Rebuild media_references for every living widget on the page from
    //    the now-live data. DELETE-then-reinsert is simpler + correct vs a
    //    per-block diff and runs once per publish (not per keystroke).
    const [liveBlocks] = (await tx.execute(sql`
      SELECT id, block_type, data FROM content_blocks
      WHERE page_id = ${args.pageId} AND kind = 'widget' AND deleted_at IS NULL
    `)) as unknown as [Array<{ id: number; block_type: string; data: string }>]
    const blockIds = liveBlocks.map((b) => b.id)
    if (blockIds.length) {
      await tx.execute(sql`
        DELETE FROM media_references
        WHERE referent_type = 'content_block'
          AND referent_id IN (${sql.join(blockIds, sql.raw(','))})
      `)
      const allNewMediaIds = new Set<number>()
      const inserts: Array<{ mediaId: number; blockId: number; field: string }> = []
      for (const b of liveBlocks) {
        let parsed: unknown
        try {
          parsed = JSON.parse(b.data)
        } catch {
          parsed = {}
        }
        for (const r of collectMediaPaths(parsed)) {
          allNewMediaIds.add(r.mediaId)
          inserts.push({ mediaId: r.mediaId, blockId: b.id, field: r.field })
        }
      }
      await assertMediaAvailable(tx, [...allNewMediaIds])
      for (const ins of inserts) {
        await tx.execute(sql`
          INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
          VALUES (${ins.mediaId}, 'content_block', ${ins.blockId}, ${ins.field})
        `)
      }
    }

    // 4. Clear the page draft, bump the published version, publish the page.
    const newPageVersion = pageRow.version + 1
    await tx.execute(sql`
      UPDATE pages
      SET has_draft = 0, draft_version = 0, draft_updated_at = NULL, draft_updated_by = NULL,
          version = ${newPageVersion},
          published = 1,
          published_at = COALESCE(published_at, NOW(3)),
          updated_by = ${args.userId}, updated_at = NOW(3)
      WHERE id = ${args.pageId}
    `)

    // 5. Audit the publish (one summary row, not per-block).
    await tx.insert(auditLog).values({
      userId: args.userId,
      action: 'update',
      resourceType: 'page',
      resourceId: String(args.pageId),
      diff: { kind: 'publish', slug: pageRow.slug } as unknown as object,
      ip: args.ip,
      userAgent: args.userAgent,
      requestId: args.requestId,
    })

    // 6. Revalidate the page's public cache fragments.
    const tags = tagsForPageSave(pageRow.slug).tags
    const queueRowId = tags.length ? await enqueueRevalidate(tx, tags) : null
    return { pageVersion: newPageVersion, queueRowId, tags }
  })

  if (txResult.queueRowId !== null) {
    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId!, txResult.tags)
    })
  }
  return { pageVersion: txResult.pageVersion, published: 1 }
}

/**
 * Discard a page's entire draft: hard-delete rows added-in-draft, revert
 * modified/removed rows back to their published state, clear the page flag.
 */
export async function discardPageDraft(args: {
  pageId: number
  userId: number
}): Promise<{ ok: true }> {
  await db.transaction(async (tx) => {
    const [pageRows] = (await tx.execute(sql`
      SELECT id FROM pages WHERE id = ${args.pageId} AND deleted_at IS NULL FOR UPDATE
    `)) as unknown as [Array<{ id: number }>]
    if (!pageRows[0]) throw new NotFoundError()

    // Added-in-draft rows never existed publicly → hard-delete them.
    await tx.execute(sql`
      DELETE FROM content_blocks
      WHERE page_id = ${args.pageId} AND draft_state = 'added'
    `)
    // Everything else: drop the overlay, back to live.
    await tx.execute(sql`
      UPDATE content_blocks
      SET draft_data = NULL, draft_meta = NULL,
          draft_position = NULL, draft_parent_id = NULL,
          draft_state = 'live'
      WHERE page_id = ${args.pageId} AND draft_state <> 'live'
    `)
    await tx.execute(sql`
      UPDATE pages
      SET has_draft = 0, draft_version = 0, draft_updated_at = NULL, draft_updated_by = NULL
      WHERE id = ${args.pageId}
    `)
  })
  return { ok: true }
}
