import {
  mysqlTable,
  bigint,
  int,
  varchar,
  json,
  timestamp,
  index,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Append-only audit trail. Every mutation through the CMS writes one row
// inside the same TX as the mutation itself — there is no "write succeeded
// but audit failed" state. resource_id is varchar so non-int identifiers
// (slugs, uuids) also fit. diff stores microdiff output, capped at 64KB
// by saveBlock (truncation marker preserves op count/kind summary).
export const auditLog = mysqlTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    userId: int('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 40 }).notNull(),
    resourceType: varchar('resource_type', { length: 40 }).notNull(),
    resourceId: varchar('resource_id', { length: 60 }),
    diff: json('diff'),
    ip: varchar('ip', { length: 45 }),
    // Forensic completeness: tie the action to the client that did it
    // (user-agent) and the request that traced it (withError requestId).
    // Both nullable — older rows pre-Plan-02-round-1 carry NULL.
    userAgent: varchar('user_agent', { length: 255 }),
    requestId: varchar('request_id', { length: 36 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('idx_audit_created').on(t.createdAt),
    userIdx: index('idx_audit_user_created').on(t.userId, t.createdAt),
    resourceIdx: index('idx_audit_resource').on(
      t.resourceType,
      t.resourceId,
      t.createdAt,
    ),
    actionIdx: index('idx_audit_action').on(t.action, t.createdAt),
    // Activity-feed filter: `WHERE resource_type=? AND action=? ORDER BY
    // created_at DESC`. The existing idx_audit_resource leads with
    // resource_id which makes it useless for resource_type-only filters;
    // idx_audit_action drops resource_type entirely. The composite below
    // serves the resource_type + action filter pair without a filesort.
    resourceActionIdx: index('idx_audit_resource_action_created').on(
      t.resourceType,
      t.action,
      t.createdAt,
    ),
  }),
)
