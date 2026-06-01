import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { collectMediaPaths } from './mediaRefs'
import { assertMediaAvailable } from './mediaCheck'
import { parseAndSanitize } from './parse'
import { AUDIT_KIND } from './auditKinds'
import { enqueueRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import {
  MAX_SECTION_COLUMNS,
  type BlockKind,
} from './blockMeta'
import { FIXED_BLOCK_KEYS_PER_PAGE } from './block-registry'

// Chunk H — Duplicate a content_blocks row AND every living descendant
// in ONE TX. Mirrors the recursive-CTE pattern used by DELETE
// /api/cms/blocks/[id] for soft-delete cascade so the lock + walk
// semantics are identical.
//
// Lock order matches saveBlock — pages row read FIRST (existence + slug
// for cache tags) then the source content_blocks row FOR UPDATE. We
// DON'T hold FOR UPDATE on pages: POST /api/cms/blocks (the closest
// analogue — it also adds rows without bumping pages.version) doesn't
// lock pages either, and adding a FOR UPDATE here would risk
// deadlocking against §4.3 is_home flips that DO lock pages ASC-by-id.
// The slug we read for cache tags is stable across this short window;
// a concurrent slug rename would invalidate via its own write-path
// revalidate.
//
// pages.version IS NOT BUMPED — symmetric with POST. Duplicate is a
// "create new rows" operation, not a "modify existing block" operation.
// Operators who right-click → Duplicate → then PATCH the duplicate's
// data will hit saveBlock's pages.version bump on that PATCH; the
// optimistic-lock cursor advances at that point, not here.
//
// Subtree cap = 256 rows. Today's spec locks the tree at
// section → column → widget so the natural maximum under
// MAX_SECTION_COLUMNS=4 is 1 + 4 + 4×N widgets — N≈62 widgets per
// column before hitting the cap. Realistic content density tops out
// around 20-30 widgets per column, so 256 is comfortable headroom.
//
// Future scaling: a 4-level tree (section → row → column → widget,
// MAX_ROWS=4 / MAX_COLS_PER_ROW=4) yields N ≈ 15 widgets per column
// before the 256 cap — tight for dense icon-grid layouts. When a
// row/grid level lands, bump the cap to 512 or 1024 in the SAME PR
// rather than discovering the tightness in production.
//
// Beyond the cap the endpoint returns 409 subtree_too_large; the
// operator's path forward is to delete some descendants and retry.
export const MAX_DUPLICATE_SUBTREE_SIZE = 256

// Depth cap on the CTE — MariaDB default cte_max_recursion_depth is
// 1000, but the natural tree is 3 levels (section/column/widget).
// Cap at 16 so a corrupt parent_id cycle (DB-level inconsistency
// that shouldn't ever exist — content_blocks.parent_id is FK'd to
// content_blocks.id ON DELETE CASCADE — but defence in depth) gets
// rejected with a clean error rather than running the CTE to
// 1000-recursion exhaustion.
export const MAX_DUPLICATE_DEPTH = 16

// Error classes — see duplicateBlock() JSDoc for when each is thrown
// and the matching route status codes.
export class DuplicateNotFoundError extends Error {
  constructor() { super('not_found') }
}
export class DuplicateColumnCountExceededError extends Error {
  constructor() { super('column_count_exceeded') }
}
export class DuplicateSubtreeTooLargeError extends Error {
  constructor(public readonly size: number) { super('subtree_too_large') }
}
export class DuplicatePageNotFoundError extends Error {
  constructor() { super('page_not_found') }
}
export class DuplicatePositionGapExhaustedError extends Error {
  constructor() { super('position_gap_exhausted') }
}
// Source row carries data that the current registry rejects (post-deploy
// schema-tightening case). Re-parse + sanitise at duplicate time rather
// than silently committing currently-invalid rows.
export class DuplicateSourceInvalidError extends Error {
  constructor() { super('source_invalid') }
}
// Source is a freeform widget whose block_type is reserved for a fixed
// slot on this page. Allowing the duplicate would create a second row
// of, say, block_type='contact_form' on the contact page (block_key=NULL
// so the UNIQUE constraint doesn't trip — but the page would render two
// contact forms).
export class DuplicateBlockTypeReservedError extends Error {
  constructor() { super('block_type_reserved_for_fixed_slot') }
}
// CTE walk encountered the same row id twice — the underlying tree
// contains a parent_id cycle (DB-level corruption; FK enforcement
// blocks this in normal operation). Refuse rather than insert ghost
// rows under the duplicate's subtree.
export class DuplicateCycleDetectedError extends Error {
  constructor() { super('cycle_detected') }
}

// Strip `htmlId` from a stored meta JSON string. Returns the original
// when the input is null OR doesn't carry an htmlId key. The query path
// in the duplicate INSERT below feeds the result back as the new row's
// meta column — preserving every OTHER field (visibility, spacing,
// background, etc.) while dropping the per-page-unique anchor id so
// the duplicate can take its own.
function stripHtmlIdFromMetaJson(meta: string | null): string | null {
  if (meta === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(meta)
  } catch (e) {
    // Corrupt meta cell — leave the source bytes verbatim so the
    // duplicate inherits whatever the source has (the parse-on-read
    // path will treat the duplicate's meta the same way the source's
    // is treated). Log structured so the operator sees the row id
    // without having to grep the DB.
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'duplicate_block_corrupt_meta',
        err: e instanceof Error ? e.message : String(e),
      }),
    )
    return meta
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return meta
  }
  const obj = parsed as Record<string, unknown>
  if (!('htmlId' in obj)) return meta
  const { htmlId: _htmlId, ...rest } = obj
  void _htmlId
  return JSON.stringify(rest)
}

