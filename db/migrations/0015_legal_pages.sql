-- §15: seed Privacy + Terms system pages.
--
-- Mirrors the 4-row block in 0010_pages_cms.sql for home/about/services/
-- contact: INSERT ... ON DUPLICATE KEY UPDATE forces the canonical
-- `system=1, published=1` shape onto any colliding legacy row. Both
-- rows are non-home (`is_home=0`); the Home flag remains owned by the
-- 'home' row seeded in 0010.
--
-- Title backfills only when the existing row's title is blank — we
-- never overwrite an operator-set title. published_at is preserved if
-- already non-null so the original publish date survives a re-run.
--
-- Block tree for each page (eyebrow + heading + body text per section)
-- lives in db/seeds/systemPageBlocks.ts and is inserted by `pnpm db:seed`.
-- The CMS-first contract (see project CLAUDE.md) means the legal copy is
-- editable via /admin/pages without touching this migration.
--
-- post-migrate-asserts.ts assert #3 caps live system rows at 6 (was 4)
-- and the slug allow-list there now includes 'privacy' + 'terms'.

INSERT INTO pages (slug, title, is_home, system, published, published_at, created_at)
VALUES
  ('privacy', 'Privacy Policy',   0, 1, 1, NOW(3), NOW(3)),
  ('terms',   'Terms of Service', 0, 1, 1, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  is_home      = VALUES(is_home),
  system       = 1,
  published    = 1,
  published_at = COALESCE(pages.published_at, VALUES(published_at)),
  title        = IF(pages.title = '' OR pages.title IS NULL, VALUES(title), pages.title);
