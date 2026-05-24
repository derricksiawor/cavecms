import { mysqlTable, varchar, json, int, timestamp } from 'drizzle-orm/mysql-core'
import { users } from './users'

// Global, single-row-per-key store for content that isn't an editable
// "page block" but still needs in-app editing:
//   - contact_info     phone + email + address + hours
//   - social_links     [{platform, url}]
//   - default_seo      site-wide fallback title / description / OG
//   - footer           tagline + footer link columns
//   - organization_json_ld   site-wide Organization schema markup
//
// Shape validation lives in lib/cms/settings-registry.ts (Zod per
// key). Cache is keyed by `settings` tag via getSetting()'s
// unstable_cache wrapper; Admin /admin/settings PATCH (Plan 08)
// revalidates that tag.
//
// version is for optimistic-lock under the eventual admin PATCH;
// updated_by is the audit thread.
export const settings = mysqlTable('settings', {
  // The primary key is the setting key itself (e.g. 'contact_info'),
  // not an autoincrement id — one row per key, lookups are O(1).
  key: varchar('key', { length: 60 }).primaryKey(),
  value: json('value').notNull(),
  version: int('version').notNull().default(0),
  updatedBy: int('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { fsp: 3 })
    .notNull()
    .defaultNow()
    .onUpdateNow(),
})
