import {
  mysqlTable,
  int,
  varchar,
  timestamp,
  datetime,
  json,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Programmatic API credentials. An admin mints a token in
// Settings → API Tokens; an external client (AI assistant, script,
// CI) sends `Authorization: Bearer cave_…` to /api/cms/* (and the
// content-level /api/admin/settings) and edits at API speed — no
// session cookie, no CSRF, no login-page nonce.
//
// SECURITY POSTURE
//  - The plaintext token is shown ONCE at creation and stored only as a
//    SHA-256 hash (token is a 256-bit secret, so a fast hash is safe —
//    no slow KDF needed, and no plaintext ever lands in the DB or logs).
//  - `role` is one of viewer|editor|admin (never above admin). A `viewer`
//    token is read-only (route role gates exclude it from every mutation).
//    Even an admin-role token cannot reach user-management or
//    security/secret settings: those routes require step-up reauth,
//    which a token can never satisfy (lib/auth/reauth.ts), and middleware
//    only forwards bearer requests to /api/cms/* + /api/admin/settings.
//  - `scopes` (NULL = unrestricted within role) narrows a token to specific
//    resource:action grants — see lib/auth/apiTokenScope.ts.
//  - `created_by` ON DELETE CASCADE: removing the minting admin revokes
//    every token they issued — no credential outlives its owner. Content
//    writes attribute `updated_by` to this user.
export const apiTokens = mysqlTable(
  'api_tokens',
  {
    id: int('id').primaryKey().autoincrement(),
    name: varchar('name', { length: 120 }).notNull(),
    // SHA-256 hex of the full token string. 64 hex chars.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    // First chars of the token for display ("cave_AbC3dEf"). Not secret.
    tokenPrefix: varchar('token_prefix', { length: 16 }).notNull(),
    role: varchar('role', {
      length: 16,
      enum: ['admin', 'editor', 'viewer'],
    }).notNull(),
    createdBy: int('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    // The nullable event timestamps are DATETIME, not TIMESTAMP, for two
    // reasons: (1) on MariaDB with explicit_defaults_for_timestamp=0
    // (Ubuntu 22.04's bundled 10.6 — a documented prod engine) a bare
    // nullable TIMESTAMP is silently promoted to NOT NULL DEFAULT
    // '0000-00-00…', which would make every minted token read as revoked
    // (see migrations 0023/0025); DATETIME nullable always defaults NULL.
    // (2) DATETIME has no Y2038 ceiling, so a 10-year expiry minted near
    // 2038 doesn't overflow. The migration writes `NULL DEFAULT NULL`
    // explicitly for belt-and-braces.
    // Throttled write (≤1×/60s per token) on each authenticated request.
    lastUsedAt: datetime('last_used_at', { fsp: 3 }),
    // Optional hard expiry. NULL = never expires (revoke to disable).
    expiresAt: datetime('expires_at', { fsp: 3 }),
    // Soft revoke — keeps the row (name + prefix + audit trail) visible
    // in the management UI after the token is disabled.
    revokedAt: datetime('revoked_at', { fsp: 3 }),
    // NULL = unrestricted within role (back-compat default). Otherwise a
    // JSON array of "<resource>:<action>" grants — see lib/auth/apiTokenScope.ts.
    scopes: json('scopes').$type<string[] | null>(),
  },
  (t) => ({
    hashIdx: uniqueIndex('idx_api_tokens_hash').on(t.tokenHash),
    createdByIdx: index('idx_api_tokens_created_by').on(t.createdBy),
  }),
)
