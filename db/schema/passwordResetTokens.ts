import { mysqlTable, int, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/mysql-core'
import { users } from './users'

// Admin-issued, single-use password-reset tokens.
//
// An admin generates a reset link for a locked-out user from the
// Users page. We store ONLY the SHA-256 hash of the raw token —
// a leaked DB cell never yields a usable link. The raw token lives
// solely in the URL the admin copies / the email the user receives.
//
// Single-use is enforced by `consumed_at`: the consume endpoint sets
// it inside the same UPDATE that changes the password, so a replayed
// link finds a consumed (or expired) row and fails closed. Expiry is
// 60 minutes (set at issue time). A fresh issue for the same user
// deletes that user's prior unconsumed rows so only one link is live.
export const passwordResetTokens = mysqlTable(
  'password_reset_tokens',
  {
    id: int('id').primaryKey().autoincrement(),
    userId: int('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 hex of the raw token (64 chars).
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
    consumedAt: timestamp('consumed_at', { fsp: 3 }),
    // The admin who issued the link (forensic trail; survives the
    // admin's deletion as NULL).
    createdBy: int('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('idx_prt_token_hash').on(t.tokenHash),
    userIdx: index('idx_prt_user').on(t.userId),
  }),
)