interface SourceRow {
  id: number
  page_id: number
  parent_id: number | null
  kind: BlockKind
  block_type: string
  position: number
  data: string
  meta: string | null
  block_key: string | null
}

interface DescendantRow {
  id: number
  parent_id: number | null
  kind: BlockKind
  block_type: string
  position: number
  data: string
  meta: string | null
  depth: number
}

interface InsertResult {
  insertId: number
}

export interface DuplicateBlockResult {
  /** New top-level row id (the duplicate of `sourceId`). */
  newTopId: number
  /** Number of descendant rows created (excludes the top-level — a
   *  flat widget duplicate returns 0; a section with 3 columns each
   *  containing 2 widgets returns 9). */
  descendantCount: number
  /** Cache-tag set + queue row id for the post-commit drain. */
  tags: string[]
  queueRowId: number | null
}

/**
 * Recursive duplicate of a content_blocks subtree. Single TX. Caller is
 * responsible for the post-commit revalidate drain (drainRevalidate(
 * result.queueRowId!, result.tags)) — splitting commit + drain into two
 * phases mirrors saveBlock so both paths share the same pattern.
 *
 * Throws on auth/structural failures:
 *   - DuplicatePageNotFoundError      → 404 page_not_found
 *   - DuplicateNotFoundError          → 404 not_found (source missing OR
 *                                       on a different page than caller claimed)
 *   - DuplicateColumnCountExceededError → 409 column_count_exceeded
 *   - DuplicateSubtreeTooLargeError   → 409 subtree_too_large
 *   - DuplicatePositionGapExhaustedError → 409 position_gap_exhausted
 */
