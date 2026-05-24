-- Migration 0021 — CRM dispatch log + notification_failures kind add
--
-- crm_dispatch_log
--   One row per attempted CRM dispatch from a public-form lead
--   submit. Local lead row writes FIRST in the submit handler; this
--   table only records the third-party hand-off outcome so a CRM
--   outage can never lose a lead.
--
--   Columns:
--     lead_id          FK to leads.id, ON DELETE CASCADE. NULLable
--                      because newsletter signups live in
--                      newsletter_subscribers (not leads); their
--                      dispatch rows carry lead_id=NULL.
--     source           Lead source label (contact|newsletter|brochure|
--                      inquiry). Stored explicitly so the retry
--                      worker can re-dispatch without joining to
--                      leads (and so newsletter rows have a source
--                      at all).
--     provider         'hubspot' | 'zoho' — VARCHAR for forward-
--                      compatibility with future providers; enum
--                      would force a migration each time.
--     destination_id   provider-specific destination key (HubSpot
--                      form GUID, Zoho 'webform:Module' /
--                      'oauth:Module' label).
--     payload_snapshot JSON of the FIELD-MAPPED payload at original
--                      dispatch time. Lets the retry worker replay
--                      the EXACT request body even if the operator
--                      changed the fieldMap between original + retry,
--                      and even when the lead row was edited
--                      post-dispatch (admin updated phone, etc.).
--                      Strips raw PII echo in success path — see
--                      lib/crm/hubspot.ts logDispatch.
--     status           'success' | 'http_error' | 'timeout' |
--                      'transport_error' | 'retry_scheduled' |
--                      'retry_in_flight' | 'retry_exhausted'
--     http_code        HTTP status from the provider, NULL on
--                      transport-level failures (DNS, TCP, TLS).
--     response_excerpt First ~480 chars of provider response body.
--                      Dispatch helpers strip echoed PII before
--                      insert.
--     attempt          1-indexed attempt counter. Retries get new
--                      rows (preserving the failure chain) so
--                      /admin/activity can surface "tried 3 times,
--                      gave up".
--     next_retry_at    when the retry worker should pick this up.
--                      NULL on terminal states (success, exhausted,
--                      in_flight).
--     attempted_at     row insert timestamp.
--
-- notification_failures kind value
--   We add `'crm_dispatch_failed'` to the Drizzle TS enum literal
--   set in db/schema/notifications.ts so server code can write the
--   value. The underlying SQL column is VARCHAR(32) — NOT a MariaDB
--   ENUM — so no ALTER TABLE is required to accept the new value
--   at the DB layer. Application validates via the Drizzle enum at
--   insert time.
--
-- IF NOT EXISTS guard keeps the migration idempotent against ledger
-- re-runs (production-grade — same pattern as 0012).

CREATE TABLE IF NOT EXISTS crm_dispatch_log (
  id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id          INT NULL,
  source           VARCHAR(16) NOT NULL,
  provider         VARCHAR(32) NOT NULL,
  destination_id   VARCHAR(120) NOT NULL,
  payload_snapshot JSON NOT NULL,
  status           VARCHAR(24) NOT NULL,
  http_code        SMALLINT NULL,
  response_excerpt VARCHAR(480) NULL,
  attempt          TINYINT UNSIGNED NOT NULL DEFAULT 1,
  next_retry_at    TIMESTAMP(3) NULL,
  attempted_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_crm_dispatch_log_lead
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  INDEX idx_crm_dispatch_log_retry (status, next_retry_at),
  INDEX idx_crm_dispatch_log_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- notification_failures.kind is already VARCHAR(32) — no SQL-level
-- change required to accept 'crm_dispatch_failed'. The Drizzle TS
-- enum literal (db/schema/notifications.ts) is the application-
-- layer source of truth.
