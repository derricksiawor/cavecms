-- Migration 0012 — security settings tables
--
-- Adds two support tables for the admin-UI Security settings panel.
-- The settings themselves live in the existing `settings` table (one
-- row per registry key); these tables back the lockout-safety
-- handshakes that can't be expressed as static settings JSON.
--
-- 1. security_recaptcha_verification — one row per admin user, the
--    latest "I just verified these reCAPTCHA keys actually work for
--    me right now" handshake. PATCH /api/admin/settings refuses to
--    set security_recaptcha.enabledOnLogin=true unless a non-expired
--    row exists for the saver AND the (siteKeyHash, secretKeyHash,
--    version) matches what's being saved. Hashes stored, NOT keys —
--    a leaked DB cell never surfaces the operator's secret.
--
-- 2. security_login_path_pending — singleton row tracking a change
--    in flight. When the operator saves a new login path, this row
--    captures previousPath + newPath + expiresAt (now + 10 min). The
--    operator must hit POST /api/admin/security/login-path-confirm
--    from the NEW path within the window or getResolvedLoginPath()
--    auto-reverts to previousPath on next read.
--
-- IF NOT EXISTS guards make the migration idempotent against re-runs
-- from the ledger.

CREATE TABLE IF NOT EXISTS security_recaptcha_verification (
  user_id INT NOT NULL PRIMARY KEY,
  -- session jti the verification was minted from; the PATCH guard
  -- requires it matches the saving session's jti so a stolen short-
  -- lived session can't reuse another session's verification.
  session_jti VARCHAR(36) NOT NULL,
  site_key_hash CHAR(64) NOT NULL,
  secret_key_hash CHAR(64) NOT NULL,
  version VARCHAR(8) NOT NULL,
  verified_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at TIMESTAMP(3) NOT NULL,
  CONSTRAINT fk_security_recaptcha_verification_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotent column add for already-applied earlier shape (dev
-- environments may have run the prior version of this migration).
SET @add_session_jti := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'security_recaptcha_verification'
        AND column_name = 'session_jti'
    ),
    'SELECT 1',
    'ALTER TABLE security_recaptcha_verification ADD COLUMN session_jti VARCHAR(36) NOT NULL DEFAULT '''' AFTER user_id'
  )
);
PREPARE stmt FROM @add_session_jti;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Purge any pre-migration rows whose session_jti was set to the
-- default '' by the ALTER above. Those rows would fail the strict
-- jti equality check in guardRecaptcha anyway (a valid ctx.jti is a
-- UUID, never empty), but deleting them prevents a future
-- contributor from naively loosening the check ("legacy rows have
-- empty jti, accept them") and silently re-opening the session-bound
-- guarantee.
DELETE FROM security_recaptcha_verification WHERE session_jti = '';

CREATE TABLE IF NOT EXISTS security_login_path_pending (
  id INT NOT NULL PRIMARY KEY DEFAULT 1,
  previous_path VARCHAR(32) NOT NULL,
  new_path VARCHAR(32) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  confirmed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- saver user id; the confirm endpoint requires the confirming
  -- session belongs to the same operator so a second admin can't
  -- confirm a change someone else initiated.
  created_by INT NULL,
  CONSTRAINT fk_security_login_path_pending_user
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @add_created_by := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'security_login_path_pending'
        AND column_name = 'created_by'
    ),
    'SELECT 1',
    'ALTER TABLE security_login_path_pending ADD COLUMN created_by INT NULL AFTER created_at'
  )
);
PREPARE stmt FROM @add_created_by;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
