-- Posts move onto the block engine: a post's body is a hidden `pages` row
-- (kind='post_body') whose content_blocks tree IS the body. posts.body_page_id
-- is the explicit link (ON DELETE SET NULL so dropping a body page never
-- hard-deletes the post; the post-purge cron removes the body page explicitly).
-- pages.kind discriminates normal pages from these hidden body pages; every
-- page-surfacing query filters kind='page' (spec §4.4). Defaults preserve
-- current behavior: every existing page is kind='page'.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS body_page_id INT NULL AFTER body_md;

-- ADD KEY / ADD CONSTRAINT are not IF NOT EXISTS-able on all MariaDB versions.
-- The migrate runner / direct apply may warn "Duplicate key name" on re-run —
-- that is safe to ignore. Apply once.
ALTER TABLE posts
  ADD KEY idx_posts_body_page (body_page_id);
ALTER TABLE posts
  ADD CONSTRAINT fk_posts_body_page FOREIGN KEY (body_page_id) REFERENCES pages(id) ON DELETE SET NULL;

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'page' AFTER system;

-- Helps the "list normal pages" hot path skip body pages.
ALTER TABLE pages
  ADD KEY idx_pages_kind (kind);
