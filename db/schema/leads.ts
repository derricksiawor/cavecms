import {
  mysqlTable,
  int,
  varchar,
  text,
  mediumtext,
  json,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'
import { projects } from './projects'
import { users } from './users'

// Inbound enquiries from public-form submissions (Plan 07 routes) +
// the gated brochure download flow (consumes brochure_token_used_at as
// the single-use marker — see app/api/brochure/[token]/route.ts).
//
// PII is masked at the API boundary for editor/viewer roles in Plan 08
// (`lib/leads/mask.ts`). The raw row stays unmodified for admin
// export + forensics; masking happens on the way out, never on store.
//
// project_id is nullable so contact + newsletter leads (which aren't
// bound to a specific project) can share this table — denormalizing
// to four tables would explode the admin inbox UX with zero data-
// integrity gain.
export const leads = mysqlTable(
  'leads',
  {
    id: int('id').primaryKey().autoincrement(),
    source: varchar('source', {
      length: 16,
      enum: ['contact', 'brochure', 'inquiry', 'form'],
    }).notNull(),
    name: varchar('name', { length: 180 }),
    email: varchar('email', { length: 180 }),
    phone: varchar('phone', { length: 40 }),
    message: text('message'),
    // Structured submission for lx_form (source='form'): the raw
    // [{label,value}] of every submitted field, so the admin lead drawer can
    // render a clean key:value list instead of only the flattened `message`.
    // NULL for legacy contact/brochure/inquiry/newsletter rows.
    payload: json('payload'),
    enquiryType: varchar('enquiry_type', {
      length: 20,
      enum: ['tour', 'brochure', 'enquiry'],
    }),
    tourDate: varchar('tour_date', { length: 10 }),
    tourTime: varchar('tour_time', { length: 5 }),
    brochureProject: varchar('brochure_project', { length: 100 }),
    projectId: int('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    status: varchar('status', {
      length: 16,
      enum: ['new', 'contacted', 'won', 'lost'],
    })
      .notNull()
      .default('new'),
    notes: text('notes'),
    // Single-use marker for the brochure download CAS. NULL means
    // "token unused"; the download route does an atomic UPDATE ...
    // WHERE brochure_token_used_at IS NULL and returns 410 if zero
    // rows affected — so a forwarded download link can never be
    // redeemed twice.
    brochureTokenUsedAt: timestamp('brochure_token_used_at', { fsp: 3 }),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    statusChangedAt: timestamp('status_changed_at', { fsp: 3 }),
    statusChangedBy: int('status_changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Soft-delete marker for the admin Trash flow. A row with a
    // non-NULL deleted_at is hidden from the inbox + masked-public
    // list views and surfaces under /admin/leads?trashed=1 with a
    // Restore button. A future nightly cron will hard-purge rows
    // older than 30 days, mirroring the posts + content_blocks
    // retention model. Before this column existed, DELETE was a
    // hard wipe — a miss-click on bulk-delete was unrecoverable.
    deletedAt: timestamp('deleted_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    // Admin inbox: filter by status, sort by created_at. The (status,
    // created_at) composite serves both the count badge and the list
    // view without scanning.
    statusCreated: index('idx_leads_status_created').on(t.status, t.createdAt),
    sourceIdx: index('idx_leads_source').on(t.source),
    // Composite (created_at, id) for the unfiltered cursor walk on
    // /admin/leads — a 1000-row keyset paginate uses
    // `ORDER BY created_at DESC, id DESC` and the (created_at, id)
    // composite keeps it index-only across all pages. Replaces the
    // single-column idx_leads_created which forced a filesort on the
    // secondary id tiebreak under heavy data.
    createdIdIdx: index('idx_leads_created_id').on(t.createdAt, t.id),
    // Tri-dimensional cursor for /admin/leads pagination — Plan 08 uses
    // (source, status, created_at, id) as a keyset cursor so a follow-up
    // page hits the index without re-scanning prior rows.
    sourceStatusCreated: index('idx_leads_source_status_created').on(
      t.source,
      t.status,
      t.createdAt,
      t.id,
    ),
    // Trash view + recovery-window cron — both filter on a non-NULL
    // deleted_at and sort by it; a single-column index keeps both
    // queries off a full table scan.
    deletedIdx: index('idx_leads_deleted').on(t.deletedAt),
  }),
)

// Newsletter list. status discriminates double-opt-in: subscription
// starts at `pending_confirmation`, flips to `active` on confirm-token
// click, flips to `unsubscribed` on unsub. Re-subscribing an
// `unsubscribed` row keeps it `unsubscribed` until the user confirms
// again — auto-reactivation is an anti-pattern (someone else can
// re-subscribe a victim's email).
export const newsletterSubscribers = mysqlTable(
  'newsletter_subscribers',
  {
    id: int('id').primaryKey().autoincrement(),
    email: varchar('email', { length: 180 }).notNull(),
    status: varchar('status', {
      length: 24,
      enum: ['active', 'unsubscribed', 'pending_confirmation'],
    })
      .notNull()
      .default('pending_confirmation'),
    // Used for BOTH the double-opt-in confirm link AND the unsubscribe
    // link. Rotated on every status change so a forwarded confirmation
    // can't be replayed after the user clicked unsubscribe.
    unsubscribeToken: varchar('unsubscribe_token', { length: 64 }).notNull(),
    source: varchar('source', { length: 40 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    emailUniq: uniqueIndex('idx_newsletter_email').on(t.email),
  }),
)

// Persist-on-enqueue email queue. enqueueEmail (Plan 07 Task 5) INSERTs
// a row inside the lead-intake TX; the queue runner sweeps due rows,
// claims them with a short claim_until lock, and retries on failure
// per BACKOFFS_SEC (30s, 5m, 1h). The (resolved_at, next_retry_at)
// index keys the "due-rows" lookup cheaply.
export const pendingEmails = mysqlTable(
  'pending_emails',
  {
    id: int('id').primaryKey().autoincrement(),
    toEmail: varchar('to_email', { length: 180 }).notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    htmlBody: mediumtext('html_body').notNull(),
    textBody: mediumtext('text_body').notNull(),
    attempts: int('attempts').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { fsp: 3 }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { fsp: 3 }),
    lastError: text('last_error'),
    // Concurrency lease. claim() sets this to NOW + 60s before a worker
    // takes a row; another worker treats a row with claim_until in the
    // future as already-being-processed. Stale leases expire naturally
    // when the clock advances past claim_until.
    claimUntil: timestamp('claim_until', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('idx_pending_emails_due').on(t.resolvedAt, t.nextRetryAt),
  }),
)
