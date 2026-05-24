import 'server-only'
import diff from 'microdiff'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { parseAndSanitize } from './parse'
import { collectMediaPaths } from './mediaRefs'
import { assertMediaAvailable } from './mediaCheck'
import { AUDIT_KIND } from './auditKinds'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import type { BlockKind } from './blockMeta'

// Distinct optimistic-lock-mismatch classes for the two axes of the
// pages-CMS save TX. The block-version axis catches concurrent edits to
// the SAME block under the SAME page; the page-version axis catches
// concurrent page-level edits (title/SEO/slug rename/is_home flip) that
// happened between the editor's last read and this save. Both surface
// as 409 from the route handler but with distinct codes so the FE
// recovery banner can route the buffered diff to the right merge UI.
//
// Spec §3.5 + §7. Renamed from rev-6's single `StaleVersionError` per
// spec §0 "rename is the contract — no transition aliasing".
export class StaleBlockVersionError extends Error {
  constructor() {
    super('stale_block_version')
  }
}
export class StalePageVersionError extends Error {
  constructor() {
    super('stale_page_version')
  }
}
export class NotFoundError extends Error {
  constructor() {
    super('not_found')
  }
}

// 64 KB cap on the JSON-serialized audit diff. microdiff(huge_old, huge_new)
// can synthesize multi-MB patches in principle; current Zod bounds keep
// real-world block payloads well under that, but a future block type
// (long-form post body, deep section tree) could blow past the cap. The
// audit row is meant to answer "who touched what and roughly how" — full
// reconstruction lives in DB point-in-time recovery, not here.
// Above the cap we replace the diff with a fingerprint object that
// preserves the op count + kinds (CREATE/CHANGE/REMOVE) for forensics.
export const AUDIT_DIFF_CAP = 64 * 1024

export type DiffOp = {
  type: 'CREATE' | 'CHANGE' | 'REMOVE'
  path: (string | number)[]
}

export function capAuditDiff(patch: DiffOp[]): unknown {
  const serialized = JSON.stringify(patch)
  if (serialized.length <= AUDIT_DIFF_CAP) return patch
  return {
    truncated: true,
    byteSize: serialized.length,
    opCount: patch.length,
    opKinds: [...new Set(patch.map((op) => op.type))],
  }
}

interface BlockRow {
  id: number
  page_id: number
  block_type: string
  // mysql2 returns JSON columns as strings via raw execute(sql...). Drizzle's
  // query builder parses them; the raw path does not. We parse explicitly
  // below so callers don't have to think about which fork they're on.
  data: string
  version: number
}

/**
 * Saves a single content_block under DUAL-AXIS optimistic locking. Single TX
 * with explicit pages-before-content_blocks lock order to pre-empt deadlock
 * against §4.3 is_home flips (which also lock `pages` rows ASC-by-id).
 *
 *   1. SELECT pages FOR UPDATE — lock the page row FIRST.
 *   2. Optimistic check on pages.version (block-version axis from caller).
 *   3. UPDATE pages SET version = version + 1, updated_at, updated_by
 *      WHERE id = :pageId AND version = :expectedPageVersion — affectedRows=0
 *      triggers StalePageVersionError (belt + braces against TOCTOU under the
 *      FOR UPDATE lock).
 *   4. SELECT content_blocks FOR UPDATE (with `page_id = :pageId` filter so a
 *      forged pageId surfaces as 404 not_found).
 *   5. Optimistic check on content_blocks.version (block-version axis).
 *   6. parseAndSanitize (write boundary — Zod + DOMPurify).
 *   7. UPDATE content_blocks SET data, version, updated_by.
 *   8. media_references diff → DELETE / INSERT IGNORE (with FOR SHARE
 *      assertMediaAvailable on the additions to close the race against a
 *      concurrent media DELETE).
 *   9. INSERT audit_log (diff capped at 64KB).
 *  10. enqueueRevalidate INSIDE the TX for the resolved page slug.
 *
 * Returns the new block AND page versions so the FE can update both
 * optimistic-lock tokens before the next save attempt.
 *
 * Spec §3.5 + §7. The breaking rename from `expectedVersion` →
 * `expectedBlockVersion` + addition of `expectedPageVersion` + `pageId`
 * is the contract — no transition aliasing.
 */
