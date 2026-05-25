import {
  mysqlTable,
  bigint,
  int,
  varchar,
  json,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'
import { users } from './users'
import { pages } from './content'

// AI proposal ledger. Each row carries a validated, sanitized changeset
// that Gemini has proposed for a specific (user × page × surface) tuple.
// The row stays `pending` until the operator clicks Apply (→ accepted)
// or Dismiss (→ dismissed), and is reaped by the sweeper after
// `expires_at` if neither happens.
//
// The schema is intentionally narrow — the changeset itself rides the
// SAME write path the manual editor uses (parseAndSanitize → saveBlock
// → audit) on Apply, so there is no need to track per-change DB state
// here. The proposal table is essentially a "shopping cart": the
// canonical truth on apply is `content_blocks`.
//
// FK behaviour:
//   - users.id ON DELETE SET NULL — preserve the audit trail when a
//     user is deactivated; the proposal still describes what was asked
//     for, just not by whom.
//   - pages.id ON DELETE CASCADE — a proposal targeting a deleted page
//     can never apply. Drop the row.
export const aiProposals = mysqlTable(
  'ai_proposals',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    // URL-safe random token (issued at /api/ai/propose, surfaced to
    // the client, presented again at /apply or /dismiss). 64 chars
    // accommodates 256-bit randomness + base64url padding.
    token: varchar('token', { length: 64 }).notNull(),
    userId: int('user_id').references(() => users.id, { onDelete: 'set null' }),
    pageId: int('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    // Which AI surface produced the proposal. `inline` = per-block
    // sparkle (single block targeted); `chat` = Page Assistant
    // (potentially multi-block changesets within the page).
    surface: varchar('surface', { length: 20, enum: ['inline', 'chat'] }).notNull(),
    // Original operator prompt — preserved verbatim for forensic
    // audit. Capped at 2000 chars; UI enforces a tighter bound.
    prompt: varchar('prompt', { length: 2000 }).notNull(),
    // The validated, sanitized array of ops:
    //   [{ op: 'edit'|'insert'|'delete'|'reorder', blockId?, parentId?,
    //      position?, blockType?, data?, meta? }, ...]
    // Already passed parseAndSanitize at propose-time; runs again at
    // apply-time defense-in-depth.
    changeset: json('changeset').notNull(),
    status: varchar('status', {
      length: 20,
      enum: ['pending', 'accepted', 'dismissed', 'expired'],
    })
      .notNull()
      .default('pending'),
    // Model name + token-usage telemetry. Stored for cost tracking +
    // future "AI usage this month" dashboard widget. JSON shape:
    //   { promptTokens: number, outputTokens: number, latencyMs: number }
    //
    // Column name is `tokens_usage` (not `usage`) because `USAGE` is a
    // reserved word in MySQL (used by GRANT USAGE syntax). Raw SQL
    // queries against `usage` would parse on MariaDB but fail at the
    // earliest unfriendly parser version. Avoid the footgun entirely.
    model: varchar('model', { length: 60 }).notNull(),
    tokensUsage: json('tokens_usage'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    // Pending proposals expire 30 min after creation (set at INSERT
    // time by the propose route). The sweeper in instrumentation.ts
    // flips `pending` rows to `expired` once past this timestamp so
    // they can't be applied to a stale page state.
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
    // Set when the proposal transitions to `accepted`. Null otherwise.
    appliedAt: timestamp('applied_at', { fsp: 3 }),
  },
  (t) => ({
    // Token lookup on apply/dismiss — must be unique + indexed so a
    // collision (effectively impossible with 256-bit entropy) is
    // refused at the DB layer, not the application.
    tokenIdx: uniqueIndex('uniq_ai_proposals_token').on(t.token),
    // User dashboard: "my recent AI proposals" lists.
    userStatusCreatedIdx: index('idx_ai_proposals_user_status_created').on(
      t.userId,
      t.status,
      t.createdAt,
    ),
    // Page-scoped lookup: "are there pending proposals for this page?"
    // used by the inline-edit chrome to surface in-flight previews.
    pageStatusIdx: index('idx_ai_proposals_page_status').on(t.pageId, t.status),
    // Sweeper scan: `WHERE status='pending' AND expires_at < NOW()`.
    expiresIdx: index('idx_ai_proposals_expires').on(t.expiresAt),
  }),
)
