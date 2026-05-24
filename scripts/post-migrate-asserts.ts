// scripts/post-migrate-asserts.ts
//
// Runs BETWEEN the migrator and the fingerprint+symlink steps. Verifies
// post-migration invariants on the pages CMS schema. Failure halts the
// deploy BEFORE the symlink flips — the old binary keeps serving and the
// partially-applied (or correctly-applied but logically broken) DB state
// is exposed to the operator via the assert message for explicit recovery.
//
// Asserts (enumerated inline in the body; total count is logged at the
// end as "passed (N/N)"). High-level groupings:
//   - pages: title backfill, exactly-one is_home, system-row count
//     consistency (count matches the expected system slug list), slug
//     collation, url_path STORED column correctness, system slug regex
//     + presence checks.
//   - content_blocks: exactly one FK to pages.id with ON DELETE CASCADE,
//     parent/child kind invariants (section.parent_id IS NULL, column
//     parent is section, widget parent is column-or-null), parent_id
//     index presence for the per-parent reorder queries.
//   - transactions: REPEATABLE READ isolation level (lower would break
//     the optimistic-lock invariant for cross-row writes).
//
// The exact assertion count is computed in code and printed by the
// success log; previous static enumeration here drifted as migrations
// added invariants. Look at the function body for the live list.
//
// Implementation note: this script uses mysql2/promise DIRECTLY rather than
// `@/db/client` to avoid loading `@/lib/env`, which validates ALL secrets
// at module-load time. See pre-migrate-asserts.ts header for rationale.

import mysql from 'mysql2/promise'

