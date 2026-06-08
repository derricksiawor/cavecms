import 'server-only'

// Single source of truth for CRM dispatch enums + tunable constants.
// Imported by lib/crm/{hubspot,zoho,dispatch}.ts, scripts/cron-crm-
// retry.ts, lib/cms/{settings-registry,block-registry}.ts (via z.enum
// over these consts). Migration 0021's status VARCHAR(24) is the
// underlying source of truth for stored values; this file is the
// in-code mirror.

// ─────────────────────── Dispatch outcomes ───────────────────────
// `success` — provider accepted (200/302).
// `http_error` — provider returned 4xx/5xx.
// `timeout` — AbortSignal.timeout fired before headers/body
//             arrived. Treated as TERMINAL by the retry scheduler
//             (see RETRY_TERMINAL_OUTCOMES) — re-issuing the same
//             request after timeout risks double-submission when
//             the provider had already accepted the row but the
//             response was slow.
// `transport_error` — DNS / TCP / TLS failure or any thrown error
//             that wasn't a timeout. Retried.
// `pending` — synchronously inserted BEFORE the outbound HTTP call
//             so a worker recycle / SIGTERM mid-dispatch leaves a
//             recoverable row for the retry worker.
// `retry_scheduled` — non-success outcome with retries remaining;
//             the retry worker re-issues at `next_retry_at`.
// `retry_in_flight` — claimed by the retry worker. Should never be
//             a terminal state — the worker either advances it to
//             `retry_consumed` (next attempt logged in a new row)
//             or it gets reaped back to `retry_scheduled` by the
//             stale-in-flight sweep when older than
//             RETRY_REAP_THRESHOLD_MS.
// `retry_exhausted` — non-success outcome with no retries left.
//             Insertion also writes a `notification_failures` row.
// `retry_consumed` — the worker successfully advanced this row to
//             a new attempt; this row is purely historical and
//             never re-picked.
export const CRM_DISPATCH_STATUSES = [
  'success',
  'http_error',
  'timeout',
  'transport_error',
  'pending',
  'retry_scheduled',
  'retry_in_flight',
  'retry_exhausted',
  'retry_consumed',
] as const
export type CrmDispatchStatus = (typeof CRM_DISPATCH_STATUSES)[number]

// `success` and `timeout` are terminal — they don't schedule another
// retry. `timeout` is terminal because the original request MAY have
// succeeded server-side after the client gave up; re-issuing risks
// duplicate leads in the CRM and HubSpot Forms API has no native
// idempotency key. Documented trade-off: at-most-once delivery on
// timeout. http_error / transport_error are retried.
export const RETRY_TERMINAL_OUTCOMES: ReadonlySet<CrmDispatchStatus> = new Set([
  'success',
  'timeout',
])

// ─────────────────────── Retry / timing budget ───────────────────────
// Bumped attempt N gets schedule[N-1] ms of delay. Length = max
// attempts after the first (4 retries → 5 total tries). Bucketing is
// coarse on purpose so the systemd timer's 1min poll doesn't dominate
// the wait time.
export const RETRY_DELAYS_MS: readonly number[] = [
  5 * 60_000,      // 5 min
  30 * 60_000,     // 30 min
  4 * 3600_000,    // 4 h
  24 * 3600_000,   // 24 h
]

// Per-outbound-call hard ceiling. Applied via AbortSignal.timeout +
// an explicit AbortController for body-reading so a slow .text()
// can't outrun the connect/headers timeout. 5s comfortable on global
// latencies to HubSpot/Zoho; tighter than the systemd unit's
// TimeoutStartSec=5min so the worker can't be wedged by one provider.
export const OUTBOUND_TIMEOUT_MS = 5000

// Bounded retry worker batch. Math: with up to 5 concurrent dispatch
// fan-outs at 5s each, 10 rows / tick takes <= ~10s wall clock. The
// 1-min systemd cadence + RandomizedDelaySec=15s comfortably handles
// even backlogged-by-an-hour queues without overrunning the
// TimeoutStartSec=5min ceiling.
export const RETRY_BATCH_LIMIT = 10
export const RETRY_DISPATCH_CONCURRENCY = 5

// Stale-pending / stale-in-flight reaper threshold. 10 minutes
// matches the systemd service's TimeoutStartSec=5min × 2 — a worker
// that was killed mid-dispatch leaves rows older than this back in
// the retry queue.
export const RETRY_REAP_THRESHOLD_MS = 10 * 60_000

// ─────────────────────── Lead source + module enums ───────────────────────
// Lead source labels match the lead routes (`/api/leads/{source}`).
// Newsletter rows live in newsletter_subscribers (not leads), so a
// newsletter dispatch row has `lead_id IS NULL` + `source='newsletter'`.
export const LEAD_SOURCES = ['contact', 'newsletter', 'brochure', 'inquiry', 'form'] as const
export type LeadSource = (typeof LEAD_SOURCES)[number]

// Zoho CRM modules we target. Extending: add to the literal here AND
// to the zoho.ts moduleActionType map AND to the admin modules route.
export const ZOHO_MODULES = ['Leads', 'Contacts', 'Deals'] as const
export type ZohoModule = (typeof ZOHO_MODULES)[number]

// ─────────────────────── Block destination cap ───────────────────────
// Cap on per-block crmDestinations to bound fan-out per submit.
export const MAX_CRM_DESTINATIONS_PER_BLOCK = 4
