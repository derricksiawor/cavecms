import {
  mysqlTable,
  varchar,
  json,
  int,
  timestamp,
  index,
} from 'drizzle-orm/mysql-core'
import { users } from './users'

// Staging area for a content push. POST /api/cms/sync/stage validates an
// uploaded bundle, uploads its media into the LIVE media set (additive), and
// persists the resulting insert-ready, media-resolved payload here keyed by a
// random stageId. POST /api/cms/sync/cutover later reads it and runs the
// atomic applyBundle transaction. Rows expire after 1h; a sweep deletes
// expired rows (and best-effort GCs media inserted by abandoned stages).
//
// `payload` holds a StagedPayload (lib/sync/applyBundle.ts) — NOT secrets, NOT
// raw bundle bytes. `content_hash` is the bundle's content hash (echoed back to
// the CLI so it can confirm what it staged).
export const syncStage = mysqlTable(
  'sync_stage',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    payload: json('payload').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    // The bundle's pull-time drift baseline, recorded here so the cutover reads
    // it from the immutable staged record (not a per-request body field).
    baselineContentHash: varchar('baseline_content_hash', { length: 64 }),
    createdBy: int('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('idx_sync_stage_expires').on(t.expiresAt),
  }),
)
