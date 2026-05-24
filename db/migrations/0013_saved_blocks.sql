-- Migration 0013 — saved blocks library (operator's per-user reusable
-- block library; "Save as block" right-click verb + Saved tab in the
-- WidgetPicker).
--
-- One row per saved block. Scoped per-user (each operator has their
-- own library; cross-team sharing is future work). V1 captures widgets
-- only — sections + columns are a future tier so the `kind` enum has
-- a single value today and can be widened forward-compatibly via
-- a later ALTER TABLE … MODIFY (MariaDB treats single-value -> multi-
-- value enum widening as metadata-only).
--
-- `data` holds the persisted widget data payload (already sanitized +
-- Zod-validated at create time via blockSchemas, re-validated again
-- at instantiate time as defence-in-depth against post-deploy schema
-- tightening).
--
-- `meta` is the WidgetMetaSchema-validated payload WITH `htmlId`
-- stripped (htmlId is per-page-unique — a saved block can't carry one
-- forward). NULL when the source widget had no spacing / visibility
-- overrides.
--
-- `preview` is reserved for a future thumbnail/screenshot URL; V1
-- never writes it (column is NULLable) but the schema commit lands
-- now so a forward-compat ALTER ADD COLUMN doesn't require a second
-- migration.
--
-- IF NOT EXISTS makes the migration idempotent against re-runs from
-- the ledger (matches the 0012 pattern).

CREATE TABLE IF NOT EXISTS saved_blocks (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Owner. ON DELETE CASCADE so a deleted operator's library is swept
  -- atomically (matches the security_recaptcha_verification pattern
  -- in 0012). No info-leak surface from orphan rows.
  user_id INT NOT NULL,
  -- Operator-set label. Capped at 64 chars to match LabelSchema in
  -- lib/cms/blockMeta.ts (sanitizeLabel strips control bytes + collapses
  -- whitespace before the cap).
  name VARCHAR(64) NOT NULL,
  -- V1: 'widget' only. Sections/columns land in a future tier.
  -- ENUM rather than VARCHAR so a stray INSERT with kind='section'
  -- (forged or via a migration mishap) fails at the storage engine.
  kind ENUM('widget') NOT NULL DEFAULT 'widget',
  -- Registered block_type from the block-registry.
  block_type VARCHAR(50) NOT NULL,
  -- Widget data payload — sanitized + Zod-validated at create time.
  -- Re-validated at instantiate time to catch post-deploy schema
  -- tightening (see app/api/cms/saved-blocks/[id]/instantiate/route.ts).
  data JSON NOT NULL,
  -- WidgetMetaSchema payload with htmlId stripped. NULL when source
  -- had no overrides.
  meta JSON NULL,
  -- Reserved for V2 thumbnail/screenshot URL. NULL in V1.
  preview VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_saved_blocks_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- List-by-recency query plan: WHERE user_id=? ORDER BY created_at DESC.
-- Covering index serves the panel-load roundtrip without a filesort.
CREATE INDEX IF NOT EXISTS idx_saved_blocks_user_created
  ON saved_blocks (user_id, created_at);
