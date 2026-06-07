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

// ─── Undo/redo via server-side draft revisions (migration 0029) ───
// Each committed draft change records a FULL-TREE snapshot as a revision row.
// Undo/redo restore a revision by reconciling the live+draft columns of every
// block to match the snapshot. The cursor (pages.draft_undo_cursor) is the seq
// of the current state; seq 0 is the baseline (clean draft) recorded before the
// first edit so undo can return to the published state.

const MAX_DRAFT_REVISIONS = 80

interface SnapRow {
  id: number
  parent_id: number | null
  kind: string
  block_key: string | null
  block_type: string
  position: number
  data: string
  meta: string | null
  version: number
  draft_data: string | null
  draft_meta: string | null
  draft_position: number | null
  draft_parent_id: number | null
  draft_state: string
}

// Full snapshot of a page's draft-relevant rows (everything not hard-deleted).
async function snapshotPageDraft(tx: Tx, pageId: number): Promise<string> {
  const [rows] = (await tx.execute(sql`
    SELECT id, parent_id, kind, block_key, block_type, position, data, meta, version,
           draft_data, draft_meta, draft_position, draft_parent_id, draft_state
    FROM content_blocks
    WHERE page_id = ${pageId} AND deleted_at IS NULL
    ORDER BY id
  `)) as unknown as [SnapRow[]]
  return JSON.stringify(rows)
}

// Record the clean baseline (seq 0) the first time a page's draft is touched —
// called BEFORE the change is applied so undo can return to the published state.
export async function ensureDraftBaseline(
  tx: Tx,
  pageId: number,
  userId: number,
): Promise<void> {
  const [cnt] = (await tx.execute(sql`
    SELECT COUNT(*) AS n FROM page_draft_revisions WHERE page_id = ${pageId}
  `)) as unknown as [Array<{ n: number }>]
  if (Number(cnt[0]?.n ?? 0) > 0) return
  const snap = await snapshotPageDraft(tx, pageId)
  await tx.execute(sql`
    INSERT INTO page_draft_revisions (page_id, seq, snapshot, label, created_by)
    VALUES (${pageId}, 0, ${snap}, 'Baseline', ${userId})
  `)
  await tx.execute(sql`UPDATE pages SET draft_undo_cursor = 0 WHERE id = ${pageId}`)
}

// Record a new revision = the CURRENT (post-change) draft state. Truncates any
// redo tail, appends seq = cursor+1, advances the cursor, prunes to the cap.
export async function recordDraftRevision(
  tx: Tx,
  pageId: number,
  userId: number,
  label: string,
): Promise<void> {
  const [pr] = (await tx.execute(sql`
    SELECT draft_undo_cursor AS c FROM pages WHERE id = ${pageId}
  `)) as unknown as [Array<{ c: number }>]
  const cursor = Number(pr[0]?.c ?? 0)
  // Drop any redo tail (revisions ahead of the cursor).
  await tx.execute(sql`
    DELETE FROM page_draft_revisions WHERE page_id = ${pageId} AND seq > ${cursor}
  `)
  const nextSeq = cursor + 1
  const snap = await snapshotPageDraft(tx, pageId)
  await tx.execute(sql`
    INSERT INTO page_draft_revisions (page_id, seq, snapshot, label, created_by)
    VALUES (${pageId}, ${nextSeq}, ${snap}, ${label.slice(0, 120)}, ${userId})
  `)
  await tx.execute(sql`UPDATE pages SET draft_undo_cursor = ${nextSeq} WHERE id = ${pageId}`)
  // Cap the history depth (oldest first).
  const [c2] = (await tx.execute(sql`
    SELECT COUNT(*) AS n FROM page_draft_revisions WHERE page_id = ${pageId}
  `)) as unknown as [Array<{ n: number }>]
  if (Number(c2[0]?.n ?? 0) > MAX_DRAFT_REVISIONS) {
    await tx.execute(sql`
      DELETE FROM page_draft_revisions WHERE page_id = ${pageId}
      ORDER BY seq ASC LIMIT 1
    `)
  }
}

