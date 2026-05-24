-- §1.4 / step 1: widen slug enum -> VARCHAR(140) with utf8mb4_bin.
-- Idempotent: MariaDB's MODIFY on an already-matching column is a no-op
-- metadata change. Re-running after partial rollback is safe.
ALTER TABLE pages
  MODIFY slug VARCHAR(140) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL;
--> statement-breakpoint

-- §1.4 / step 2: add new columns with transient defaults so existing 4
-- rows survive. IF NOT EXISTS guards make re-runs idempotent.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS title          VARCHAR(220)    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_home        TINYINT(1)      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS system         TINYINT(1)      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published      TINYINT(1)      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_at   TIMESTAMP(3)    NULL,
  ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMP(3)    NULL,
  ADD COLUMN IF NOT EXISTS hero_image_id  INT             NULL,
  ADD COLUMN IF NOT EXISTS preview_epoch  INT             NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
--> statement-breakpoint

-- §1.4 / step 2.4: ensure idx_pages_slug exists BEFORE step 2.5's INSERT
-- IGNORE relies on UNIQUE-on-slug semantics for collision-skip. On the
-- pre-0010 schema slug was an ENUM (4 fixed values). ENUMs do NOT create
-- an implicit unique index — uniqueness was application-level (only 4
-- legal values). Step 1's MODIFY widens to VARCHAR, dropping that
-- application-level constraint. This step materialises the explicit
-- UNIQUE INDEX. Idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_slug ON pages (slug);
--> statement-breakpoint

