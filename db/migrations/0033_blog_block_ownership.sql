-- Posts move onto the block engine: a post's body is a hidden `pages` row
-- (kind='post_body') whose content_blocks tree IS the body. posts.body_page_id
-- is the explicit link (ON DELETE SET NULL so dropping a body page never
-- hard-deletes the post; the post-purge cron removes the body page explicitly).
-- pages.kind discriminates normal pages from these hidden body pages; every
-- page-surfacing query filters kind='page' (spec §4.4). Defaults preserve
-- current behavior: every existing page is kind='page'.
--
-- IDEMPOTENCY: the migration runners (scripts/install-migrate.mjs and the
-- contributor drizzle-kit path) apply DDL statement-by-statement and RETHROW on
-- any error, with no duplicate-key tolerance. MySQL/MariaDB has no
-- transactional DDL, so a mid-migration interruption could leave columns added
-- but the index/FK not yet recorded — a naive re-run of a bare
-- `ADD KEY`/`ADD CONSTRAINT` would then abort with ER_DUP_KEYNAME (1061) and
-- wedge the install/update permanently. `ADD KEY`/`ADD CONSTRAINT` have no
-- `IF NOT EXISTS` on the supported MariaDB range, so each is guarded by an
-- information_schema existence check executed via a prepared statement — making
-- every statement here safely re-runnable.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS body_page_id INT NULL AFTER body_md;

SET @have_body_page_key := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'posts'
    AND index_name = 'idx_posts_body_page'
);
SET @sql := IF(@have_body_page_key = 0,
  'ALTER TABLE posts ADD KEY idx_posts_body_page (body_page_id)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @have_body_page_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE table_schema = DATABASE() AND table_name = 'posts'
    AND constraint_name = 'fk_posts_body_page' AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(@have_body_page_fk = 0,
  'ALTER TABLE posts ADD CONSTRAINT fk_posts_body_page FOREIGN KEY (body_page_id) REFERENCES pages(id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'page' AFTER system;

SET @have_kind_key := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE() AND table_name = 'pages'
    AND index_name = 'idx_pages_kind'
);
SET @sql := IF(@have_kind_key = 0,
  'ALTER TABLE pages ADD KEY idx_pages_kind (kind)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