// Reconcile the page's draft rows to EXACTLY match a snapshot.
async function restoreSnapshot(
  tx: Tx,
  pageId: number,
  snapshotJson: string,
): Promise<void> {
  const snap = JSON.parse(snapshotJson) as SnapRow[]
  const snapById = new Map(snap.map((r) => [r.id, r]))
  const [curRows] = (await tx.execute(sql`
    SELECT id, kind FROM content_blocks WHERE page_id = ${pageId} AND deleted_at IS NULL
  `)) as unknown as [Array<{ id: number; kind: string }>]
  const curIds = new Set(curRows.map((r) => r.id))

  // 1. Delete rows that exist now but weren't in the snapshot (created after).
  //    FK ON DELETE CASCADE removes any added descendants automatically.
  for (const r of curRows) {
    if (!snapById.has(r.id)) {
      await tx.execute(sql`
        DELETE FROM content_blocks WHERE id = ${r.id} AND page_id = ${pageId}
      `)
    }
  }
  // 2. Re-insert rows that were in the snapshot but hard-deleted since (parents
  //    first so FK parent_id resolves).
  const order: Record<string, number> = { section: 0, column: 1, widget: 2 }
  const missing = snap
    .filter((r) => !curIds.has(r.id))
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
  for (const r of missing) {
    await tx.execute(sql`
      INSERT INTO content_blocks
        (id, page_id, parent_id, kind, block_key, block_type, position, data, meta,
         version, draft_data, draft_meta, draft_position, draft_parent_id, draft_state)
      VALUES
        (${r.id}, ${pageId}, ${r.parent_id}, ${r.kind}, ${r.block_key}, ${r.block_type},
         ${r.position}, ${r.data}, ${r.meta}, ${r.version}, ${r.draft_data}, ${r.draft_meta},
         ${r.draft_position}, ${r.draft_parent_id}, ${r.draft_state})
    `)
  }
  // 3. Update every still-present snapshot row to its snapshot column values.
  for (const r of snap) {
    if (curIds.has(r.id)) {
      await tx.execute(sql`
        UPDATE content_blocks SET
          parent_id = ${r.parent_id}, position = ${r.position},
          data = ${r.data}, meta = ${r.meta},
          draft_data = ${r.draft_data}, draft_meta = ${r.draft_meta},
          draft_position = ${r.draft_position}, draft_parent_id = ${r.draft_parent_id},
          draft_state = ${r.draft_state}
        WHERE id = ${r.id} AND page_id = ${pageId}
      `)
    }
  }
}

// After a restore: point the cursor, bump draft_version, recompute has_draft.
async function applyCursor(
  tx: Tx,
  pageId: number,
  userId: number,
  cursor: number,
): Promise<number> {
  const [h] = (await tx.execute(sql`
    SELECT COUNT(*) AS n FROM content_blocks
    WHERE page_id = ${pageId} AND draft_state <> 'live' AND deleted_at IS NULL
  `)) as unknown as [Array<{ n: number }>]
  const hasDraft = Number(h[0]?.n ?? 0) > 0 ? 1 : 0
  await tx.execute(sql`
    UPDATE pages SET draft_undo_cursor = ${cursor}, draft_version = draft_version + 1,
        has_draft = ${hasDraft}, draft_updated_at = NOW(3), draft_updated_by = ${userId}
    WHERE id = ${pageId}
  `)
  const [dv] = (await tx.execute(sql`
    SELECT draft_version FROM pages WHERE id = ${pageId}
  `)) as unknown as [Array<{ draft_version: number }>]
  return dv[0]?.draft_version ?? 0
}

async function step(
  pageId: number,
  userId: number,
  dir: 1 | -1,
): Promise<{ ok: boolean; draftVersion: number }> {
  return db.transaction(async (tx) => {
    const [pr] = (await tx.execute(sql`
      SELECT draft_undo_cursor AS c FROM pages
      WHERE id = ${pageId} AND deleted_at IS NULL FOR UPDATE
    `)) as unknown as [Array<{ c: number }>]
    if (!pr[0]) throw new NotFoundError()
    const cursor = Number(pr[0].c)
    const target = cursor + dir
    const [rev] = (await tx.execute(sql`
      SELECT snapshot FROM page_draft_revisions
      WHERE page_id = ${pageId} AND seq = ${target}
    `)) as unknown as [Array<{ snapshot: string }>]
    if (!rev[0]) return { ok: false, draftVersion: 0 }
    await restoreSnapshot(tx, pageId, rev[0].snapshot)
    const draftVersion = await applyCursor(tx, pageId, userId, target)
    return { ok: true, draftVersion }
  })
}

export const undoDraft = (pageId: number, userId: number) =>
  step(pageId, userId, -1)