export async function duplicateBlock(args: {
  sourceId: number
  userId: number
  // Acting API token id (null for cookie-session writes) — stamped on the
  // audit row so token-driven duplications attribute to the agent.
  tokenId: number | null
  pageId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}): Promise<DuplicateBlockResult> {
  return await db.transaction(async (tx) => {
    // Step 1: page existence. NOT FOR UPDATE — duplicate doesn't bump
    // pages.version. The slug we read is for cache tags only; a
    // concurrent rename has its own revalidate path.
    const [pageRows] = (await tx.execute(sql`
      SELECT slug FROM pages
      WHERE id = ${args.pageId} AND deleted_at IS NULL
      LIMIT 1
    `)) as unknown as [Array<{ slug: string }>]
    const pageSlug = pageRows[0]?.slug
    if (!pageSlug) throw new DuplicatePageNotFoundError()

    // Step 2: lock the source row. The FOR UPDATE pins it against a
    // concurrent soft-delete AND ensures the parent_id we read for the
    // sibling-position calc can't change beneath us.
    const [sourceRows] = (await tx.execute(sql`
      SELECT id, page_id, parent_id, kind, block_type, position, data, meta, block_key
      FROM content_blocks
      WHERE id = ${args.sourceId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [SourceRow[]]
    const source = sourceRows[0]
    if (!source) throw new DuplicateNotFoundError()
    // Cross-page guard. A forged pageId targeting a foreign block
    // surfaces as 404 — same code as genuinely-missing, no info leak.
    if (source.page_id !== args.pageId) throw new DuplicateNotFoundError()

    // Step 2a: fixed-slot widget guard. Symmetric with POST /api/cms/
    // blocks's check — page templates guarantee one row per fixed
    // block_type (currently just contact_form on /contact). The
    // duplicate strips block_key (so the UNIQUE(page_id, block_key)
    // constraint isn't tripped), BUT without this gate the page would
    // render two rows of the same fixed block_type — one with block_key,
    // one without — and the operator's "Edit form" gesture becomes
    // non-deterministic.
    if (source.kind === 'widget') {
      const fixed = (FIXED_BLOCK_KEYS_PER_PAGE[pageSlug] ?? []) as readonly string[]
      if (fixed.includes(source.block_type)) {
        throw new DuplicateBlockTypeReservedError()
      }
    }

    // Step 3: column-cap enforcement. Duplicating a column adds one
    // sibling to the parent section. If the section is already at the
    // MAX, refuse. The source row's FOR UPDATE lock above pins the
    // section indirectly (its content_blocks row is the source's parent
    // and parent_id can't drift while the source is locked); a peer
    // racing to insert another column under the same section will
    // serialise on the COUNT(*) read below.
    if (source.kind === 'column' && source.parent_id !== null) {
      const [colCountRows] = (await tx.execute(sql`
        SELECT COUNT(*) AS n FROM content_blocks
        WHERE parent_id = ${source.parent_id} AND deleted_at IS NULL
      `)) as unknown as [Array<{ n: number | bigint }>]
      const currentCount = Number(colCountRows[0]?.n ?? 0)
      if (currentCount >= MAX_SECTION_COLUMNS) {
        throw new DuplicateColumnCountExceededError()
      }
    }

    // Step 4: compute the top-level duplicate's position. Bisect with
    // the next sibling within the SAME parent_id bucket. The position
    // arithmetic mirrors POST /api/cms/blocks's `afterBlockId` path.
    const [siblings] = (await tx.execute(sql`
      SELECT id, position
      FROM content_blocks
      WHERE page_id = ${args.pageId}
        AND deleted_at IS NULL
        AND parent_id ${source.parent_id === null ? sql`IS NULL` : sql`= ${source.parent_id}`}
      ORDER BY position
    `)) as unknown as [Array<{ id: number; position: number }>]
    const sIdx = siblings.findIndex((r) => r.id === args.sourceId)
    let nextPos: number
    if (sIdx >= 0 && sIdx < siblings.length - 1) {
      const a = siblings[sIdx]!
      const b = siblings[sIdx + 1]!
      nextPos = Math.floor((a.position + b.position) / 2)
      if (nextPos <= a.position || nextPos >= b.position) {
        // Gap exhausted between source + next sibling. Surface as 409
        // so the operator can refresh + retry (a refresh-triggered
        // reorder re-spaces the bucket).
        throw new DuplicatePositionGapExhaustedError()
      }
    } else if (sIdx >= 0) {
      // Source is the LAST sibling — append after it within the bucket.
      nextPos = siblings[sIdx]!.position + 1000
    } else {
      // Source moved mid-flight (concurrent reorder put it under a
      // different parent). Fall back to append-to-tail of the source's
      // claimed parent bucket.
      const [maxRows] = (await tx.execute(sql`
        SELECT COALESCE(MAX(position), 0) AS maxPos
        FROM content_blocks
        WHERE page_id = ${args.pageId}
          AND deleted_at IS NULL
          AND parent_id ${source.parent_id === null ? sql`IS NULL` : sql`= ${source.parent_id}`}
      `)) as unknown as [Array<{ maxPos: number }>]
      nextPos = Number(maxRows[0]?.maxPos ?? 0) + 1000
    }

    // Step 5: recursive CTE walk for the FULL subtree. Order by
    // (depth, position) so parents always appear before children — the
    // INSERT loop can then look up the new parent_id in the id-map
    // without re-sorting. The `depth` column is also the cycle guard
    // (cap at MAX_DUPLICATE_DEPTH so a corrupt parent_id cycle can't
    // exhaust the CTE).
    const [descendantRows] = (await tx.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT
          id, parent_id, kind, block_type, position, data, meta, 0 AS depth
        FROM content_blocks
        WHERE id = ${args.sourceId} AND deleted_at IS NULL
        UNION ALL
        SELECT
          cb.id, cb.parent_id, cb.kind, cb.block_type, cb.position,
          cb.data, cb.meta, d.depth + 1
        FROM content_blocks cb
        INNER JOIN descendants d ON cb.parent_id = d.id
        WHERE cb.deleted_at IS NULL
          AND d.depth < ${MAX_DUPLICATE_DEPTH}
      )
      SELECT id, parent_id, kind, block_type, position, data, meta, depth
      FROM descendants
      ORDER BY depth, position
    `)) as unknown as [DescendantRow[]]

    if (descendantRows.length === 0) {
      // Source vanished between the FOR UPDATE read and this query
      // (defence in depth — the lock makes this impossible, but the
      // explicit check beats a silent zero-insert success path).
      throw new DuplicateNotFoundError()
    }
    if (descendantRows.length > MAX_DUPLICATE_SUBTREE_SIZE) {
      throw new DuplicateSubtreeTooLargeError(descendantRows.length)
    }
    // Refuse on depth truncation. The recursive CTE's gate is
    // `d.depth < MAX_DUPLICATE_DEPTH` — a source subtree exactly that
    // deep INCLUDES the boundary rows but DROPS any descendants below
    // them, silently. Better to error out so the operator sees an
    // explicit refusal than to commit an incomplete copy.
    //
    // Today's natural tree caps at depth=2 (section → column → widget),
    // so this is purely defensive — a corrupt parent_id chain or a
    // future deeper structure would otherwise truncate without
    // operator visibility.
    const maxDepth = descendantRows.reduce(
      (m, r) => (r.depth > m ? r.depth : m),
      0,
    )
    if (maxDepth >= MAX_DUPLICATE_DEPTH) {
      throw new DuplicateSubtreeTooLargeError(descendantRows.length)
    }

    // Step 5a: media availability check. Walk EVERY widget descendant's
    // data, collect referenced media_ids, then FOR-SHARE-lock + verify
    // each is still live. Matches the pattern used by saveBlock +
    // POST /api/cms/blocks: close the race where a concurrent
    // /api/cms/media/[id] DELETE soft-deletes a row whose only refs
    // are about to be cloned. Without this gate, the duplicate's new
    // media_references rows would point at a media row whose
    // deleted_at is set — a dangling reference until the verifier
    // cron runs.
    //
    // Also collects the parsed-and-sanitised payload per widget so
    // we can refuse the duplicate when source data fails the CURRENT
    // schema (post-deploy tightening case: source was valid when
    // first inserted, but a stricter Zod gate landed since then).
    // Re-parsing at duplicate time keeps newly-inserted rows in
    // lock-step with the live registry.
    const parsedDataByRowId = new Map<number, unknown>()
    const allMediaIds = new Set<number>()
    for (const row of descendantRows) {
      if (row.kind !== 'widget' || !row.data) continue
      let raw: unknown
      try { raw = JSON.parse(row.data) } catch { raw = {} }
      let parsed: unknown
      try {
        parsed = parseAndSanitize(row.block_type, raw)
      } catch {
        throw new DuplicateSourceInvalidError()
      }
      parsedDataByRowId.set(row.id, parsed)
      for (const r of collectMediaPaths(parsed)) allMediaIds.add(r.mediaId)
    }
    if (allMediaIds.size > 0) {
      // assertMediaAvailable throws NotFoundError on a soft-deleted ref.
      // The route translates that to 404 not_found — the same code as a
      // missing source. The operator's path forward is refresh + retry.
      await assertMediaAvailable(tx, [...allMediaIds])
    }

    // Step 6: INSERT each row. Build old_id → new_id map so descendants
    // can resolve their new parent_id from a previously-inserted row.
    // Position re-numbering: for the source, use the bisected nextPos
    // (top-level placement). For descendants, IGNORE the source row's
    // original position values and re-number 1000-spaced inside each
    // new-parent bucket. Carrying the source's position values forward
    // creates (parent_id, position) collisions between the source's
    // subtree and the duplicate's subtree under their respective new
    // parents — the renderer's ORDER BY position would become
    // non-deterministic post-duplicate, and the FE reorder bisect
    // would silently land in occupied slots.
    const idMap = new Map<number, number>()
    const posCounterByNewParent = new Map<number, number>()
    let newTopId = -1
    for (const row of descendantRows) {
      // Cycle guard: a corrupt parent_id cycle (DB integrity break)
      // would surface as the same row id reappearing in the CTE result.
      // Refuse rather than re-INSERT and pollute the duplicate with
      // ghost rows.
      if (idMap.has(row.id)) {
        throw new DuplicateCycleDetectedError()
      }
      const isSource = row.id === args.sourceId
      // For the source: new parent = source.parent_id (preserved).
      // For descendants: new parent_id = idMap[row.parent_id]. Because
      // we sorted by (depth, position) the parent has always been
      // inserted by the time we get to its children.
      let newParentId: number | null
      if (isSource) {
        newParentId = source.parent_id
      } else if (row.parent_id === null) {
        // Defence: a descendant with parent_id=NULL would mean the CTE
        // returned an unrelated top-level row. The JOIN condition
        // (`cb.parent_id = d.id`) makes this impossible — but explicit
        // guard rather than silent orphan.
        throw new DuplicateNotFoundError()
      } else {
        const mapped = idMap.get(row.parent_id)
        if (mapped === undefined) {
          // BFS order should make this impossible — but a malformed
          // tree (parent_id pointing outside the descendant set we
          // walked) would land here. Refuse rather than orphaning the
          // new row.
          throw new DuplicateNotFoundError()
        }
        newParentId = mapped
      }
      // Compute per-new-parent position. Source uses the bisected
      // nextPos (top-level placement); descendants get 1000-spaced
      // positions scoped to their new parent.
      let newPos: number
      if (isSource) {
        newPos = nextPos
      } else {
        // newParentId is non-null here (descendant case is the else
        // branch above, which ensures we either threw or resolved a
        // numeric mapped id).
        const parentKey = newParentId as number
        const next = (posCounterByNewParent.get(parentKey) ?? 0) + 1
        posCounterByNewParent.set(parentKey, next)
        newPos = next * 1000
      }
      // Use re-validated widget data when we re-parsed it above
      // (parsedDataByRowId.get returns the sanitized payload). Container
      // rows continue to insert the empty-object placeholder from the
      // source row's stored data.
      const parsedWidgetPayload = parsedDataByRowId.get(row.id)
      const dataJson =
        row.kind === 'widget' && parsedWidgetPayload !== undefined
          ? JSON.stringify(parsedWidgetPayload)
          : row.data
      // Strip `htmlId` from the duplicated meta. The htmlId is a
      // per-page-unique anchor identifier (enforced by assertHtmlIdUnique
      // on POST + PATCH). Copying it verbatim into the duplicate would
      // produce two living rows on the same page sharing one DOM id,
      // bypassing the uniqueness gate. The operator can set a new
      // htmlId on the duplicate via the Advanced tab.
      const dedupedMetaJson = stripHtmlIdFromMetaJson(row.meta)
      const [insertResult] = (await tx.execute(sql`
        INSERT INTO content_blocks
          (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
        VALUES (
          ${args.pageId},
          ${newParentId},
          ${row.kind},
          ${row.block_type},
          ${newPos},
          ${dataJson},
          ${dedupedMetaJson},
          0,
          ${args.userId}
        )
      `)) as unknown as [InsertResult]
      const newId = Number(insertResult.insertId)
      idMap.set(row.id, newId)
      if (isSource) newTopId = newId

      // Step 6b: media_references for widget rows. assertMediaAvailable
      // above already verified each media_id is live; INSERT IGNORE
      // handles concurrent duplicate-of-same-source races (different
      // request landing the same ref) gracefully.
      if (row.kind === 'widget') {
        const payload = parsedWidgetPayload ?? null
        if (payload !== null) {
          const refs = collectMediaPaths(payload)
          for (const r of refs) {
            await tx.execute(sql`
              INSERT IGNORE INTO media_references
                (media_id, referent_type, referent_id, field)
              VALUES (${r.mediaId}, 'content_block', ${newId}, ${r.field})
            `)
          }
        }
      }
    }

    if (newTopId < 0) {
      // Unreachable — the loop above always finds the source in the
      // CTE result and assigns newTopId. Explicit guard satisfies the
      // TS narrowing without an `!` non-null assertion at the return.
      throw new DuplicateNotFoundError()
    }

    // Step 7: audit. One row per duplicate gesture (not per inserted
    // content_blocks row) — forensic clarity. The diff payload is
    // small (no widget data inlined), well under AUDIT_DIFF_CAP — no
    // truncation branch. For subtrees ≤ 32 rows include the new-row
    // id array so forensics can reconstruct WHICH descendants were
    // created without re-walking parent_id from the new top-level row.
    // Above 32, emit `truncated: true` and rely on the parent_id
    // chain — the row volume past 32 makes the audit blob noisy
    // without proportional forensic value.
    const descendantCount = descendantRows.length - 1
    const newRowIds = [...idMap.values()]
    const auditDiff: Record<string, unknown> = {
      kind: AUDIT_KIND.duplicate,
      source_id: args.sourceId,
      block_type: source.block_type,
      container_kind: source.kind,
      descendant_count: descendantCount,
    }
    if (newRowIds.length <= 32) {
      auditDiff['new_row_ids'] = newRowIds
    } else {
      auditDiff['truncated'] = true
    }
    await tx.insert(auditLog).values({
      userId: args.userId,
      tokenId: args.tokenId,
      action: 'create',
      resourceType: 'content_block',
      resourceId: String(newTopId),
      diff: auditDiff as unknown as object,
      ip: args.ip,
      userAgent: args.userAgent,
      requestId: args.requestId,
    })

    // Step 8: cache revalidate. The page tag invalidates whether the
    // duplicate landed at top-level or nested. block_type is the
    // source's block_type (containers pass 'section' / 'column' which
    // tagsForBlockSave ignores for the cross-cutting tag set).
    const tags = tagsForBlockSave(pageSlug, source.block_type).tags
    const queueRowId = tags.length ? await enqueueRevalidate(tx, tags) : null

    return { newTopId, descendantCount, tags, queueRowId }
  })
}
