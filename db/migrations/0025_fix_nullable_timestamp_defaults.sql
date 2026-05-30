-- 0025_fix_nullable_timestamp_defaults.sql
--
-- Finishes the repair that 0023 started — the SAME long-latent MariaDB
-- bug, for the REMAINING nullable timestamp columns 0023/0010 didn't cover.
--
-- THE BUG (recap). Drizzle codegen emits a nullable `timestamp('x',{fsp:3})`
-- as bare `x timestamp(3)` — no explicit NULL / DEFAULT. On any server with
-- `explicit_defaults_for_timestamp=0` (the default on MariaDB ≤10.9, e.g.
-- Ubuntu 22.04's bundled 10.6) the engine silently promotes such a column to
-- either `NOT NULL DEFAULT '0000-00-00 00:00:00.000'` or — for the first
-- timestamp in its table — `NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE
-- CURRENT_TIMESTAMP(3)`. On MariaDB ≥10.10 / 12.x (default `=1`) and MySQL 8
-- the SAME migrations produce the intended nullable `DEFAULT NULL`. Same SQL,
-- two different schemas.
--
-- 0023 fixed the five `deleted_at` columns (and 0010 fixed `pages.deleted_at`)
-- because that's where the bug first surfaced (soft-delete filters returned
-- zero rows). But every OTHER nullable timestamp has the identical defect on
-- a `=0` server, and the app writes NULL to many of them at runtime:
--   * users.locked_until            ← cleared to NULL on unlock (lockout.ts)
--   * failed_logins_by_*.locked_until / reset_at
--   * users.last_login_at           ← NULL until first login
--   * pages/posts/projects.published_at ← NULL = draft; re-stamped on UPDATE
--   * leads.brochure_token_used_at / status_changed_at
--   * notification_failures / pending_emails / crm_dispatch_log retry+resolve
--   * ai_proposals.applied_at, security_login_path_pending.confirmed_at
-- On a `=0` server those columns are NOT NULL, so the app's NULL writes fail
-- (or get coerced to a zero-date / re-stamped), and the schema diverges from a
-- `=1` server.
--
-- THE FIX. Pin each to the intended shape explicitly. An explicit
-- `NULL DEFAULT NULL` is honoured regardless of `explicit_defaults_for_timestamp`
-- (verified on MariaDB 10.6 with `=0`), so this makes the schema deterministic
-- across every engine/version.
--
-- ALTER-ONLY, no data repair (deliberately, unlike 0023's deleted_at UPDATEs):
-- for these columns a non-NULL value is a MEANINGFUL state (a real publish
-- time, a real lock expiry, a genuine last-login), so blindly NULLing
-- `WHERE x IS NOT NULL` would corrupt live data. No existing install can hold
-- mis-stamped data here anyway: a `=0` install never booted past the schema
-- fingerprint check before this release, and a fresh install seeds its first
-- rows only AFTER this migration runs. On a `=1` install every ALTER is a
-- metadata-only no-op (the column is already nullable).
--
-- Idempotent: re-running converges (the ALTER is a no-op once applied).

ALTER TABLE `ai_proposals`
  MODIFY COLUMN `applied_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `crm_dispatch_log`
  MODIFY COLUMN `next_retry_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `failed_logins_by_email`
  MODIFY COLUMN `locked_until` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `failed_logins_by_email`
  MODIFY COLUMN `reset_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `failed_logins_by_ip`
  MODIFY COLUMN `locked_until` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `leads`
  MODIFY COLUMN `brochure_token_used_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `leads`
  MODIFY COLUMN `status_changed_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `notification_failures`
  MODIFY COLUMN `next_retry_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `notification_failures`
  MODIFY COLUMN `resolved_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `pages`
  MODIFY COLUMN `published_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `pending_emails`
  MODIFY COLUMN `claim_until` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `pending_emails`
  MODIFY COLUMN `resolved_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `posts`
  MODIFY COLUMN `published_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `projects`
  MODIFY COLUMN `published_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `security_login_path_pending`
  MODIFY COLUMN `confirmed_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `users`
  MODIFY COLUMN `last_login_at` TIMESTAMP(3) NULL DEFAULT NULL;
--> statement-breakpoint
ALTER TABLE `users`
  MODIFY COLUMN `locked_until` TIMESTAMP(3) NULL DEFAULT NULL;