export const redoDraft = (pageId: number, userId: number) =>
  step(pageId, userId, 1)

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
    await ensureDraftBaseline(tx, args.pageId, args.userId)
    await tx.execute(sql`
      UPDATE content_blocks
      SET draft_data = ${parsedJson}, draft_state = ${nextState}
      WHERE id = ${args.blockId}
    `)
    const draftVersion = await bumpPageDraft(tx, args.pageId, args.userId)
    await recordDraftRevision(tx, args.pageId, args.userId, `Edit ${row.block_type}`)
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
    await ensureDraftBaseline(tx, args.pageId, args.userId)
    await tx.execute(sql`
      UPDATE content_blocks
      SET draft_meta = ${args.metaJson}, draft_state = ${nextState}
      WHERE id = ${args.blockId}
    `)
    const draftVersion = await bumpPageDraft(tx, args.pageId, args.userId)
    await recordDraftRevision(tx, args.pageId, args.userId, `Edit ${row.kind} settings`)
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
      // Recursive descent over the EFFECTIVE draft parentage
      // (COALESCE(draft_parent_id, parent_id)) so a column/widget that was
      // draft-reparented INTO this subtree is still collected at any depth.
      // The prior fixed 2-level subquery only followed live parent_id one
      // level deep, so a draft-reparented descendant survived a section
      // delete — left orphaned (still visible + publishable) in the draft.
      const [kids] = (await tx.execute(sql`
        WITH RECURSIVE subtree AS (
          SELECT id FROM content_blocks
          WHERE id = ${args.blockId} AND page_id = ${args.pageId}
            AND deleted_at IS NULL
          UNION ALL
          SELECT cb.id FROM content_blocks cb
          INNER JOIN subtree s
            ON COALESCE(cb.draft_parent_id, cb.parent_id) = s.id
          WHERE cb.page_id = ${args.pageId} AND cb.deleted_at IS NULL
        )
        SELECT id FROM subtree
      `)) as unknown as [Array<{ id: number }>]
      subtreeIds = [...new Set([args.blockId, ...kids.map((k) => k.id)])]
    }
    const idList = sql.join(subtreeIds, sql.raw(','))

    await ensureDraftBaseline(tx, args.pageId, args.userId)
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
    await recordDraftRevision(tx, args.pageId, args.userId, `Delete ${row.kind}`)
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
    await ensureDraftBaseline(tx, args.pageId, args.userId)
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
    await recordDraftRevision(tx, args.pageId, args.userId, 'Reorder blocks')
    return { draftVersion }
  })
}

export interface DraftStatus {
  hasDraft: boolean
  draftVersion: number
  /** count of rows with a pending change (modified + added + removed) */
  changeCount: number
  canUndo: boolean
  canRedo: boolean
}

export async function getPageDraftStatus(pageId: number): Promise<DraftStatus> {
  const [pageRows] = (await db.execute(sql`
    SELECT has_draft, draft_version, draft_undo_cursor FROM pages WHERE id = ${pageId}
  `)) as unknown as [
    Array<{ has_draft: number; draft_version: number; draft_undo_cursor: number }>,
  ]
  const p = pageRows[0]
  if (!p)
    return { hasDraft: false, draftVersion: 0, changeCount: 0, canUndo: false, canRedo: false }
  const [cnt] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM content_blocks
    WHERE page_id = ${pageId} AND draft_state <> 'live'
      AND (deleted_at IS NULL OR draft_state = 'removed')
  `)) as unknown as [Array<{ n: number }>]
  const changeCount = Number(cnt[0]?.n ?? 0)
  const [seqRange] = (await db.execute(sql`
    SELECT MIN(seq) AS mn, MAX(seq) AS mx FROM page_draft_revisions WHERE page_id = ${pageId}
  `)) as unknown as [Array<{ mn: number | null; mx: number | null }>]
  const cursor = Number(p.draft_undo_cursor ?? 0)
  const mn = seqRange[0]?.mn
  const mx = seqRange[0]?.mx
  return {
    hasDraft: p.has_draft === 1 || changeCount > 0,
    draftVersion: p.draft_version,
    changeCount,
    canUndo: mn != null && cursor > Number(mn),
    canRedo: mx != null && cursor < Number(mx),
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
  // Acting API token id (null for a cookie-session publish) — attributes the
  // publish audit row to the specific token, matching the sync/backup audit
  // rows so a forensic trail can tell an agent's publish from a UI publish.
  tokenId?: number | null
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
      SET has_draft = 0, draft_version = 0, draft_undo_cursor = 0,
          draft_updated_at = NULL, draft_updated_by = NULL,
          version = ${newPageVersion},
          published = 1,
          published_at = COALESCE(published_at, NOW(3)),
          updated_by = ${args.userId}, updated_at = NOW(3)
      WHERE id = ${args.pageId}
    `)
    // The draft is now live — wipe its undo/redo history.
    await tx.execute(sql`DELETE FROM page_draft_revisions WHERE page_id = ${args.pageId}`)

    // 5. Audit the publish (one summary row, not per-block).
    await tx.insert(auditLog).values({
      userId: args.userId,
      tokenId: args.tokenId ?? null,
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
      SET has_draft = 0, draft_version = 0, draft_undo_cursor = 0,
          draft_updated_at = NULL, draft_updated_by = NULL
      WHERE id = ${args.pageId}
    `)
    await tx.execute(sql`DELETE FROM page_draft_revisions WHERE page_id = ${args.pageId}`)
  })
  return { ok: true }
}