// Strip non-printable bytes from server- or user-controlled strings
// (slug values, collation names, FK rule names) before interpolating
// them into operator-visible error messages. Defense against a
// compromised DB or a hostile slug crafted to inject ANSI/CSI escapes
// when an operator reads the deploy log.
function sanitiseForLog(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '').slice(0, 200)
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL']
  if (!url) {
    throw new Error('[post-migrate-asserts] DATABASE_URL not set in environment')
  }
  const conn = await mysql.createConnection(url)
  try {
    // -------------------------------------------------------------------
    // 1. Title backfill complete.
    // -------------------------------------------------------------------
    const [titleEmpty] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM pages WHERE title = '' OR title IS NULL
    `)
    if (Number(titleEmpty[0]?.['n'] ?? 0) !== 0) {
      throw new Error(
        "[post-migrate-asserts] #1 pages.title backfill incomplete; recovery: UPDATE pages SET title = CASE slug WHEN 'home' THEN 'Home' WHEN 'about' THEN 'About' WHEN 'services' THEN 'Services' WHEN 'contact' THEN 'Contact' ELSE slug END WHERE title='' OR title IS NULL;",
      )
    }

    // -------------------------------------------------------------------
    // 2. Exactly one home row.
    // -------------------------------------------------------------------
    const [homeCount] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM pages WHERE is_home = 1
    `)
    const homeN = Number(homeCount[0]?.['n'] ?? 0)
    if (homeN !== 1) {
      throw new Error(
        `[post-migrate-asserts] #2 expected exactly one is_home=1 row, found ${homeN}; recovery (homeN=0): UPDATE pages SET is_home=1 WHERE slug='home' AND deleted_at IS NULL; (homeN>1): pick the canonical row and UPDATE pages SET is_home=0 for the others before retrying`,
      )
    }

    // -------------------------------------------------------------------
    // 3. Four system rows (live, not trashed).
    //
    // Filtering `deleted_at IS NULL` to match assert #9's filter — a
    // legacy soft-deleted system row would otherwise make #3 pass while
    // #9 fails on the same DB state.
    // -------------------------------------------------------------------
    const [sysCount] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM pages WHERE system = 1 AND deleted_at IS NULL
    `)
    const sysN = Number(sysCount[0]?.['n'] ?? 0)
    if (sysN !== 7) {
      throw new Error(
        `[post-migrate-asserts] #3 expected 7 live system rows (system=1 AND deleted_at IS NULL), found ${sysN}; recovery: inspect pages with SELECT id,slug,system,deleted_at FROM pages WHERE system=1 OR slug IN ('home','about','services','contact','projects','privacy','terms');`,
      )
    }

    // -------------------------------------------------------------------
    // 4. pages.slug column collation is utf8mb4_bin.
    // -------------------------------------------------------------------
    const [collation] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COLLATION_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pages' AND COLUMN_NAME = 'slug'
    `)
    const collationName = collation[0]?.['COLLATION_NAME'] ?? null
    if (collationName !== 'utf8mb4_bin') {
      throw new Error(
        `[post-migrate-asserts] #4 pages.slug collation regressed: got ${sanitiseForLog(String(collationName))}, want utf8mb4_bin; recovery: ALTER TABLE pages MODIFY slug VARCHAR(140) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;`,
      )
    }

    // -------------------------------------------------------------------
    // 5. url_path generated values match the rule, NULL-aware.
    //
    // CRITICAL: `NULL <> x` is NULL in SQL (falsy in WHERE). So
    // url_path IS NULL must be checked explicitly — otherwise this
    // assert would silently pass on the very failure mode it exists
    // to catch (a row with NULL url_path because MariaDB doesn't
    // enforce NOT NULL on STORED generated columns).
    // -------------------------------------------------------------------
    const [urlPathBad] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM pages
      WHERE url_path IS NULL
         OR url_path <> IF(is_home = 1, '/', CONCAT('/', slug))
    `)
    const urlPathBadN = Number(urlPathBad[0]?.['n'] ?? 0)
    if (urlPathBadN !== 0) {
      throw new Error(
        `[post-migrate-asserts] #5 url_path generated column drift: ${urlPathBadN} mismatched rows; recovery: force a rewrite via UPDATE pages SET slug = slug; (the STORED column recomputes on any UPDATE touching the source columns)`,
      )
    }

    // -------------------------------------------------------------------
    // 6. Exactly one FK on content_blocks.page_id → pages.id, with
    //    DELETE_RULE = CASCADE.
    //
    // Detection by column-target (not constraint name) so a legacy
    // hand-rolled FK with a different name still gets caught. Then
    // a second query verifies the cascade rule.
    // -------------------------------------------------------------------
    const [fkCount] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'content_blocks'
        AND COLUMN_NAME = 'page_id'
        AND REFERENCED_TABLE_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME = 'pages'
        AND REFERENCED_COLUMN_NAME = 'id'
    `)
    const fkN = Number(fkCount[0]?.['n'] ?? 0)
    if (fkN !== 1) {
      throw new Error(
        `[post-migrate-asserts] #6 expected exactly 1 FK on content_blocks.page_id -> pages.id, found ${fkN}; recovery: SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_NAME='content_blocks' AND COLUMN_NAME='page_id' AND REFERENCED_TABLE_NAME='pages'; — drop the legacy FK(s) via ALTER TABLE content_blocks DROP FOREIGN KEY <name>;`,
      )
    }
    const [fkRule] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT r.DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND r.CONSTRAINT_NAME   = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE()
        AND k.TABLE_NAME = 'content_blocks'
        AND k.COLUMN_NAME = 'page_id'
        AND k.REFERENCED_TABLE_NAME = 'pages'
        AND k.REFERENCED_COLUMN_NAME = 'id'
    `)
    const deleteRule = fkRule[0]?.['DELETE_RULE'] ?? null
    if (deleteRule !== 'CASCADE') {
      throw new Error(
        `[post-migrate-asserts] #6 FK on content_blocks.page_id is not ON DELETE CASCADE (got ${sanitiseForLog(String(deleteRule))}); recovery: drop and re-add the FK with ON DELETE CASCADE`,
      )
    }

    // -------------------------------------------------------------------
    // 7. No trashed rows with is_home=1.
    //
    // Important: the recovery hint must NOT recommend
    // `UPDATE pages SET is_home=0 WHERE deleted_at IS NOT NULL` in
    // isolation — that would break assert #2 if the only is_home=1
    // row was trashed. The two-part recovery (restore-or-reseed) is
    // explicit.
    // -------------------------------------------------------------------
    const [orphanHome] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM pages
      WHERE deleted_at IS NOT NULL AND is_home = 1
    `)
    const orphanHomeN = Number(orphanHome[0]?.['n'] ?? 0)
    if (orphanHomeN !== 0) {
      throw new Error(
        `[post-migrate-asserts] #7 trashed rows still hold is_home=1: ${orphanHomeN}; recovery (option A): UPDATE pages SET deleted_at=NULL WHERE slug='home'; — restore the trashed row in place. (option B): INSERT INTO pages (slug,title,is_home,system,published,published_at,created_at) VALUES ('home','Home',1,1,1,NOW(3),NOW(3)) ON DUPLICATE KEY UPDATE is_home=1, system=1, published=1, deleted_at=NULL; — directly re-seed the canonical home row (this mirrors step 2.5 of the migration; drizzle marks 0010 applied after the first run so re-invoking pnpm db:migrate alone would skip the seed). NEVER clear is_home in isolation — slug='home' is UNIQUE so you cannot seed a replacement without freeing the slug first, and clearing is_home would also break assert #2`,
      )
    }

    // -------------------------------------------------------------------
    // 8. Every pages.slug passes the canonical regex.
    //
    // Pinned to utf8mb4_bin via COLLATE so MariaDB's REGEXP engine
    // cannot raise ER_CANT_AGGREGATE_2COLLATIONS on a mixed-collation
    // comparison and have the outer try/catch silently report an
    // engine error as "assert #8 failed".
    //
    // Sanity probe: known-bad string MUST regex-not-match. If the
    // engine returns 1 (match) or NULL on a known-bad input, the
    // engine is broken and the rule-vs-data comparison can't be
    // trusted.
    //
    // PR-2 ships lib/cms/slug.ts which will export the canonical
    // SLUG_RE. Keep this SQL string byte-equivalent to that constant.
    // -------------------------------------------------------------------
    const [sanityRows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT 'BAD SLUG' REGEXP _utf8mb4'^[a-z0-9]+(-[a-z0-9]+)*$' COLLATE utf8mb4_bin AS m`,
    )
    const sanityResult = Number(sanityRows[0]?.['m'] ?? -1)
    if (sanityResult !== 0) {
      throw new Error(
        `[post-migrate-asserts] #8 regex engine sanity check failed (got ${sanityResult}, want 0); the REGEXP engine cannot be trusted; recovery: investigate MariaDB pcre2 plugin status before re-deploying`,
      )
    }
    const [badSlug] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM pages
      WHERE slug NOT REGEXP _utf8mb4'^[a-z0-9]+(-[a-z0-9]+)*$' COLLATE utf8mb4_bin
    `)
    const badSlugN = Number(badSlug[0]?.['n'] ?? 0)
    if (badSlugN !== 0) {
      throw new Error(
        `[post-migrate-asserts] #8 pages.slug rows failing canonical regex: ${badSlugN}; recovery: SELECT id,slug FROM pages WHERE slug NOT REGEXP '^[a-z0-9]+(-[a-z0-9]+)*$'; — DELETE or rename the offending rows`,
      )
    }

    // -------------------------------------------------------------------
    // 9. All 7 system slugs survived seed AND have system=1.
    //    home/about/services/contact seeded by 0010_pages_cms.sql;
    //    privacy/terms seeded by 0015_legal_pages.sql;
    //    projects seeded by 0016_projects_page.sql.
    // -------------------------------------------------------------------
    const [sysSlugs] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT slug, system FROM pages
      WHERE slug IN ('home','about','services','contact','projects','privacy','terms')
        AND deleted_at IS NULL
      ORDER BY slug
    `)
    const expectedSlugs = ['about', 'contact', 'home', 'privacy', 'projects', 'services', 'terms']
    const gotSlugs = sysSlugs.map((r) => String(r['slug']))
    if (
      gotSlugs.length !== 7 ||
      gotSlugs.join(',') !== expectedSlugs.join(',')
    ) {
      throw new Error(
        `[post-migrate-asserts] #9 expected 7 system slugs [${expectedSlugs.join(',')}], got [${gotSlugs.map(sanitiseForLog).join(',')}]; recovery: re-INSERT the missing seed rows with system=1`,
      )
    }
    const nonSystemSeed = sysSlugs.filter((r) => Number(r['system']) !== 1)
    if (nonSystemSeed.length > 0) {
      throw new Error(
        `[post-migrate-asserts] #9 seed slugs found but not system=1: ${nonSystemSeed
          .map((r) => sanitiseForLog(String(r['slug'])))
          .join(',')}; recovery: UPDATE pages SET system=1 WHERE slug IN ('home','about','services','contact','projects','privacy','terms');`,
      )
    }

    // -------------------------------------------------------------------
    // 10. Transaction isolation level is REPEATABLE-READ (InnoDB default).
    //
    // PR-3's POST /api/cms/pages clone TX relies on REPEATABLE READ
    // snapshot semantics to pin source-page-block reads for the duration
    // of the clone (spec §4.1). Drizzle does not override the session
    // default; the route does not (and cannot) issue SET TRANSACTION
    // mid-TX (MariaDB rejects with error 1568). If a future deploy
    // overrides the server-level `tx_isolation` (RDS parameter group,
    // tx_isolation override in my.cnf, etc.) to READ COMMITTED, the
    // clone TX could observe block writes that landed AFTER the TX
    // started, producing a non-atomic clone. Halt deploy here so the
    // contract is verified at boot, not at runtime.
    //
    // MariaDB 10.x exposes both global + session variables; we check
    // both because the route runs under whatever the pool's default is
    // (typically inherits global, but a custom my.cnf or per-conn SET
    // could differ).
    // -------------------------------------------------------------------
    const [isolationRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT
        @@global.transaction_isolation AS g,
        @@session.transaction_isolation AS s
    `)
    const globalIso = String(isolationRows[0]?.['g'] ?? '')
    const sessionIso = String(isolationRows[0]?.['s'] ?? '')
    // MariaDB returns the value with hyphens ('REPEATABLE-READ').
    if (globalIso !== 'REPEATABLE-READ' || sessionIso !== 'REPEATABLE-READ') {
      throw new Error(
        `[post-migrate-asserts] #10 transaction isolation is not REPEATABLE-READ (global=${sanitiseForLog(globalIso)}, session=${sanitiseForLog(sessionIso)}); recovery: set tx_isolation=REPEATABLE-READ in the MariaDB config and restart the server. PR-3 pages-CMS clone TX correctness depends on this default.`,
      )
    }

    // -------------------------------------------------------------------
    // 11. Migration 0011 — content_blocks.kind='column' rows must have
    //     non-NULL parent_id. A loose column is semantically nonsense
    //     (columns only exist inside sections); the renderer drops
    //     them silently, but the data corruption itself signals an
    //     INSERT path that bypassed the API's kind/parent validators.
    // -------------------------------------------------------------------
    const [loneColumnRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM content_blocks
      WHERE kind = 'column' AND parent_id IS NULL AND deleted_at IS NULL
    `)
    const loneColumns = Number(loneColumnRows[0]?.['n'] ?? 0)
    if (loneColumns !== 0) {
      throw new Error(
        `[post-migrate-asserts] #11 ${loneColumns} kind='column' row(s) with parent_id IS NULL — columns must live under a section; recovery: re-parent or soft-delete via the admin tools, then re-run.`,
      )
    }

    // -------------------------------------------------------------------
    // 12. Migration 0011 — content_blocks.kind='section' rows must have
    //     parent_id IS NULL. Sections are page-level only; nesting one
    //     under a column would orphan the renderer's tree-walk.
    // -------------------------------------------------------------------
    const [nestedSectionRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COUNT(*) AS n FROM content_blocks
      WHERE kind = 'section' AND parent_id IS NOT NULL AND deleted_at IS NULL
    `)
    const nestedSections = Number(nestedSectionRows[0]?.['n'] ?? 0)
    if (nestedSections !== 0) {
      throw new Error(
        `[post-migrate-asserts] #12 ${nestedSections} kind='section' row(s) with parent_id IS NOT NULL — sections must be top-level; recovery: re-parent to NULL or soft-delete via the admin tools, then re-run.`,
      )
    }

    // -------------------------------------------------------------------
    // 13. Migration 0011 — every non-NULL parent_id must point at a
    //     kind compatible with the child: column→section, widget→column.
    //     Catches a manual UPDATE that re-parents a widget under a
    //     section (skipping the column layer) — the renderer would drop
    //     it silently and the operator would see "block missing".
    // -------------------------------------------------------------------
    const [kindPairRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT child.kind AS child_kind, parent.kind AS parent_kind, COUNT(*) AS n
      FROM content_blocks child
      JOIN content_blocks parent ON parent.id = child.parent_id
      WHERE child.deleted_at IS NULL AND parent.deleted_at IS NULL
      GROUP BY child.kind, parent.kind
    `)
    const badPairs = kindPairRows.filter((r) => {
      const c = String(r['child_kind'])
      const p = String(r['parent_kind'])
      if (c === 'column' && p === 'section') return false
      if (c === 'widget' && p === 'column') return false
      return true
    })
    if (badPairs.length > 0) {
      const detail = badPairs
        .map((r) => `${sanitiseForLog(String(r['child_kind']))} under ${sanitiseForLog(String(r['parent_kind']))} (${r['n']})`)
        .join(', ')
      throw new Error(
        `[post-migrate-asserts] #13 invalid child→parent kind pairings: ${detail}; recovery: re-parent or soft-delete the offending rows via the admin tools.`,
      )
    }

    // -------------------------------------------------------------------
    // 14. Migration 0011 — self-FK on content_blocks(parent_id) →
    //     content_blocks(id) with ON DELETE CASCADE must exist. Without
    //     it, hard-deleting a parent row (cron-purge) orphans children
    //     instead of cascading them out.
    // -------------------------------------------------------------------
    const [parentFkRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT rc.DELETE_RULE
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
        AND rc.TABLE_NAME = 'content_blocks'
        AND kcu.TABLE_NAME = 'content_blocks'
        AND kcu.COLUMN_NAME = 'parent_id'
        AND kcu.REFERENCED_TABLE_NAME = 'content_blocks'
        AND kcu.REFERENCED_COLUMN_NAME = 'id'
    `)
    if (parentFkRows.length === 0) {
      throw new Error(
        `[post-migrate-asserts] #14 self-FK content_blocks.parent_id → content_blocks.id missing; recovery: re-run migration 0011 (ALTER TABLE content_blocks ADD CONSTRAINT fk_content_blocks_parent FOREIGN KEY (parent_id) REFERENCES content_blocks(id) ON DELETE CASCADE).`,
      )
    }
    const parentFkRule = String(parentFkRows[0]?.['DELETE_RULE'] ?? '')
    if (parentFkRule !== 'CASCADE') {
      throw new Error(
        `[post-migrate-asserts] #14 self-FK content_blocks.parent_id has DELETE_RULE='${sanitiseForLog(parentFkRule)}'; expected CASCADE; recovery: DROP + ADD the constraint with ON DELETE CASCADE.`,
      )
    }

    // -------------------------------------------------------------------
    // 15. Migration 0011 — covering index (parent_id, position) on
    //     content_blocks must exist. The renderer's per-parent ORDER BY
    //     position sub-scan depends on it; missing index degrades to a
    //     filesort under load on pages with many blocks.
    // -------------------------------------------------------------------
    const [parentPosIdxRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'content_blocks'
        AND INDEX_NAME = 'idx_content_blocks_parent_position'
      ORDER BY SEQ_IN_INDEX
    `)
    const idxCols = parentPosIdxRows.map((r) => String(r['COLUMN_NAME']))
    if (idxCols.length !== 2 || idxCols[0] !== 'parent_id' || idxCols[1] !== 'position') {
      throw new Error(
        `[post-migrate-asserts] #15 idx_content_blocks_parent_position missing or wrong shape (got [${idxCols.map(sanitiseForLog).join(',')}]); recovery: CREATE INDEX idx_content_blocks_parent_position ON content_blocks (parent_id, position).`,
      )
    }

    // -------------------------------------------------------------------
    // 16. Migration 0021 — `crm_dispatch_log` must exist with the
    //     critical columns + FK + indexes the dispatcher + retry
    //     worker depend on. A partial-shape table (legacy dev run +
    //     CREATE TABLE IF NOT EXISTS skip) would let the app boot
    //     but break on the first dispatch INSERT — catch it here.
    // -------------------------------------------------------------------
    const [crmColRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'crm_dispatch_log'
    `)
    const crmCols = new Map(crmColRows.map((r) => [String(r['COLUMN_NAME']), r]))
    const required = [
      'id', 'lead_id', 'source', 'provider', 'destination_id',
      'payload_snapshot', 'status', 'http_code', 'response_excerpt',
      'attempt', 'next_retry_at', 'attempted_at',
    ]
    for (const c of required) {
      if (!crmCols.has(c)) {
        throw new Error(
          `[post-migrate-asserts] #16 crm_dispatch_log missing column '${c}'; recovery: drop the partial-shape table and re-run migration 0021 (DROP TABLE crm_dispatch_log; then pnpm db:migrate).`,
        )
      }
    }
    // lead_id must be NULLABLE so newsletter dispatch rows (no lead
    // row) can write with lead_id=NULL.
    const leadIdRow = crmCols.get('lead_id')
    if (leadIdRow && String(leadIdRow['IS_NULLABLE']) !== 'YES') {
      throw new Error(
        `[post-migrate-asserts] #16 crm_dispatch_log.lead_id must be NULLABLE (newsletter dispatches require lead_id=NULL); recovery: ALTER TABLE crm_dispatch_log MODIFY COLUMN lead_id INT NULL.`,
      )
    }
    // FK to leads(id) ON DELETE CASCADE so a lead deletion cleans up
    // its dispatch trail.
    const [crmFkRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT rc.DELETE_RULE
      FROM information_schema.REFERENTIAL_CONSTRAINTS rc
      JOIN information_schema.KEY_COLUMN_USAGE k
        ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
        AND rc.TABLE_NAME = 'crm_dispatch_log'
        AND k.COLUMN_NAME = 'lead_id'
        AND k.REFERENCED_TABLE_NAME = 'leads'
        AND k.REFERENCED_COLUMN_NAME = 'id'
    `)
    if (crmFkRows.length === 0) {
      throw new Error(
        `[post-migrate-asserts] #16 crm_dispatch_log missing FK to leads(id); recovery: re-run migration 0021.`,
      )
    }
    if (String(crmFkRows[0]?.['DELETE_RULE'] ?? '') !== 'CASCADE') {
      throw new Error(
        `[post-migrate-asserts] #16 crm_dispatch_log FK to leads(id) is not ON DELETE CASCADE; recovery: drop and re-add with ON DELETE CASCADE.`,
      )
    }
    // Index supporting the retry-worker due-row query.
    const [crmIdxRows] = await conn.execute<mysql.RowDataPacket[]>(`
      SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'crm_dispatch_log'
        AND INDEX_NAME = 'idx_crm_dispatch_log_retry'
      ORDER BY SEQ_IN_INDEX
    `)
    const crmIdxCols = crmIdxRows.map((r) => String(r['COLUMN_NAME']))
    if (crmIdxCols.length !== 2 || crmIdxCols[0] !== 'status' || crmIdxCols[1] !== 'next_retry_at') {
      throw new Error(
        `[post-migrate-asserts] #16 idx_crm_dispatch_log_retry missing or wrong shape (got [${crmIdxCols.map(sanitiseForLog).join(',')}]); recovery: CREATE INDEX idx_crm_dispatch_log_retry ON crm_dispatch_log (status, next_retry_at).`,
      )
    }

    console.log('[post-migrate-asserts] passed (16/16)')
  } finally {
    try {
      await conn.end()
    } catch {
      // connection cleanup error at script exit is benign.
    }
  }
}

try {
  await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
