-- Per-entity SEO fields for the SEO suite. Added to all three content
-- surfaces that share the metadata engine: pages, posts, projects.
--
-- Real (queryable) columns are split out from a JSON bag on purpose:
--   • robots_noindex / robots_nofollow / cornerstone — filtered in bulk
--     (sitemap "exclude noindex", overview "orphaned/cornerstone"
--     queries) so they must be real, indexable columns, not JSON paths.
--   • focus_keyphrase — cross-row "previously used keyphrase"
--     (cannibalization) check.
--   • seo_score / readability_score — cached at save time so the
--     overview dashboard's "quick wins" never re-runs the analysis
--     engine over every row.
--   • canonical_url — small, read on every page render.
--   • seo_meta (JSON) — the render-only override bag (og/twitter title
--     + description, extra keyphrases, per-page schema type + data).
--     Never bulk-queried, so JSON is the right home.
--
-- All ADD COLUMN guarded IF NOT EXISTS (MariaDB 10.x) so re-running
-- against a partially-migrated dev DB is a no-op. Booleans are TINYINT(1)
-- NOT NULL DEFAULT 0 to match drizzle `boolean().notNull().default(false)`.

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS focus_keyphrase VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS robots_noindex TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS robots_nofollow TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canonical_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS cornerstone TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seo_score INT NULL,
  ADD COLUMN IF NOT EXISTS readability_score INT NULL,
  ADD COLUMN IF NOT EXISTS seo_meta JSON NULL;
--> statement-breakpoint
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS focus_keyphrase VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS robots_noindex TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS robots_nofollow TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canonical_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS cornerstone TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seo_score INT NULL,
  ADD COLUMN IF NOT EXISTS readability_score INT NULL,
  ADD COLUMN IF NOT EXISTS seo_meta JSON NULL;
--> statement-breakpoint
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS focus_keyphrase VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS robots_noindex TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS robots_nofollow TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canonical_url VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS cornerstone TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seo_score INT NULL,
  ADD COLUMN IF NOT EXISTS readability_score INT NULL,
  ADD COLUMN IF NOT EXISTS seo_meta JSON NULL;
