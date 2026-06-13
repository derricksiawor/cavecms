-- Per-page header-mode override for the overlay header (0.3.9 follow-up).
-- NULL = inherit (site default + first-section auto-resolve);
-- 'solid' | 'overlay' = operator forced the mode for this page.
ALTER TABLE pages ADD COLUMN header_mode VARCHAR(10) NULL DEFAULT NULL;
--> statement-breakpoint
-- The header-mode resolver looks pages up by url_path on EVERY public
-- request (SiteHeader is layout-level). Index the STORED-generated
-- url_path column so that hot-path lookup is an index seek, not a scan.
CREATE INDEX idx_pages_url_path ON pages (url_path);
