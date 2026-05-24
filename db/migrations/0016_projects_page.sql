-- §16: seed the Projects index as a system CMS page.
--
-- Pre-0016 the /projects route was a hardcoded React shim
-- (app/projects/page.tsx) that queried the `projects` table and
-- rendered its own grid. That violated the project's CMS-first
-- contract — the hero copy, intro paragraph, and CTA on the index
-- page weren't operator-editable.
--
-- This migration inserts the `pages.slug='projects'` row so the new
-- thin shim at app/projects/page.tsx can resolve via
-- renderCmsPage('projects'). The block tree (hero cover image +
-- intro + featured_projects + CTA) is seeded by
-- seedProjectsPageBlocksIfEmpty in db/seeds/systemPageBlocks.ts.
--
-- The projects LISTING data still lives in the `projects` table —
-- the featured_projects block within the tree references those rows
-- by id, so the list stays data-driven while the surrounding page
-- is CMS-driven.
--
-- post-migrate-asserts.ts assert #3 now expects 7 system rows (was 6)
-- and assert #9's slug allow-list adds 'projects'.

INSERT INTO pages (slug, title, is_home, system, published, published_at, created_at)
VALUES
  ('projects', 'Projects', 0, 1, 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  is_home      = VALUES(is_home),
  system       = 1,
  published    = 1,
  published_at = COALESCE(pages.published_at, VALUES(published_at)),
  title        = IF(pages.title = '' OR pages.title IS NULL, VALUES(title), pages.title);
