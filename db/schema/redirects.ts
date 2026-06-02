import {
  mysqlTable,
  int,
  smallint,
  varchar,
  boolean,
  timestamp,
  datetime,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Operator-managed URL redirects (Settings → Redirects). Evaluated
// site-wide in the Edge middleware via a cached loopback feed. Distinct
// from `slug_redirects` (auto old→new on CMS page rename) — this table is
// general-purpose and operator-authored.
export const redirects = mysqlTable(
  'redirects',
  {
    id: int('id').primaryKey().autoincrement(),
    // Source pattern. Always begins with '/'. For wildcard, a trailing
    // '*' matches the remainder of the path. For regex, a JS regex body
    // (no slashes/flags) anchored at both ends by the compiler.
    source: varchar('source', { length: 512 }).notNull(),
    matchType: varchar('match_type', {
      length: 16,
      enum: ['exact', 'wildcard', 'regex'],
    }).notNull(),
    action: varchar('action', { length: 16, enum: ['redirect', 'gone'] })
      .notNull()
      .default('redirect'),
    // Destination path ('/x') or absolute URL. NULL when action='gone'.
    // For regex sources may contain $1..$9 capture references.
    target: varchar('target', { length: 2048 }),
    // 301/302/307/308 for action='redirect'; NULL for 'gone' (implicit 410).
    statusCode: smallint('status_code'),
    queryHandling: varchar('query_handling', {
      length: 16,
      enum: ['passthrough', 'ignore'],
    })
      .notNull()
      .default('passthrough'),
    caseInsensitive: boolean('case_insensitive').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    // Evaluation order for wildcard/regex rules (lower first). Exact rules
    // short-circuit via a Map regardless of position.
    position: int('position').notNull().default(0),
    hitCount: int('hit_count').notNull().default(0),
    // Nullable event timestamp → datetime, not timestamp (see apiTokens.ts):
    // MariaDB explicit_defaults_for_timestamp=0 promotes a nullable TIMESTAMP
    // to NOT NULL DEFAULT '0000-00-00…' (migrations 0023/0025). DATETIME
    // nullable always defaults NULL.
    lastHitAt: datetime('last_hit_at', { fsp: 3 }),
    notes: varchar('notes', { length: 255 }),
    createdBy: int('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .notNull()
      .defaultNow()
      .onUpdateNow(),
  },
  (t) => ({
    sourceTypeUniq: uniqueIndex('idx_redirects_source_type').on(
      t.source,
      t.matchType,
    ),
    enabledPosIdx: index('idx_redirects_enabled_pos').on(t.enabled, t.position),
  }),
)

// Aggregated 404 log — one row per path. Hits accumulate via
// INSERT … ON DUPLICATE KEY UPDATE. Bounded by an opportunistic prune.
export const notFoundLog = mysqlTable(
  'not_found_log',
  {
    id: int('id').primaryKey().autoincrement(),
    path: varchar('path', { length: 512 }).notNull(),
    hits: int('hits').notNull().default(1),
    lastSeenAt: timestamp('last_seen_at', { fsp: 3 })
      .notNull()
      .defaultNow()
      .onUpdateNow(),
    referrer: varchar('referrer', { length: 512 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    pathUniq: uniqueIndex('idx_not_found_path').on(t.path),
    lastSeenIdx: index('idx_not_found_last_seen').on(t.lastSeenAt),
  }),
)
