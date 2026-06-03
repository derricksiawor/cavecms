-- 0028_draft_overlay.sql
-- Draft → Publish: per-row draft overlay on content_blocks + page-level draft
-- bookkeeping.
--
-- The live data/meta/position/parent_id columns remain the PUBLISHED tree that
-- the public reads. Edits accumulate in the draft_* columns and are materialised
-- into the live columns only on Publish (one transaction per page).
--
-- draft_state per row:
--   live     — no pending draft change (draft_* are NULL/ignored)
--   modified — draft_data/draft_meta/draft_position/draft_parent_id hold the edit
--   added    — block created in the draft only (public hydrate EXCLUDES it)
--   removed  — block deleted in the draft only (public hydrate KEEPS it until publish)
--
-- Backfill is implicit: every existing row defaults to draft_state='live' with
-- NULL draft_* (fully published, no pending draft), and every page defaults to
-- has_draft=0 — so behaviour is identical to today until Phase 1 routes writes
-- into the draft channel.

ALTER TABLE content_blocks
  ADD COLUMN draft_data json NULL AFTER data,
  ADD COLUMN draft_meta json NULL AFTER meta,
  ADD COLUMN draft_position int NULL AFTER position,
  -- draft_parent_id is app-validated (no FK): a draft move may target a block
  -- that is itself draft_state='added' and not yet a stable published parent.
  ADD COLUMN draft_parent_id int NULL AFTER parent_id,
  ADD COLUMN draft_state enum('live','modified','added','removed')
    NOT NULL DEFAULT 'live' AFTER version;

-- Fast scan of a page's pending draft rows when publishing / discarding / counting.
CREATE INDEX idx_blocks_draft_state ON content_blocks (page_id, draft_state);

ALTER TABLE pages
  -- has_draft = "this page has at least one block with draft_state != 'live'".
  ADD COLUMN has_draft tinyint(1) NOT NULL DEFAULT 0 AFTER version,
  -- draft_version advances on every draft autosave; the editor sends its last-seen
  -- value so a second device editing the same page surfaces a "draft changed
  -- elsewhere — reload" banner (advisory, last-write-wins — NOT a hard 409).
  ADD COLUMN draft_version int NOT NULL DEFAULT 0 AFTER has_draft,
  ADD COLUMN draft_updated_at timestamp(3) NULL AFTER draft_version,
  -- app-set (no FK in Phase 0; mirror the updated_by set-null convention later if needed).
  ADD COLUMN draft_updated_by int NULL AFTER draft_updated_at;
