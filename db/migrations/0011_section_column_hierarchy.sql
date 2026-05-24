-- Migration 0011 — section / column hierarchy on content_blocks
--
-- Extends the existing flat block list into a 2-level visual tree:
--
--   Section (kind='section', parent_id IS NULL)
--     ├─ Column (kind='column', parent_id=section.id)
--     │    ├─ Widget (kind='widget', parent_id=column.id)
--     │    └─ Widget …
--     └─ Column …
--
-- Existing rows are all kind='widget' with parent_id NULL — they
-- continue to render as "loose" top-level widgets (each effectively
-- a one-column / one-widget section). New widgets created inside a
-- section land with parent_id=column.id.
--
-- `meta` JSON is the per-kind settings bag:
--   - section: { background?: 'cream' | 'near-black' | 'copper-tint',
--                padding?: 'sm' | 'md' | 'lg',
--                columns?: 1 | 2 | 3 | 4 }
--   - column:  { width?: number /* 1..12 grid units; null = even */ }
--   - widget:  null (widgets carry their layout config in `data`)
--
-- Self-referential FK with ON DELETE CASCADE so deleting a section
-- drops its columns + widgets atomically. The (parent_id, position)
-- index covers the per-parent ORDER BY position scan that the tree-
-- hydration query performs once per parent node.
--
-- IF NOT EXISTS guards make this idempotent against re-runs from
-- the migration ledger. MariaDB 10.6+ is required (already enforced
-- by scripts/preflight.sh + pre-migrate-asserts).

ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS parent_id INT NULL AFTER page_id,
  ADD COLUMN IF NOT EXISTS kind ENUM('section', 'column', 'widget')
    NOT NULL DEFAULT 'widget' AFTER parent_id,
  ADD COLUMN IF NOT EXISTS meta JSON NULL AFTER data;

-- Add the FK. The drop-then-add pattern is idempotent against a
-- partial prior run; the migration ledger handles the no-op case
-- on full success. MariaDB 10.6+ supports `DROP CONSTRAINT IF
-- EXISTS` cleanly (MDEV-16745 + MDEV-22388).
ALTER TABLE content_blocks
  DROP CONSTRAINT IF EXISTS fk_content_blocks_parent;
ALTER TABLE content_blocks
  ADD CONSTRAINT fk_content_blocks_parent
    FOREIGN KEY (parent_id) REFERENCES content_blocks(id)
    ON DELETE CASCADE;

-- Tree-walk index. Used by `hydratePage` to fetch all direct
-- children of a parent in position order — `(parent_id, position)`
-- covers `WHERE parent_id = ? ORDER BY position` in one index seek.
CREATE INDEX IF NOT EXISTS idx_content_blocks_parent_position
  ON content_blocks (parent_id, position);

-- Sanity check (post-apply): every kind='column' row MUST have a
-- non-NULL parent_id (column without a section is nonsense);
-- every kind='section' row MUST have parent_id IS NULL (sections
-- are page-level). Widgets can be at either level (loose top-level
-- legacy, or inside a column). These invariants will be asserted
-- by scripts/post-migrate-asserts.ts on next deploy.