export async function saveBlock(args: {
  blockId: number
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
  pageId: number
  expectedBlockVersion: number
  expectedPageVersion: number
  data: unknown
}): Promise<{ blockVersion: number; pageVersion: number }> {
  // Two-stage: TX returns the new versions + the notification_failures row
  // id we enqueued inside it. After commit, drain the queue row in a
  // microtask — succeeds → DELETE row, fails → UPDATE attempts + retry.
  const txResult = await db.transaction(async (tx) => {
    // Step 1: lock the pages row FIRST. Filter on deleted_at so a save
    // against a soft-deleted page surfaces as 404 (UI shouldn't even
    // have offered the edit affordance, but defence in depth).
    const [pageRows] = (await tx.execute(sql`
      SELECT id, slug, version
      FROM pages
      WHERE id = ${args.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
    const pageRow = pageRows[0]
    if (!pageRow) throw new NotFoundError()
    if (pageRow.version !== args.expectedPageVersion) {
      throw new StalePageVersionError()
    }

    // Step 2: bump pages.version atomically. The WHERE-on-version is
    // redundant under FOR UPDATE but the explicit guard makes the
    // optimistic-lock contract grep-able AND closes any future-driver
    // surprise where FOR UPDATE semantics change (mysql2 → mariadb-node).
    const bumpResultRaw = (await tx.execute(sql`
      UPDATE pages
      SET version = version + 1,
          updated_at = NOW(3),
          updated_by = ${args.userId}
      WHERE id = ${args.pageId} AND version = ${args.expectedPageVersion}
    `)) as unknown as { affectedRows: number } | [unknown, { affectedRows: number }]
    // mysql2 returns `[ResultSetHeader, FieldPacket[]]` for UPDATEs;
    // Drizzle 0.36's `db.execute()` passes that through unchanged.
    // Accept either tuple shape OR a bare `ResultSetHeader` so a
    // future driver swap doesn't silently bypass the guard.
    const affected = Array.isArray(bumpResultRaw)
      ? bumpResultRaw[0] && typeof bumpResultRaw[0] === 'object' && 'affectedRows' in bumpResultRaw[0]
        ? (bumpResultRaw[0] as { affectedRows: number }).affectedRows
        : (bumpResultRaw as unknown as { affectedRows: number }).affectedRows
      : bumpResultRaw.affectedRows
    if (affected === 0) throw new StalePageVersionError()
    const newPageVersion = pageRow.version + 1

    // Step 3: NOW lock + read the content_blocks row. The `page_id =
    // :pageId` filter ensures the block actually belongs to the page
    // the caller claimed — a forged pageId targeting a foreign block
    // returns 0 rows and surfaces as 404 not_found (same code as
    // genuinely-missing block; no info-leak to a probing attacker).
    const [selectRows] = (await tx.execute(sql`
      SELECT id, page_id, block_type, data, version
      FROM content_blocks
      WHERE id = ${args.blockId}
        AND page_id = ${args.pageId}
        AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [BlockRow[]]

    const row = selectRows[0]
    if (!row) throw new NotFoundError()
    if (row.version !== args.expectedBlockVersion) {
      throw new StaleBlockVersionError()
    }

    // The JSON column came back as a string from raw SQL — parse once and
    // reuse for media-ref diff + audit diff. Wrapped: a corrupted row that
    // somehow shipped non-JSON data shouldn't crash this save with a raw
    // SyntaxError; treat as empty (the new payload still gets parsed +
    // sanitized below and overwrites whatever was there).
    let oldData: unknown
    try {
      oldData = JSON.parse(row.data)
    } catch {
      oldData = {}
    }

    // Parse + sanitize at the write boundary. ZodError bubbles up to
    // withError's handler → 400 invalid_request.
    const parsed = parseAndSanitize(row.block_type, args.data)
    const parsedJson = JSON.stringify(parsed)
    const newBlockVersion = row.version + 1

    await tx.execute(sql`
      UPDATE content_blocks
      SET data = ${parsedJson}, version = ${newBlockVersion}, updated_by = ${args.userId}
      WHERE id = ${args.blockId}
    `)

    // Media references diff against the parsed-out runtime tree.
    const oldRefs = collectMediaPaths(oldData)
    const newRefs = collectMediaPaths(parsed)
    const oldSet = new Set(oldRefs.map((r) => `${r.mediaId}::${r.field}`))
    const newSet = new Set(newRefs.map((r) => `${r.mediaId}::${r.field}`))

    // Before inserting NEW refs, FOR SHARE-lock every newly-referenced
    // media row and verify deleted_at IS NULL. Closes the race with a
    // concurrent DELETE /api/cms/media/[id] that only locks refs current
    // at delete-time — without this check a save mid-delete would add a
    // ref to a row about to be soft-deleted (dangling pointer until cron).
    const newMediaIds = [
      ...new Set(newRefs.filter((r) => !oldSet.has(`${r.mediaId}::${r.field}`)).map((r) => r.mediaId)),
    ]
    await assertMediaAvailable(tx, newMediaIds)

    for (const r of oldRefs) {
      if (!newSet.has(`${r.mediaId}::${r.field}`)) {
        await tx.execute(sql`
          DELETE FROM media_references
          WHERE media_id = ${r.mediaId}
            AND referent_type = 'content_block'
            AND referent_id = ${args.blockId}
            AND field = ${r.field}
        `)
      }
    }
    for (const r of newRefs) {
      if (!oldSet.has(`${r.mediaId}::${r.field}`)) {
        await tx.execute(sql`
          INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
          VALUES (${r.mediaId}, 'content_block', ${args.blockId}, ${r.field})
        `)
      }
    }

    // Audit. microdiff walks the runtime trees on both sides; cap the
    // serialized result so pathological diffs lose detail but preserve
    // op-count signal in the truncation marker.
    const patch = diff(
      (oldData as object) ?? {},
      (parsed as object) ?? {},
    ) as DiffOp[]
    // Forensic-friendly diff shape: { kind: 'patch', ops: [...] } when
    // under the cap, { kind: 'patch_truncated', byteSize, opCount, opKinds }
    // when over. The kind field discriminates across CREATE/DELETE/REORDER
    // diff shapes that share this column.
    const cappedDiff = capAuditDiff(patch)
    const auditDiff = Array.isArray(cappedDiff)
      ? { kind: AUDIT_KIND.patch, ops: cappedDiff }
      : { ...(cappedDiff as object), kind: AUDIT_KIND.patchTruncated }
    await tx.insert(auditLog).values({
      userId: args.userId,
      action: 'update',
      resourceType: 'content_block',
      resourceId: String(args.blockId),
      diff: auditDiff,
      ip: args.ip,
      userAgent: args.userAgent,
      requestId: args.requestId,
    })

    // Page slug for the revalidate tag — reuse the row we already locked
    // in step 1 rather than issuing a redundant SELECT. The pages row's
    // FOR UPDATE lock pinned the slug for the duration of this TX so it
    // cannot drift mid-save.
    const pageSlug = pageRow.slug

    // Enqueue the revalidate intent INSIDE the TX. The row is committed
    // alongside the data mutation — a process crash between COMMIT and
    // the post-tx microtask leaves the row durable for the sweeper.
    //
    // Tradeoff: if enqueueRevalidate itself throws (DB full, table missing
    // after rollback drop, statement timeout), the entire save TX rolls
    // back — the user's edit is rejected to preserve cache-invalidation
    // durability. Acceptable: an outage that breaks the queue insert is
    // an outage that also breaks the next read, so blocking writes is
    // safer than admitting one that will be served stale forever.
    const tags = tagsForBlockSave(pageSlug, row.block_type).tags
    const queueRowId = tags.length
      ? await enqueueRevalidate(tx, tags)
      : null

    return {
      blockVersion: newBlockVersion,
      pageVersion: newPageVersion,
      tags,
      queueRowId,
    }
  })

  // After commit: drain the queue row best-effort. Succeeds → DELETE.
  // Throws → UPDATE attempts + push retry. Either way the user has their
  // 200 response by the time this microtask fires.
  if (txResult.queueRowId !== null) {
    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId!, txResult.tags)
    })
  }
  return {
    blockVersion: txResult.blockVersion,
    pageVersion: txResult.pageVersion,
  }
}

interface ContainerRow {
  id: number
  kind: BlockKind
  block_type: string
  meta: string | null
  version: number
}

export class WrongKindError extends Error {
  constructor() {
    super('wrong_kind')
  }
}
export class InvalidMetaJsonError extends Error {
  constructor() {
    super('invalid_meta_json')
  }
}

/**
 * Container counterpart of `saveBlock`. Updates `meta` on a section or
 * column row under the same DUAL-AXIS optimistic-lock contract. No
 * Zod parse on widget `data` (containers have data='{}'), no media-
 * reference diff (containers carry no media refs), no microdiff —
 * the audit row stores the BEFORE/AFTER meta blob directly so a
 * forensic replay can see exactly what changed.
 *
 * The caller is responsible for parsing + validating the new meta
 * shape via `SectionMetaSchema` / `ColumnMetaSchema` before calling.
 * `metaJson` is the JSON.stringify'd valid payload; passing a JSON
 * string keeps the storage shape identical to the row's stored form.
 *
 * Throws:
 *   - NotFoundError: block missing, soft-deleted, or page mismatch
 *   - WrongKindError: row.kind != args.expectedKind (caller asked to
 *     PATCH meta but the row is a widget)
 *   - StaleBlockVersionError / StalePageVersionError: optimistic-lock
 *     mismatches on either axis
 */
export async function saveBlockMeta(args: {
  blockId: number
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
  pageId: number
  expectedBlockVersion: number
  expectedPageVersion: number
  // Chunk E: 'widget' is allowed here so per-side spacing meta on
  // widget rows uses the SAME pages-then-content_blocks TX + audit +
  // revalidate path as section/column meta saves. Widget rows store
  // ONLY spacing meta (WidgetMeta = SpacingMeta); their data payload
  // continues to flow through saveBlock unchanged. The TX-internal
  // kind guard below catches a race where the row got flipped to a
  // different kind between the route's pre-read and this lock.
  expectedKind: BlockKind
  metaJson: string
}): Promise<{ blockVersion: number; pageVersion: number }> {
  const txResult = await db.transaction(async (tx) => {
    // Same lock order as saveBlock — pages first, then content_blocks.
    // Holds for deadlock pre-emption against §4.3 is_home flips.
    const [pageRows] = (await tx.execute(sql`
      SELECT id, slug, version
      FROM pages
      WHERE id = ${args.pageId} AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
    const pageRow = pageRows[0]
    if (!pageRow) throw new NotFoundError()
    if (pageRow.version !== args.expectedPageVersion) {
      throw new StalePageVersionError()
    }

    const bumpResultRaw = (await tx.execute(sql`
      UPDATE pages
      SET version = version + 1,
          updated_at = NOW(3),
          updated_by = ${args.userId}
      WHERE id = ${args.pageId} AND version = ${args.expectedPageVersion}
    `)) as unknown as { affectedRows: number } | [unknown, { affectedRows: number }]
    const affected = Array.isArray(bumpResultRaw)
      ? bumpResultRaw[0] && typeof bumpResultRaw[0] === 'object' && 'affectedRows' in bumpResultRaw[0]
        ? (bumpResultRaw[0] as { affectedRows: number }).affectedRows
        : (bumpResultRaw as unknown as { affectedRows: number }).affectedRows
      : bumpResultRaw.affectedRows
    if (affected === 0) throw new StalePageVersionError()
    const newPageVersion = pageRow.version + 1

    const [selectRows] = (await tx.execute(sql`
      SELECT id, kind, block_type, meta, version
      FROM content_blocks
      WHERE id = ${args.blockId}
        AND page_id = ${args.pageId}
        AND deleted_at IS NULL
      FOR UPDATE
    `)) as unknown as [ContainerRow[]]

    const row = selectRows[0]
    if (!row) throw new NotFoundError()
    if (row.kind !== args.expectedKind) throw new WrongKindError()
    if (row.version !== args.expectedBlockVersion) {
      throw new StaleBlockVersionError()
    }

    // BEFORE meta, parsed for the audit diff. Defensive — a corrupt
    // stored blob shouldn't crash the save with SyntaxError; treat as
    // null so the audit shows "before: null, after: ...".
    let oldMeta: unknown = null
    if (row.meta !== null) {
      try {
        oldMeta = JSON.parse(row.meta)
      } catch {
        oldMeta = null
      }
    }
    // Defensive: callers serialise validated meta via JSON.stringify
    // and the route layer always passes well-formed JSON. Wrapping
    // the parse maps a hand-built/truncated metaJson to a clean 400
    // via InvalidMetaJsonError instead of a generic 500 from the bare
    // SyntaxError. TX rollback naturally undoes the page-version bump
    // and content_blocks UPDATE — correct behaviour for a 400; the
    // wrap just keeps the failure mode descriptive at the API edge.
    let newMeta: unknown
    try {
      newMeta = JSON.parse(args.metaJson)
    } catch {
      throw new InvalidMetaJsonError()
    }
    const newBlockVersion = row.version + 1

    await tx.execute(sql`
      UPDATE content_blocks
      SET meta = ${args.metaJson},
          version = ${newBlockVersion},
          updated_by = ${args.userId}
      WHERE id = ${args.blockId}
    `)

    // Audit. Container meta is small (< 1KB even at maximum) so the
    // before/after pair always fits well under AUDIT_DIFF_CAP — no
    // truncation branch needed.
    await tx.insert(auditLog).values({
      userId: args.userId,
      action: 'update',
      resourceType: 'content_block',
      resourceId: String(args.blockId),
      diff: {
        kind: AUDIT_KIND.patch,
        container_kind: row.kind,
        before: oldMeta,
        after: newMeta,
      } as unknown as object,
      ip: args.ip,
      userAgent: args.userAgent,
      requestId: args.requestId,
    })

    const tags = tagsForBlockSave(pageRow.slug, row.block_type).tags
    const queueRowId = tags.length
      ? await enqueueRevalidate(tx, tags)
      : null

    return {
      blockVersion: newBlockVersion,
      pageVersion: newPageVersion,
      tags,
      queueRowId,
    }
  })

  if (txResult.queueRowId !== null) {
    queueMicrotask(() => {
      void drainRevalidate(txResult.queueRowId!, txResult.tags)
    })
  }
  return {
    blockVersion: txResult.blockVersion,
    pageVersion: txResult.pageVersion,
  }
}
