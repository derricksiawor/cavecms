import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getRawSetting } from '@/lib/integrations/getRawSetting'
import {
  CRM_DISPATCH_STATUSES,
  RETRY_TERMINAL_OUTCOMES,
  RETRY_DELAYS_MS,
  OUTBOUND_TIMEOUT_MS,
  type LeadSource,
  type CrmDispatchStatus,
} from './types'

export type { LeadSource } from './types'

// HubSpot dispatch helpers. Server-only — uses the Private App
// access token stored on the integrations_hubspot setting. Every
// call has a 5s timeout via AbortController so a slow HubSpot can
// never hold up a user-facing form-submit response. Failures land
// in crm_dispatch_log with a structured status the retry worker
// picks up.
//
// Hard rule: callers ALWAYS write the local `leads` row FIRST,
// THEN call into this module. CRM failures never block the user.

const HUBSPOT_API = 'https://api.hubapi.com'
const HUBSPOT_FORMS_API = 'https://api.hsforms.com'

export interface HubspotCreds {
  portalId: string
  privateAppAccessToken: string
}

// Wraps fetch with strict timeout coverage that includes the body
// read. AbortSignal.timeout(N) covers connect + TLS + headers, but
// `r.text()` reads the body on a separate stream that does NOT
// inherit the upstream signal — a slow body would otherwise outrun
// the budget. Solution: drive both connect and body off the same
// AbortController, with `clearTimeout` in finally to release the
// timer reference.
//
// Returns { ok, status, bodyText } so the caller decides what's a
// hard failure vs a retryable transient. Never throws — coerces
// network errors to { ok: false, status: 0 } so the dispatch path
// stays linear.
async function hubspotFetch(
  creds: HubspotCreds,
  path: string,
  init?: { method?: string; body?: string; contentType?: string },
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(`${HUBSPOT_API}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${creds.privateAppAccessToken}`,
        'content-type': init?.contentType ?? 'application/json',
        accept: 'application/json',
      },
      body: init?.body,
      cache: 'no-store',
      signal: controller.signal,
    })
    const bodyText = await r.text()
    return { ok: r.ok, status: r.status, bodyText: bodyText.slice(0, 480) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, bodyText: msg.slice(0, 480) }
  } finally {
    clearTimeout(timer)
  }
}

// Pings /crm/v3/properties/contacts (lightweight, requires the
// crm.objects.contacts.read scope that every Forms-enabled Private
// App has). 200 → ok. 401/403 → message tailored to scope.
//
// Network-level errors are collapsed to a fixed message — we don't
// forward the raw err.message because it might surface internal
// trace IDs / hostnames from HubSpot's edge. HTTP-status errors get
// a status-coded label.
export async function testHubspotConnection(creds: HubspotCreds): Promise<{ ok: boolean; message: string }> {
  const r = await hubspotFetch(creds, '/crm/v3/properties/contacts?limit=1')
  if (r.ok) return { ok: true, message: 'Connected.' }
  if (r.status === 401) return { ok: false, message: 'Token rejected (401). Check it was copied correctly.' }
  if (r.status === 403) return { ok: false, message: 'Token works but is missing scopes (need crm.objects.contacts.write + forms).' }
  if (r.status === 0) return { ok: false, message: "Couldn't reach HubSpot." }
  return { ok: false, message: `HubSpot returned ${r.status}.` }
}

interface HubspotFormSummary { id: string; name: string }

export async function listHubspotForms(creds: HubspotCreds): Promise<{ ok: boolean; forms: HubspotFormSummary[]; message?: string }> {
  const r = await hubspotFetch(creds, '/marketing/v3/forms?limit=100')
  if (!r.ok) return { ok: false, forms: [], message: `HubSpot returned ${r.status}.` }
  try {
    const j = JSON.parse(r.bodyText) as { results?: Array<{ id: string; name: string }> }
    return { ok: true, forms: (j.results ?? []).map((f) => ({ id: f.id, name: f.name })) }
  } catch {
    return { ok: false, forms: [], message: 'Malformed response from HubSpot.' }
  }
}

interface HubspotFormField { name: string; label: string; fieldType: string }

export async function getHubspotFormFields(creds: HubspotCreds, formId: string): Promise<{ ok: boolean; fields: HubspotFormField[]; message?: string }> {
  const r = await hubspotFetch(creds, `/marketing/v3/forms/${encodeURIComponent(formId)}`)
  if (!r.ok) return { ok: false, fields: [], message: `HubSpot returned ${r.status}.` }
  try {
    const j = JSON.parse(r.bodyText) as {
      fieldGroups?: Array<{ fields?: Array<{ name: string; label: string; fieldType: string }> }>
    }
    const fields: HubspotFormField[] = []
    for (const g of j.fieldGroups ?? []) for (const f of g.fields ?? []) fields.push(f)
    return { ok: true, fields }
  } catch {
    return { ok: false, fields: [], message: 'Malformed response from HubSpot.' }
  }
}

