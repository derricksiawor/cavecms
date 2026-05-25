// Weekly media_references reconciler. Invoked by cavecms-media-verify.timer.
// Rebuilds the reverse index from authoritative sources and reconciles
// any drift, writing an audit_log row when a delta is found.
//
// Sources of truth for "what references what":
//   * content_blocks.data — freeform JSON; walked by lib/cms/mediaRefs
//     collectMediaPaths()
//   * project_sections.data — same walker
//   * projects.{hero_image_id, brochure_pdf_id, og_image_id} — typed FK
//   * posts.{hero_image_id, og_image_id} — typed FK
//
// The plan template (docs/.../plan-09:1086) also referenced a
// `team_members` table with a `photo_id` column. That table is not in
// db/schema/ (verified during cluster-4 pre-work: db/schema/ holds
// audit/auth/content/leads/media/notifications/posts/projects/settings/
// users — no team). Including a SELECT against it would crash this
// script with "Table 'cavecms.team_members' doesn't exist" the first time
// it runs. Skipped outright with this note; if a future feature adds
// the table, extend this script then so the rebuild stays exhaustive.
//
// TX boundary: the entire rebuild + reconcile lives inside a single
// db.transaction() call. CREATE TEMPORARY TABLE in MySQL/MariaDB does
// NOT cause an implicit commit (per MySQL docs — explicit exception
// to the usual DDL-commits rule), so the TEMP table survives until
// the wrapping COMMIT. Doing the work in one TX gets us:
//   * The temp table lives on a single connection (the TX-pinned one)
//     — drizzle's pool would otherwise hand each .execute() a fresh
//     connection where the temp table is invisible.
//   * Reconcile INSERTs/DELETEs commit atomically with the audit_log
//     row that describes them, so a crash mid-reconcile cannot leave
//     a divergence between the audit story and the actual table state.

if (process.env['NODE_ENV'] !== 'production') {
  console.error('[verify-media-refs] refusing to run with NODE_ENV != production')
  process.exit(1)
}

import { sql } from 'drizzle-orm'
import { db, pool, type Tx } from '../db/client'
import { collectMediaPaths } from '../lib/cms/mediaRefs'

function logInfo(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', script: 'verify-media-refs', event, ...extra }))
}

function logError(event: string, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', script: 'verify-media-refs', event, ...extra }))
}

type ReferentType = 'content_block' | 'project_section' | 'project' | 'post'

interface RefRow {
  media_id: number
  referent_type: ReferentType
  referent_id: number
  field: string
}

async function rebuildFromContentBlocks(tx: Tx): Promise<number> {
  const [rows] = (await tx.execute(
    sql`SELECT id, data FROM content_blocks WHERE deleted_at IS NULL`,
  )) as unknown as [Array<{ id: number; data: unknown }>]
  let inserted = 0
  for (const b of rows) {
    for (const r of collectMediaPaths(b.data)) {
      await tx.execute(
        sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field)
            VALUES (${r.mediaId}, 'content_block', ${b.id}, ${r.field})`,
      )
      inserted += 1
    }
  }
  return inserted
}

async function rebuildFromProjectSections(tx: Tx): Promise<number> {
  const [rows] = (await tx.execute(
    sql`SELECT id, data FROM project_sections`,
  )) as unknown as [Array<{ id: number; data: unknown }>]
  let inserted = 0
  for (const s of rows) {
    for (const r of collectMediaPaths(s.data)) {
      await tx.execute(
        sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field)
            VALUES (${r.mediaId}, 'project_section', ${s.id}, ${r.field})`,
      )
      inserted += 1
    }
  }
  return inserted
}