-- §1.4 / step 2.5: seed the 4 system rows.
--
-- On fresh install: inserts all 4 rows with canonical values.
-- On upgrade where a row already exists (pre-PR-1 'home' row, or a
-- legacy operator-created row that owned a canonical slug):
-- ON DUPLICATE KEY UPDATE forces the canonical is_home/system/published
-- shape onto the colliding row so a pre-existing non-system or
-- non-published row gets re-flagged. The title is only backfilled when
-- the existing row's title is blank — never overwrite operator-set
-- titles. published_at is preserved if non-null (don't overwrite the
-- original publish date).
--
-- VALUES(col) references the to-be-inserted value for the conflict-row,
-- so `is_home = VALUES(is_home)` resolves to 1 for the 'home' row and
-- 0 for the others — restoring the canonical layout even on a legacy
-- row that drifted.
--
-- This closes the case where the old INSERT IGNORE would silently
-- leave a pre-existing system=0 row in place. Assert #9 still
-- belt-and-braces verifies the result.
INSERT INTO pages (slug, title, is_home, system, published, published_at, created_at)
VALUES
  ('home',     'Home',     1, 1, 1, NOW(3), NOW(3)),
  ('about',    'About',    0, 1, 1, NOW(3), NOW(3)),
  ('services', 'Services', 0, 1, 1, NOW(3), NOW(3)),
  ('contact',  'Contact',  0, 1, 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  is_home      = VALUES(is_home),
  system       = 1,
  published    = 1,
  published_at = COALESCE(pages.published_at, VALUES(published_at)),
  title        = IF(pages.title = '' OR pages.title IS NULL, VALUES(title), pages.title);
--> statement-breakpoint

-- §1.4 / step 3: backfill legacy rows that lack title.
--
-- Constrained to the 4 known system slugs so a custom test row with
-- empty title (created via dev tooling on a relaxed-ENUM schema)
-- doesn't accidentally inherit system=1 / is_home=1 / published=1.
-- The non-system path is reserved for operator-created pages whose
-- create flow always supplies a non-empty title.
UPDATE pages
SET title = CASE slug
              WHEN 'home'     THEN 'Home'
              WHEN 'about'    THEN 'About'
              WHEN 'services' THEN 'Services'
              WHEN 'contact'  THEN 'Contact'
            END,
    is_home      = CASE slug WHEN 'home' THEN 1 ELSE 0 END,
    system       = 1,
    published    = 1,
    published_at = COALESCE(published_at, NOW(3))
WHERE slug IN ('home','about','services','contact')
  AND (title = '' OR title IS NULL);
--> statement-breakpoint

-- §1.4 / step 4: retighten title (no default - every future insert
-- must supply one). Idempotent: DROP DEFAULT on a column with no
-- default is a MariaDB no-op.
ALTER TABLE pages ALTER COLUMN title DROP DEFAULT;
--> statement-breakpoint

-- §1.4 / step 5: emulate "partial unique on is_home=1" via STORED
-- generated column. COPY algorithm - table is rewritten + meta-locked
-- (instant on 4 rows). The unique index sees one '1' and N NULLs;
-- NULL values are not considered equal in UNIQUE under MariaDB, so
-- multiple is_home=0 rows are allowed.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS is_home_key TINYINT(1)
    GENERATED ALWAYS AS (IF(is_home = 1, 1, NULL)) STORED;
--> statement-breakpoint

-- Partial-unique emulation index. Split into its own chunk because the
-- Drizzle mysql2 migrator submits each chunk via a single execute()
-- call and mysql2 rejects multi-statement bodies by default.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_is_home_unique ON pages (is_home_key);
--> statement-breakpoint

-- §1.4 / step 5b: url_path generated column - single canonical URL
-- pathway. '/' when is_home=1; '/{slug}' otherwise. STORED so it's
-- available as a read-side column for sitemap, JSON-LD canonical, and
-- redirect-target resolution. NEVER used for the public render lookup
-- (still by slug). COPY algorithm - same caveat as step 5.
--
-- MariaDB does NOT permit NOT NULL on a STORED generated column (unlike
-- MySQL 5.7+). The expression is deterministic and always non-null in
-- practice, but the schema-level NOT NULL must be dropped. Post-migrate
-- assert #5 verifies every row produces the expected non-null value.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS url_path VARCHAR(142)
    GENERATED ALWAYS AS (IF(is_home = 1, '/', CONCAT('/', slug))) STORED;
--> statement-breakpoint

-- §1.4 / step 6: new indexes for public render and admin trash.
CREATE INDEX IF NOT EXISTS idx_pages_published       ON pages (published, published_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pages_deleted_updated ON pages (deleted_at, updated_at);
--> statement-breakpoint

-- §1.4 / step 7: content_blocks gets the cascading FK so cron-purge
-- hard-delete cascades atomically. The pre-migrate-asserts orphan
-- check already verified no orphan content_blocks exist; this
-- constraint creation will succeed on first run.
--
-- Constraint name `content_blocks_page_id_pages_id_fk` is Drizzle's
-- auto-generated name. Using the auto-name keeps `pnpm db:generate`
-- idempotent (drizzle-kit writes the same name to the snapshot).
--
-- Idempotency: MariaDB does NOT support `ADD CONSTRAINT IF NOT EXISTS`
-- for FOREIGN KEY (MDEV-16745 only added IF NOT EXISTS for CHECK and
-- UNIQUE). Instead of a stored procedure (which would require granting
-- CREATE ROUTINE / ALTER ROUTINE / EXECUTE to the migrator principal
-- and would leak a routine namespace), use session-variable + PREPARE
-- /EXECUTE pattern with the existing ALTER privilege. Detection by
-- KEY_COLUMN_USAGE column-target (not constraint name) catches the
-- case where a legacy FK exists with a different name — re-adding
-- would create a second silent-RESTRICT FK that overrides our cascade.
SET @bwc_fk_exists := (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'content_blocks'
    AND COLUMN_NAME = 'page_id'
    AND REFERENCED_TABLE_SCHEMA = DATABASE()
    AND REFERENCED_TABLE_NAME = 'pages'
    AND REFERENCED_COLUMN_NAME = 'id'
);
--> statement-breakpoint

SET @bwc_fk_ddl := IF(@bwc_fk_exists = 0,
  'ALTER TABLE content_blocks ADD CONSTRAINT content_blocks_page_id_pages_id_fk FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE',
  'DO 0');
--> statement-breakpoint

PREPARE bwc_fk_stmt FROM @bwc_fk_ddl;
--> statement-breakpoint

EXECUTE bwc_fk_stmt;
--> statement-breakpoint

DEALLOCATE PREPARE bwc_fk_stmt;
--> statement-breakpoint

-- Belt-and-braces: clear the user-defined session variables so they
-- don't linger on a pooled connection (mysql2 in pool-mode could
-- theoretically hand the same conn to a later operation that reads
-- @bwc_fk_ddl by accident).
SET @bwc_fk_exists := NULL, @bwc_fk_ddl := NULL;
--> statement-breakpoint

-- §1.4 / step 8: extend slug_redirects.resource_type to include 'page'.
-- The TS enum widens at the schema layer; the SQL is a NOT NULL
-- re-assert. Idempotent: MODIFY on an already-matching column is a
-- no-op.
ALTER TABLE slug_redirects
  MODIFY resource_type VARCHAR(16) NOT NULL;
--> statement-breakpoint

-- §1.4 / step 8.5: pre-flight handled by scripts/pre-migrate-asserts.ts
-- assert #3 (duplicate (resource_type, old_slug) rows). No inline SQL
-- here - the JS pre-flight is the single source of truth, runs BEFORE
-- the migrator fires. The check is still relevant even though the
-- canonical UNIQUE index already exists since migration 0004 — a
-- pre-existing duplicate WOULD have crashed step 9's IF NOT EXISTS
-- index re-creation if it weren't already there, AND signals a
-- corrupted state that needs operator attention.
--> statement-breakpoint

-- §1.4 / step 9: removed. Migration 0004_normal_shard.sql:45 already
-- created CONSTRAINT idx_redirects_type_old UNIQUE(resource_type,
-- old_slug) when slug_redirects was first defined. The schema in
-- db/schema/projects.ts:129 declares this same index, and the
-- 0010_snapshot.json carries it forward. A redundant
-- CREATE UNIQUE INDEX here would land a second physical index on the
-- same column tuple, causing schema drift between actual DB state and
-- the snapshot (and wasted write amplification on every INSERT into
-- slug_redirects).
SELECT 'step 9 omitted: idx_redirects_type_old already created by migration 0004' AS msg;
