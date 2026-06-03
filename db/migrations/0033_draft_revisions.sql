-- 0029_draft_revisions.sql
-- Server-side undo/redo for the page draft. Each committed draft change records
-- a full-tree SNAPSHOT as a revision; undo/redo restore a revision by reconciling
-- the draft rows to match it. Persists across reloads + sessions, handles every
-- op (data/meta/position/parent/insert/delete) uniformly, and is fully
-- API-programmable (POST /api/cms/pages/[id]/undo|redo).
--
-- The cursor (pages.draft_undo_cursor) is the seq of the CURRENT draft state.
-- seq 0 is the baseline (clean draft == published) recorded on first edit;
-- each subsequent change appends seq cursor+1 (truncating any redo tail).
-- canUndo = a revision with seq < cursor exists; canRedo = seq > cursor exists.

CREATE TABLE page_draft_revisions (
  id INT NOT NULL AUTO_INCREMENT,
  page_id INT NOT NULL,
  seq INT NOT NULL,
  snapshot JSON NOT NULL,
  label VARCHAR(120) NULL,
  created_by INT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_pdr_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_pdr_page_seq (page_id, seq),
  KEY idx_pdr_page (page_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE pages
  ADD COLUMN draft_undo_cursor INT NOT NULL DEFAULT 0 AFTER draft_version;
