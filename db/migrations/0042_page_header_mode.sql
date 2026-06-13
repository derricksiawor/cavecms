-- Per-page header-mode override for the overlay header (0.3.9 follow-up).
-- NULL = inherit (site default + first-section auto-resolve);
-- 'solid' | 'overlay' = operator forced the mode for this page.
ALTER TABLE pages ADD COLUMN header_mode VARCHAR(10) NULL DEFAULT NULL;
