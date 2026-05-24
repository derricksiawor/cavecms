import {
  mysqlTable,
  int,
  varchar,
  text,
  json,
  timestamp,
  index,
} from 'drizzle-orm/mysql-core'

// Queue + ledger for any out-of-band notification that must survive a
// process restart. safeRevalidate enqueues here when revalidateTag throws;
// SMTP send failures (Plan 07) and reCAPTCHA degraded fail-open events also
// land here. The (kind, resolved_at, next_retry_at) index lets the background
// sweeper find "due" rows in one indexed lookup.
export const notificationFailures = mysqlTable(
  'notification_failures',
  {
    id: int('id').primaryKey().autoincrement(),
    kind: varchar('kind', {
      length: 32,
      enum: [
        // Set by lib/email/queue.ts markFailed when a row exhausts
        // its retries (attempts >= MAX_ATTEMPTS). Forensic only —
        // operator manually replays via UPDATE pending_emails.
        'smtp_send',
        // Set by lib/email/queue.ts when 5 consecutive sends fail
        // and the circuit breaker opens. Forensic only.
        'smtp_breaker_open',
        // Set by lib/leads/logEnqueueFailure when a lead route's
        // enqueueEmail call rejects (DB blip mid-INSERT). The lead
        // row is already committed; this row points an operator at
        // the source + email_sha256 for manual replay.
        'lead_email_enqueue_failed',
        'recaptcha_degraded',
        // revalidate_pending: enqueued INSIDE save TX, attempts=0, drained
        // post-commit. revalidate_failed: post-throw from safeRevalidate
        // path OR drain failure with attempts>0. Sweeper applies different
        // policies (pending = aggressive, failed = backoff + escalate).
        'revalidate_pending',
        'revalidate_failed',
        'unhandled_rejection',
        'rbac_field_reject',
        'hydrate_block_parse_failed',
        'hydrate_project_section_parse_failed',
        // Set by lib/crm/hubspot.ts logDispatch when a CRM dispatch
        // exhausts its retry budget (4 attempts, 5min→30min→4h→24h
        // backoff). Forensic counterpart lives in crm_dispatch_log;
        // this row is the operator-facing alert.
        'crm_dispatch_failed',
      ],
    }).notNull(),
    refTable: varchar('ref_table', { length: 40 }),
    refId: int('ref_id'),
    payload: json('payload'),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { fsp: 3 }),
    resolvedAt: timestamp('resolved_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('idx_notif_kind_pending').on(
      t.kind,
      t.resolvedAt,
      t.nextRetryAt,
    ),
  }),
)

// Single-row table (id always 1). The deployed schema's SHA-256 fingerprint,
// updated by scripts/update-fingerprint.ts at migrate-time. Boot-time check
// in instrumentation.ts crashes the process when this row's value doesn't
// match the baked-in baseline — catches "new code, old schema" deploys.
export const schemaFingerprint = mysqlTable('schema_fingerprint', {
  id: int('id').primaryKey(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  appliedAt: timestamp('applied_at', { fsp: 3 }).notNull().defaultNow(),
})
