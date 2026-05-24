import { mysqlTable, int, varchar, boolean, timestamp, uniqueIndex } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  email: varchar('email', { length: 180 }).notNull(),
  passwordHash: varchar('password_hash', { length: 400 }).notNull(),
  role: varchar('role', { length: 16, enum: ['admin', 'editor', 'viewer'] }).notNull(),
  name: varchar('name', { length: 180 }),
  active: boolean('active').notNull().default(true),
  mustRotatePassword: boolean('must_rotate_password').notNull().default(false),
  tokensValidAfter: timestamp('tokens_valid_after', { fsp: 3 }).notNull().defaultNow(),
  passwordChangedAt: timestamp('password_changed_at', { fsp: 3 }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { fsp: 3 }),
  lockedUntil: timestamp('locked_until', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('idx_users_email').on(t.email),
}))