async function rebuildFromProjectFks(tx: Tx): Promise<number> {
  const [rows] = (await tx.execute(
    sql`SELECT id, hero_image_id, brochure_pdf_id, og_image_id
        FROM projects WHERE deleted_at IS NULL`,
  )) as unknown as [
    Array<{
      id: number
      hero_image_id: number | null
      brochure_pdf_id: number | null
      og_image_id: number | null
    }>,
  ]
  let inserted = 0
  for (const p of rows) {
    const fks: Array<[string, number | null]> = [
      ['hero_image_id', p.hero_image_id],
      ['brochure_pdf_id', p.brochure_pdf_id],
      ['og_image_id', p.og_image_id],
    ]
    for (const [col, val] of fks) {
      if (val == null) continue
      await tx.execute(
        sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field)
            VALUES (${val}, 'project', ${p.id}, ${col})`,
      )
      inserted += 1
    }
  }
  return inserted
}

async function rebuildFromPostFks(tx: Tx): Promise<number> {
  const [rows] = (await tx.execute(
    sql`SELECT id, hero_image_id, og_image_id
        FROM posts WHERE deleted_at IS NULL`,
  )) as unknown as [
    Array<{ id: number; hero_image_id: number | null; og_image_id: number | null }>,
  ]
  let inserted = 0
  for (const p of rows) {
    const fks: Array<[string, number | null]> = [
      ['hero_image_id', p.hero_image_id],
      ['og_image_id', p.og_image_id],
    ]
    for (const [col, val] of fks) {
      if (val == null) continue
      await tx.execute(
        sql`INSERT IGNORE INTO _refs_new (media_id, referent_type, referent_id, field)
            VALUES (${val}, 'post', ${p.id}, ${col})`,
      )
      inserted += 1
    }
  }
  return inserted
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  logInfo('started')

  let missing: RefRow[] = []
  let extra: RefRow[] = []
  let totalRebuilt = 0
  let orphanReferencesDropped = 0

  await db.transaction(async (tx) => {
    // Drop the temp table first in case a prior run was killed
    // mid-flight and somehow leaked it (defence in depth — temp
    // tables auto-drop on connection close, but the wrapping TX
    // is on a fresh pool connection so this should be a no-op).
    await tx.execute(sql`DROP TEMPORARY TABLE IF EXISTS _refs_new`)
    await tx.execute(sql`CREATE TEMPORARY TABLE _refs_new LIKE media_references`)

    totalRebuilt += await rebuildFromContentBlocks(tx)
    totalRebuilt += await rebuildFromProjectSections(tx)
    totalRebuilt += await rebuildFromProjectFks(tx)
    totalRebuilt += await rebuildFromPostFks(tx)

    // Strip orphan references — _refs_new rows whose media_id no
    // longer points at a live media row. This happens when an editor
    // saved a block referencing a media id that was later hard-deleted
    // by cron-purge (block JSON wasn't rewritten on the same TX as the
    // media delete — by design: cron-purge runs against soft-deleted
    // media that may still appear in cached/rolled-back JSON). Without
    // this step the reconcile would attempt to INSERT into
    // media_references with a non-existent media_id and hit
    // ER_NO_REFERENCED_ROW_2 (1452). INSERT IGNORE downgrades that to
    // a warning under standard sql_mode, but the silent skip means
    // every weekly run would re-flag and re-attempt the same orphans.
    // Drop them once, surface the count in the audit row.
    const [orphanRowsResult] = (await tx.execute(
      sql`DELETE n FROM _refs_new n
          LEFT JOIN media m ON m.id = n.media_id
          WHERE m.id IS NULL`,
    )) as unknown as [{ affectedRows?: number }]
    orphanReferencesDropped = orphanRowsResult.affectedRows ?? 0

    // Drift detection. LEFT JOIN twice — one direction for each
    // delta. Composite key is (media_id, referent_type, referent_id,
    // field) per the primary key on media_references.
    const [missingRows] = (await tx.execute(
      sql`SELECT n.media_id, n.referent_type, n.referent_id, n.field
          FROM _refs_new n
          LEFT JOIN media_references m
            ON m.media_id = n.media_id
           AND m.referent_type = n.referent_type
           AND m.referent_id = n.referent_id
           AND m.field = n.field
          WHERE m.media_id IS NULL`,
    )) as unknown as [RefRow[]]
    missing = missingRows

    const [extraRows] = (await tx.execute(
      sql`SELECT m.media_id, m.referent_type, m.referent_id, m.field
          FROM media_references m
          LEFT JOIN _refs_new n
            ON n.media_id = m.media_id
           AND n.referent_type = m.referent_type
           AND n.referent_id = m.referent_id
           AND n.field = m.field
          WHERE n.media_id IS NULL`,
    )) as unknown as [RefRow[]]
    extra = extraRows

    if (missing.length === 0 && extra.length === 0 && orphanReferencesDropped === 0) {
      // Clean run — drop the temp table to release the buffer pool
      // pages early and let the TX commit cheaply.
      await tx.execute(sql`DROP TEMPORARY TABLE _refs_new`)
      return
    }

    // Cap the audit payload. A run-away drift (e.g. a schema bug that
    // multiplied references) would otherwise write a multi-MB JSON
    // blob into audit_log.diff, which is mediumtext-backed (~16MB) but
    // we cap to keep the audit table query-friendly. The full count
    // lives in dedicated columns so the truncation never loses the
    // headline number.
    const CAP = 500
    const diffPayload = {
      missing_count: missing.length,
      extra_count: extra.length,
      orphan_references_dropped: orphanReferencesDropped,
      missing_sample: missing.slice(0, CAP),
      extra_sample: extra.slice(0, CAP),
      truncated:
        missing.length > CAP || extra.length > CAP
          ? { missing_truncated: Math.max(0, missing.length - CAP), extra_truncated: Math.max(0, extra.length - CAP) }
          : null,
    }
    await tx.execute(
      sql`INSERT INTO audit_log (action, resource_type, diff)
          VALUES ('media_refs_drift', 'media', ${JSON.stringify(diffPayload)})`,
    )

    // Reconcile. INSERT IGNORE is belt-and-suspenders: the snapshot
    // taken by the LEFT JOIN above is the TX's repeatable-read view,
    // but a concurrent saveBlock that committed AFTER the snapshot
    // started will become visible to the INSERT itself (auto-commit
    // boundaries on the other connection) — IGNORE absorbs the
    // duplicate-key error in that race window.
    for (const r of missing) {
      await tx.execute(
        sql`INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
            VALUES (${r.media_id}, ${r.referent_type}, ${r.referent_id}, ${r.field})`,
      )
    }
    for (const r of extra) {
      await tx.execute(
        sql`DELETE FROM media_references
            WHERE media_id = ${r.media_id}
              AND referent_type = ${r.referent_type}
              AND referent_id = ${r.referent_id}
              AND field = ${r.field}`,
      )
    }
    await tx.execute(sql`DROP TEMPORARY TABLE _refs_new`)
  })

  const durationMs = Date.now() - startedAt
  logInfo('completed', {
    durationMs,
    // INSERT-attempt count, not final _refs_new size: INSERT IGNORE
    // dedups when the same media_id+referent triple appears more than
    // once in a single payload's walk (e.g. a gallery that lists the
    // same image twice), and the post-rebuild orphan-sweep then prunes
    // any references to hard-deleted media. _refs_new's actual row
    // count = insertAttempts - <dedup-skipped> - orphanReferencesDropped.
    insertAttempts: totalRebuilt,
    orphanReferencesDropped,
    missing: missing.length,
    extra: extra.length,
    reconciled: missing.length > 0 || extra.length > 0 || orphanReferencesDropped > 0,
  })
}

try {
  await main()
} catch (err) {
  logError('fatal', {
    cause: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  process.exitCode = 1
} finally {
  await pool.end()
}
