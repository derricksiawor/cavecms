-- 0014_html_id_unique.sql
--
-- Closes the application-level TOCTOU on the per-page htmlId
-- uniqueness check. Prior to this migration, two concurrent PATCH /
-- POST against the same page with the same `meta.htmlId` could BOTH
-- pass `assertHtmlIdUnique` (the SELECT is non-locking, runs outside
-- saveBlockMeta's transaction) and BOTH commit — producing duplicate
-- DOM ids on the rendered page, breaking #anchor navigation and
-- CSS-id selectors.
--
-- Fix: lift JSON_EXTRACT(meta, '$.htmlId') into a generated stored
-- column, then UNIQUE-constrain (page_id, html_id_live). The CASE
-- gate on deleted_at zeroes the column for soft-deleted rows so a
-- restored block (or a fresh block creating after another's soft
-- delete) can re-use the same htmlId without engaging the constraint.
--
-- Generated columns + JSON_EXTRACT are supported on MariaDB 10.2+.
-- The project's baseline is MariaDB 10.11 (see README + db/min-
-- mariadb-version.ts), so we're well within support.
--
-- The application-level pre-check in app/api/cms/blocks/[id]/route.ts
-- + app/api/cms/blocks/route.ts stays — it lets the operator see a
-- clean 409 BEFORE the doomed write, instead of catching the MariaDB
-- 1062 duplicate-key error after the round trip. The unique index is
-- the AUTHORITATIVE gate that closes the TOCTOU race.

-- IF NOT EXISTS guards make this idempotent against re-runs (matches
-- the 0011/0012 pattern). MariaDB 10.0+ supports both on ALTER TABLE
-- and CREATE INDEX.
ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS html_id_live VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE
        WHEN deleted_at IS NULL
          THEN JSON_UNQUOTE(JSON_EXTRACT(meta, '$.htmlId'))
        ELSE NULL
      END
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_content_blocks_page_html_id_live
  ON content_blocks (page_id, html_id_live);