// Form-submit dispatch. Posts to api.hsforms.com per HubSpot Forms
// v3 spec. `hutk` (visitor attribution cookie) comes from the
// incoming public request, NOT the operator's session.
export interface HubspotSubmitArgs {
  leadId: number
  source: LeadSource
  portalId: string
  formId: string
  /** Already-mapped fields: { hubspotPropertyName: value } */
  fields: Record<string, string>
  hutk?: string
  pageUri?: string
  pageName?: string
  ipAddress?: string
  attempt?: number
  /** When non-null, the per-attempt logDispatch UPDATEs this existing
   *  pending row instead of inserting a new attempt row. Set by
   *  dispatchLeadToCrms which pre-inserts pending rows synchronously
   *  so a worker recycle never loses the dispatch. */
  pendingLogId?: number
}

export async function submitHubspotForm(args: HubspotSubmitArgs): Promise<void> {
  const url = `${HUBSPOT_FORMS_API}/submissions/v3/integration/submit/${encodeURIComponent(args.portalId)}/${encodeURIComponent(args.formId)}`
  const fieldsArr = Object.entries(args.fields).map(([name, value]) => ({
    objectTypeId: '0-1',
    name,
    value: String(value ?? ''),
  }))
  const body = JSON.stringify({
    fields: fieldsArr,
    context: {
      ...(args.hutk ? { hutk: args.hutk } : {}),
      ...(args.pageUri ? { pageUri: args.pageUri } : {}),
      ...(args.pageName ? { pageName: args.pageName } : {}),
      ...(args.ipAddress ? { ipAddress: args.ipAddress } : {}),
    },
    legalConsentOptions: {
      consent: {
        consentToProcess: true,
        text: 'I agree to allow the site to store and process my personal data.',
      },
    },
  })
  let status: 'success' | 'http_error' | 'timeout' | 'transport_error' = 'transport_error'
  let httpCode: number | null = null
  let excerpt: string | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      cache: 'no-store',
      signal: controller.signal,
    })
    httpCode = r.status
    const text = await r.text()
    excerpt = scrubPii(text).slice(0, 480)
    if (r.ok) status = 'success'
    else status = 'http_error'
  } catch (err) {
    const e = err as { name?: string; message?: string } | undefined
    excerpt = (e?.message ?? '').slice(0, 480)
    status = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'transport_error'
  } finally {
    clearTimeout(timer)
  }
  await logDispatch({
    leadId: args.leadId,
    source: args.source,
    provider: 'hubspot',
    destinationId: args.formId,
    payloadSnapshot: args.fields,
    status,
    httpCode,
    excerpt,
    attempt: args.attempt,
    pendingLogId: args.pendingLogId,
  })
}

interface LogDispatchArgs {
  /** Local leads.id. 0 → newsletter (no leads row exists) → stored
   *  as NULL on the crm_dispatch_log row. */
  leadId: number
  source: LeadSource
  provider: 'hubspot' | 'zoho'
  destinationId: string
  /** Field-mapped payload that was sent (or attempted) to the
   *  provider. Persisted so the retry worker can replay verbatim. */
  payloadSnapshot: Record<string, string>
  status: 'success' | 'http_error' | 'timeout' | 'transport_error'
  httpCode: number | null
  excerpt: string | null
  attempt?: number
  /** When set, ADVANCE the existing pending row in place instead of
   *  inserting a new one. The pre-insertion lives in
   *  dispatch.ts:insertPendingRows so a worker recycle / SIGTERM
   *  between the lead INSERT and the outbound HTTP call still
   *  leaves a recoverable trail. */
  pendingLogId?: number
}

