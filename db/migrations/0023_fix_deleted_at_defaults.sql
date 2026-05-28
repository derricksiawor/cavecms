-- 0023_fix_deleted_at_defaults.sql
--
-- Repairs a long-latent MariaDB schema bug present since 0002.
--
-- The PROBLEM. Migrations 0002, 0004, 0007, and 0008 declared
-- `deleted_at` columns as `timestamp(3)` with no explicit
-- NULL / DEFAULT. With `explicit_defaults_for_timestamp=0` (the
-- legacy MariaDB default on most installs), the FIRST TIMESTAMP
-- column in such a table gets silently promoted to:
--
--     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
--                       ON UPDATE CURRENT_TIMESTAMP(3)
--
-- Every INSERT that omits the column therefore lands a row whose
-- `deleted_at` is set to NOW(), and every UPDATE re-stamps it.
-- The renderer + every soft-delete-aware query filters on
-- `WHERE deleted_at IS NULL`, returning zero rows — so the public
-- home page falls through to the SplashFallback, the Media Library
-- looks empty, and so on.
--
-- Tables affected (verified on live test install):
--   content_blocks  default = CURRENT_TIMESTAMP(3) ON UPDATE same
--   media           default = CURRENT_TIMESTAMP(3) ON UPDATE same
--   leads           default = '0000-00-00 00:00:00.000'  (zero-date)
--   posts           default = '0000-00-00 00:00:00.000'
--   projects        default = '0000-00-00 00:00:00.000'
--
-- Only `pages.deleted_at` was correct (fixed by migration 0010 with
-- an explicit `NULL DEFAULT NULL`).
--
-- THE FIX. Two parts per table:
--   (a) ALTER COLUMN to TIMESTAMP(3) NULL DEFAULT NULL
--       — restores the intended "nullable, NULL by default" shape
--   (b) UPDATE … SET deleted_at = NULL WHERE deleted_at IS NOT NULL
--       — repairs every row inserted under the buggy schema
--
-- Migration is idempotent: re-running against a corrected schema is
-- a no-op (the ALTER COLUMN converges, the UPDATE matches 0 rows).
--
-- Drizzle uses statement-breakpoint between statements; one ALTER
-- + one UPDATE per table.

ALTER TABLE `content_blocks`
  MODIFY COLUMN `deleted_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
UPDATE `content_blocks` SET `deleted_at` = NULL WHERE `deleted_at` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `media`
  MODIFY COLUMN `deleted_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
UPDATE `media` SET `deleted_at` = NULL WHERE `deleted_at` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `leads`
  MODIFY COLUMN `deleted_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
UPDATE `leads` SET `deleted_at` = NULL WHERE `deleted_at` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `posts`
  MODIFY COLUMN `deleted_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
UPDATE `posts` SET `deleted_at` = NULL WHERE `deleted_at` IS NOT NULL;
--> statement-breakpoint

ALTER TABLE `projects`
  MODIFY COLUMN `deleted_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
UPDATE `projects` SET `deleted_at` = NULL WHERE `deleted_at` IS NOT NULL;
