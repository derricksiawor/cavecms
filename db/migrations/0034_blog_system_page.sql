-- §5: seed the Blog index as a system CMS page.
--
-- Pre-0034 the /blog route was a hardcoded React shim (app/blog/page.tsx)
-- that queried the `posts` table and rendered its own grid — the hero copy,
-- intro, and CTA on the index weren't operator-editable, violating the
-- project's CMS-first contract (#1). This migration inserts the
-- `pages.slug='blog'` row so the new thin shim at app/blog/page.tsx resolves
-- via renderCmsPage('blog'). The block tree (hero + intro + a loop-mode
-- lx_posts "Blog Loop" + CTA) is seeded by seedBlogPageBlocksIfEmpty in
-- db/seeds/systemPageBlocks.ts on the contributor path; on customer installs
-- the welcome/default template seeds it via app/api/install/template, and on
-- EXISTING installs the boot-time runBlogPageBackfillOnce (instrumentation.ts)
-- seeds the blocks into this row if it is empty — so the migration only needs
-- to guarantee the ROW exists. `kind` defaults to 'page' (migration 0033), so
-- this is a normal, surfaceable system page (NOT a hidden post_body page).
--
-- The post LISTING data still lives in the `posts` table — the loop block
-- references those rows at hydrate, so the list stays data-driven while the
-- surrounding page is CMS-driven (same shape as 0016 for projects).
--
-- 'blog' is already in lib/cms/page-slug RESERVED, so no normal page can claim
-- the slug. post-migrate-asserts #3 now expects 8 live system rows (was 7) and
-- #9's slug allow-list adds 'blog'.
--
-- ON DUPLICATE KEY UPDATE re-asserts system=1/published=1 idempotently (a
-- re-run, or an install where a non-system 'blog' page was somehow created
-- first, converges to the canonical system row) without clobbering an
-- operator-edited title.

INSERT INTO pages (slug, title, is_home, system, published, published_at, created_at)
VALUES
  ('blog', 'Blog', 0, 1, 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  is_home      = VALUES(is_home),
  system       = 1,
  published    = 1,
  published_at = COALESCE(pages.published_at, VALUES(published_at)),
  title        = IF(pages.title = '' OR pages.title IS NULL, VALUES(title), pages.title);