// Writes (or advances) a crm_dispatch_log row. Defensive about its
// own failures: if the DB blip swallows the INSERT, an outer alert
// is also written (best-effort) so the gap surfaces in
// /admin/activity rather than vanishing silently.
export async function logDispatch(args: LogDispatchArgs): Promise<void> {
  const attempt = args.attempt ?? 1
  const nextRetryAt = computeNextRetry(args.status, attempt)
  const finalStatus: CrmDispatchStatus =
    args.status === 'success'
      ? 'success'
      : nextRetryAt === null
        ? 'retry_exhausted'
        : 'retry_scheduled'
  const leadIdSql = args.leadId > 0 ? args.leadId : null
  const snapshotJson = JSON.stringify(args.payloadSnapshot ?? {})

  try {
    if (args.pendingLogId) {
      // Advance the pre-inserted pending row in place. This is the
      // happy path for the synchronous-pending-row pattern.
      await db.execute(sql`
        UPDATE crm_dispatch_log
        SET status = ${finalStatus},
            http_code = ${args.httpCode},
            response_excerpt = ${args.excerpt},
            attempt = ${attempt},
            next_retry_at = ${nextRetryAt},
            attempted_at = NOW(3)
        WHERE id = ${args.pendingLogId}
      `)
    } else {
      // No pre-inserted row (retry path with new attempt counter, or
      // legacy callers).
      await db.execute(sql`
        INSERT INTO crm_dispatch_log
          (lead_id, source, provider, destination_id, payload_snapshot,
           status, http_code, response_excerpt, attempt, next_retry_at)
        VALUES (
          ${leadIdSql}, ${args.source}, ${args.provider}, ${args.destinationId},
          ${snapshotJson},
          ${finalStatus}, ${args.httpCode}, ${args.excerpt}, ${attempt}, ${nextRetryAt}
        )
      `)
    }
  } catch (err) {
    // Last-resort visibility: if the dispatch log itself is unreachable,
    // the operator sees nothing about the failure. Write a
    // notification_failures row + console.error so the next /admin/
    // activity load surfaces the gap.
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)
    console.error(JSON.stringify({
      level: 'error', msg: 'crm_dispatch_log_insert_failed',
      provider: args.provider, source: args.source, leadId: args.leadId,
      err: msg,
    }))
    try {
      await db.execute(sql`
        INSERT INTO notification_failures
          (kind, ref_table, ref_id, payload, attempts, last_error)
        VALUES (
          'crm_dispatch_failed', 'crm_dispatch_log', NULL,
          ${JSON.stringify({ provider: args.provider, source: args.source, leadId: leadIdSql, reason: 'log_insert_failed' })},
          ${attempt}, ${msg}
        )
      `)
    } catch {
      // notification_failures itself is unreachable — DB is fully
      // down. Console.error already captured the original failure;
      // nothing more we can do from this path.
    }
    return
  }

  if (finalStatus === 'retry_exhausted') {
    // Operator alert. Best-effort + structured-logged on inner
    // failure so a logging-the-failure-to-log path can never crash
    // the worker. AWAIT the insert (and the catch body) inside this
    // function so a synchronous throw inside the catch can't become
    // an unhandled rejection.
    try {
      const alertPayload = JSON.stringify({
        provider: args.provider,
        destinationId: args.destinationId,
        source: args.source,
        leadId: args.leadId > 0 ? args.leadId : null,
        lastError: args.excerpt?.slice(0, 200) ?? null,
        lastHttpCode: args.httpCode,
      })
      await db.execute(sql`
        INSERT INTO notification_failures
          (kind, ref_table, ref_id, payload, attempts, last_error)
        VALUES (
          'crm_dispatch_failed', 'crm_dispatch_log', NULL,
          ${alertPayload}, ${attempt}, ${args.excerpt ?? null}
        )
      `)
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'crm_alert_insert_failed',
        err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      }))
    }
  }
}

// Strips email + phone shapes from provider response excerpts before
// they land in crm_dispatch_log.response_excerpt. HubSpot's Forms
// API echoes the offending field value in validation errors —
// without this, every "INVALID_EMAIL email \"alice@example.com\""
// response would persist alice@example.com in our DB indefinitely.
// Zoho's WebToLeadForm endpoint similarly echoes field values in its
// HTML error pages. Newsletter dispatch rows have lead_id=NULL so
// they don't CASCADE on subscriber deletion — keeping PII out of the
// excerpt is the cleanest mitigation. Exported so zoho.ts shares
// the same implementation.
export function scrubPii(text: string): string {
  return text
    // RFC-5322-ish email pattern (lenient on purpose — we'd rather
    // over-strip than leak).
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    // Phone numbers: require explicit `+` prefix so we don't
    // over-scrub GUIDs (8-4-4-4-12 hex with dashes) that happen to
    // look digit-y. The contact form prompts for "+1 555 0100"
    // shape so real phones in error responses always carry the `+`.
    // Domestic-without-+ numbers slip through, but the false-
    // positive cost (operator debug messages reading "<phone>" in
    // place of HubSpot form GUIDs) outweighs that gap.
    .replace(/\+\d[\d\s\-().]{6,18}\d/g, '<phone>')
}

const RETRY_LADDER_MS = RETRY_DELAYS_MS

function computeNextRetry(status: LogDispatchArgs['status'], attempt: number): Date | null {
  // Success + timeout are terminal: success means delivered;
  // `timeout` is documented at-most-once (re-issuing the same body
  // after timeout risks double-submission on HubSpot Forms — no
  // native idempotency key). See lib/crm/types.ts comment.
  if (RETRY_TERMINAL_OUTCOMES.has(status as CrmDispatchStatus)) return null
  if (attempt > RETRY_LADDER_MS.length) return null
  const delay = RETRY_LADDER_MS[attempt - 1]!
  return new Date(Date.now() + delay)
}

// Resolves stored credentials. Returns null when the integration
// isn't enabled or token isn't set (caller short-circuits without
// logging a row — no destination to dispatch to).
export async function getHubspotCreds(): Promise<HubspotCreds | null> {
  const cfg = await getRawSetting('integrations_hubspot')
  if (!cfg.enabled || !cfg.portalId || !cfg.privateAppAccessToken) return null
  return { portalId: cfg.portalId, privateAppAccessToken: cfg.privateAppAccessToken }
}

// Re-exports for backward compat with any caller importing
// CRM_DISPATCH_STATUSES from this module instead of types.
export { CRM_DISPATCH_STATUSES }
