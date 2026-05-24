import { mysqlTable, int, varchar, timestamp } from 'drizzle-orm/mysql-core'
import { users } from './users'

// One row per admin user — the latest successful "verify-these-keys"
// handshake from /api/admin/security/verify-recaptcha. Stored as
// SHA-256 hashes (NOT the raw keys) so a leaked DB cell doesn't
// surface the operator's reCAPTCHA secret. The PATCH guard for
// security_recaptcha refuses to enable `enabledOnLogin=true` unless
// a non-expired row for the saver exists AND its (siteKeyHash,
// secretKeyHash, version) matches the to-be-saved values exactly —
// changing either key invalidates the verification.
//
// 5-minute expiry per CLAUDE.md "fresh reauth" pattern (matches
// requireFreshReauth's window). Older rows are inert; a nightly
// purge or row-level expiry check keeps the table tiny (one row per
// admin at most).
export const securityRecaptchaVerification = mysqlTable(
  'security_recaptcha_verification',
  {
    userId: int('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Session jti the verification was minted from. The PATCH guard
    // requires this matches the saving session's jti — a stolen
    // session within the 5-min window can't reuse another session's
    // verification.
    sessionJti: varchar('session_jti', { length: 36 }).notNull(),
    siteKeyHash: varchar('site_key_hash', { length: 64 }).notNull(),
    secretKeyHash: varchar('secret_key_hash', { length: 64 }).notNull(),
    version: varchar('version', { length: 8 }).notNull(),
    verifiedAt: timestamp('verified_at', { fsp: 3 }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
  },
)

// Singleton table — id is fixed at 1, enforced by the unique PK +
// the only writer (PATCH security_login_path) doing an INSERT … ON
// DUPLICATE KEY UPDATE keyed on id=1. Records a "login path change in
// flight" so getResolvedLoginPath() can auto-revert if the operator
// never confirms the new path loads. Auto-revert window is 10 min;
// once confirmedAt is set the row is dormant (the new path is now
// the live value, no revert needed).
//
// Why a separate row rather than embedding in security_login_path
// JSON: the pending-revert logic needs deterministic atomic clears
// (UPDATE ... WHERE id=1) that don't race with JSON re-serialization
// in the settings PATCH path. Keeping the singleton dedicated also
// gives a cleaner read path for getResolvedLoginPath (one PK lookup,
// no JSON parse).
export const securityLoginPathPending = mysqlTable(
  'security_login_path_pending',
  {
    id: int('id').primaryKey().default(1),
    previousPath: varchar('previous_path', { length: 32 }).notNull(),
    newPath: varchar('new_path', { length: 32 }).notNull(),
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
    confirmedAt: timestamp('confirmed_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    // Saver user — the confirm endpoint requires the confirming
    // session belongs to the same operator so a second admin / hijacked
    // session can't confirm a change the first operator initiated.
    createdBy: int('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
)
