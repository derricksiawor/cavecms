import { mysqlTable, int, varchar, boolean, timestamp, primaryKey, index } from 'drizzle-orm/mysql-core'
import { users } from './users'

export const failedLoginsByEmail = mysqlTable('failed_logins_by_email', {
  email: varchar('email', { length: 180 }).primaryKey(),
  count: int('count').notNull().default(0),
  lastFailureAt: timestamp('last_failure_at', { fsp: 3 }).notNull().defaultNow(),
  lockedUntil: timestamp('locked_until', { fsp: 3 }),
  // Set when the legitimate user successfully authenticates. computeLockState
  // counts only failures with created_at > reset_at so a victim cannot be
  // re-locked by a single follow-up bad password from the residual ledger.
  resetAt: timestamp('reset_at', { fsp: 3 }),
})

export const failedLoginsByIp = mysqlTable('failed_logins_by_ip', {
  ip: varchar('ip', { length: 45 }).primaryKey(),
  count: int('count').notNull().default(0),
  lastFailureAt: timestamp('last_failure_at', { fsp: 3 }).notNull().defaultNow(),
  lockedUntil: timestamp('locked_until', { fsp: 3 }),
})

export const loginAttempts = mysqlTable('login_attempts', {
  id: int('id').primaryKey().autoincrement(),
  email: varchar('email', { length: 180 }),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 255 }),
  success: boolean('success').notNull(),
  failureReason: varchar('failure_reason', { length: 60 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: index('idx_attempts_email_created').on(t.success, t.email, t.createdAt),
  ipIdx: index('idx_attempts_ip_created').on(t.success, t.ip, t.createdAt),
  createdIdx: index('idx_attempts_created').on(t.createdAt),
}))

export const userKnownIps = mysqlTable('user_known_ips', {
  userId: int('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: varchar('ip', { length: 45 }).notNull(),
  lastSuccessAt: timestamp('last_success_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.ip] }) }))
