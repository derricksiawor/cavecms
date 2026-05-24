import 'server-only'
import { getRawSetting } from '@/lib/integrations/getRawSetting'
import { logDispatch, scrubPii, type LeadSource } from './hubspot'
import { OUTBOUND_TIMEOUT_MS, type ZohoModule } from './types'

// Zoho CRM dispatch helpers. Two auth modes:
//
//   webform — per-form xnQsjsdp tokens; POST as urlencoded to
//             crm.zoho.<region>/crm/WebToLeadForm. No OAuth dance,
//             no refresh.
//
//   oauth   — full v8 REST. Refresh token persists on the settings
//             row; access tokens minted on demand and cached
//             in-process (Map keyed by region+clientId, expires 1
//             min before the issued lifetime to give clock-skew
//             slack). PM2 single-instance — fine for now.
//             Multi-instance would push the cache to Redis.
//
// All outbound fetches use AbortController-driven timeouts that
// cover BOTH connect/headers and body-read.

export type ZohoRegion = 'com' | 'eu' | 'in' | 'com.au' | 'jp'

function accountsHost(region: ZohoRegion): string {
  return `https://accounts.zoho.${region}`
}
function apiHost(region: ZohoRegion): string {
  return `https://www.zohoapis.${region}`
}
function crmHost(region: ZohoRegion): string {
  return `https://crm.zoho.${region}`
}

interface AccessTokenEntry { token: string; expiresAt: number }

// Bounded in-process cache. PM2 single-instance + 1-5 distinct
// (region, clientId) combos in realistic deployments — the cap is
// belt-and-braces against pathological credential rotation. When
// size > MAX_ACCESS_TOKEN_CACHE the whole map is cleared (LRU was
// over-engineering for 8 entries).
const MAX_ACCESS_TOKEN_CACHE = 8
const accessTokens = new Map<string, AccessTokenEntry>()

// Operator-facing cache invalidation. The settings PATCH handler
// calls this when oauth credentials change (cleared or replaced) so
// the cached access token minted from the OLD refresh token can't
// continue to be used after rotation. Module-local map — exporting
// the invalidation keeps the cache opaque to callers.
export function clearZohoAccessTokenCache(region?: ZohoRegion, clientId?: string): void {
  if (!region || !clientId) {
    accessTokens.clear()
    return
  }
  accessTokens.delete(`${region}:${clientId}`)
}

export interface ZohoOauthCreds {
  region: ZohoRegion
  clientId: string
  clientSecret: string
  refreshToken: string
}

interface MintResult {
  token: string | null
  /** Operator-visible reason when token is null. Surfaced by
   *  testZohoConnection — concrete error beats "could not mint". */
  reason?: string
  httpCode?: number
}

// Mints an OAuth access token via the refresh-token grant. Caches
// in-process up to MAX_ACCESS_TOKEN_CACHE entries; falls back to
// fetching on cache miss. Network/HTTP failures return an MintResult
// with `reason` so callers can surface specifics.
export async function mintZohoAccessToken(creds: ZohoOauthCreds): Promise<MintResult> {
  const cacheKey = `${creds.region}:${creds.clientId}`
  const cached = accessTokens.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return { token: cached.token }
  // Post credentials in the request body — NOT the URL query string.
  // Zoho accepts both, but putting client_secret in the query string
  // would leak it into any upstream proxy / CDN access log along the
  // path. The form-encoded body shape is the OAuth 2.0 spec default
  // (RFC 6749 §4.5) for refresh-token grants.
  const params = new URLSearchParams({
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(`${accountsHost(creds.region)}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      // Don't surface text verbatim — Zoho may echo client_id and
      // we don't want it landing in /admin/activity payloads.
      const reason = r.status === 401
        ? 'Refresh token rejected (401). Re-authorize the Zoho app.'
        : `Zoho token endpoint returned ${r.status}.`
      console.error(JSON.stringify({
        level: 'error', msg: 'zoho_mint_access_token_failed',
        region: creds.region, httpCode: r.status,
        excerpt: text.slice(0, 200),
      }))
      return { token: null, reason, httpCode: r.status }
    }
    const j = (await r.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) {
      return { token: null, reason: 'Zoho response missing access_token.' }
    }
    // expires_in is seconds; default 3600. Subtract 60s for safety
    // so we treat tokens as expired before Zoho does.
    const ttlSec = typeof j.expires_in === 'number' ? Math.max(60, j.expires_in - 60) : 3540
    if (accessTokens.size >= MAX_ACCESS_TOKEN_CACHE) accessTokens.clear()
    accessTokens.set(cacheKey, { token: j.access_token, expiresAt: Date.now() + ttlSec * 1000 })
    return { token: j.access_token }
  } catch (err) {
    const name = (err as { name?: string })?.name
    const reason = name === 'AbortError' || name === 'TimeoutError'
      ? 'Zoho token endpoint timed out.'
      : 'Network error reaching Zoho.'
    console.error(JSON.stringify({
      level: 'error', msg: 'zoho_mint_access_token_threw',
      region: creds.region,
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    }))
    return { token: null, reason }
  } finally {
    clearTimeout(timer)
  }
}

// Pings /crm/v8/users?type=CurrentUser with the minted access token.
// Surface specific messages for the common credential failures.
export async function testZohoConnection(creds: ZohoOauthCreds): Promise<{ ok: boolean; message: string }> {
  const mint = await mintZohoAccessToken(creds)
  if (!mint.token) {
    return { ok: false, message: mint.reason ?? 'Could not mint access token. Check Client ID, Secret, and Refresh Token.' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(`${apiHost(creds.region)}/crm/v8/users?type=CurrentUser`, {
      headers: { authorization: `Zoho-oauthtoken ${mint.token}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (r.ok) return { ok: true, message: 'Connected.' }
    if (r.status === 401) return { ok: false, message: 'Access token rejected. Refresh token may be revoked.' }
    return { ok: false, message: `Zoho returned ${r.status}.` }
  } catch {
    return { ok: false, message: "Couldn't reach Zoho." }
  } finally {
    clearTimeout(timer)
  }
}

interface ZohoField { api_name: string; field_label: string; data_type: string }

export async function listZohoModuleFields(creds: ZohoOauthCreds, module: string): Promise<{ ok: boolean; fields: ZohoField[]; message?: string }> {
  const mint = await mintZohoAccessToken(creds)
  if (!mint.token) return { ok: false, fields: [], message: mint.reason ?? 'Could not mint access token.' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(`${apiHost(creds.region)}/crm/v8/settings/fields?module=${encodeURIComponent(module)}`, {
      headers: { authorization: `Zoho-oauthtoken ${mint.token}` },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!r.ok) return { ok: false, fields: [], message: `Zoho returned ${r.status}.` }
    const j = (await r.json()) as { fields?: Array<{ api_name: string; field_label: string; data_type: string }> }
    return { ok: true, fields: j.fields ?? [] }
  } catch {
    return { ok: false, fields: [], message: "Couldn't reach Zoho." }
  } finally {
    clearTimeout(timer)
  }
}

export async function getZohoOauthCreds(): Promise<ZohoOauthCreds | null> {
  const cfg = await getRawSetting('integrations_zoho_crm')
  if (!cfg.enabled || cfg.authMode !== 'oauth') return null
  if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.oauthRefreshToken) return null
  return {
    region: cfg.region,
    clientId: cfg.oauthClientId,
    clientSecret: cfg.oauthClientSecret,
    refreshToken: cfg.oauthRefreshToken,
  }
}

// ─────────────────────── Lead dispatch ───────────────────────

export interface ZohoWebformSubmitArgs {
  leadId: number
  source: LeadSource
  region: ZohoRegion
  module: ZohoModule
  webformAuthToken: string
  fields: Record<string, string>
  assignmentRuleId?: string
  attempt?: number
  pendingLogId?: number
}

// Webform-mode submit. POSTs urlencoded to /crm/WebToLeadForm.
// xnQsjsdp is the form-bound auth token; Zoho infers the org from
// the token. `actionType` maps to the module via the public
// base64-shaped constants documented at
// https://help.zoho.com/portal/en/kb/crm/connect-with-customers/webforms.
export async function submitZohoWebform(args: ZohoWebformSubmitArgs): Promise<void> {
  const form = new URLSearchParams()
  form.set('xnQsjsdp', args.webformAuthToken)
  form.set('actionType', MODULE_ACTION_TYPE[args.module])
  form.set('returnURL', 'about:blank')
  // `aG9zdHNlcnZpY2VzaWQ` decodes to `hostservicesid` — the magic
  // form-field name Zoho emits in generated webform HTML for the
  // assignment-rule selector. It's a generated constant, not a
  // versioned API contract, so verify against a freshly-regenerated
  // form HTML periodically (Zoho has not changed it in years).
  if (args.assignmentRuleId) form.set('aG9zdHNlcnZpY2VzaWQ', args.assignmentRuleId)
  for (const [k, v] of Object.entries(args.fields)) form.set(k, String(v ?? ''))
  let status: 'success' | 'http_error' | 'timeout' | 'transport_error' = 'transport_error'
  let httpCode: number | null = null
  let excerpt: string | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(`${crmHost(args.region)}/crm/WebToLeadForm`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      cache: 'no-store',
      signal: controller.signal,
      redirect: 'manual',
    })
    httpCode = r.status
    const text = await r.text().catch(() => '')
    // Zoho's WebToLeadForm error pages echo submitted field values
    // verbatim. Scrub before persisting — same rule as HubSpot.
    excerpt = scrubPii(text).slice(0, 480)
    // Zoho returns 302 on success (redirect to returnURL), 200 on
    // validation failure with body explaining the issue.
    //
    // WHATWG fetch quirk: with `redirect: 'manual'`, the spec says
    // the response is an "opaque-redirect filtered response" whose
    // status is 0 and body is empty. Undici / Node historically
    // returns the real redirect status (302) but newer versions
    // tighten to spec. Accept BOTH `0` and `3xx` as success so this
    // code is portable across runtimes — without the status=0
    // branch a spec-compliant runtime would log every successful
    // submit as `http_error` and flood operator alerts.
    if (r.status === 0 || (r.status >= 300 && r.status < 400)) status = 'success'
    else if (r.ok) status = 'success'
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
    provider: 'zoho',
    destinationId: `webform:${args.module}`,
    payloadSnapshot: args.fields,
    status,
    httpCode,
    excerpt,
    attempt: args.attempt,
    pendingLogId: args.pendingLogId,
  })
}

// Zoho's WebToLeadForm endpoint uses base64-encoded actionType tokens
// per module. Values are public + documented; pre-encoded here so we
// don't have to call btoa at request time.
const MODULE_ACTION_TYPE: Record<ZohoModule, string> = {
  Leads: 'TGVhZHM=',
  Contacts: 'Q29udGFjdHM=',
  Deals: 'RGVhbHM=',
}

export interface ZohoOauthSubmitArgs {
  leadId: number
  source: LeadSource
  creds: ZohoOauthCreds
  module: ZohoModule
  fields: Record<string, string>
  assignmentRuleId?: string
  attempt?: number
  pendingLogId?: number
}

export async function submitZohoOauth(args: ZohoOauthSubmitArgs): Promise<void> {
  const mint = await mintZohoAccessToken(args.creds)
  if (!mint.token) {
    await logDispatch({
      leadId: args.leadId,
      source: args.source,
      provider: 'zoho',
      destinationId: `oauth:${args.module}`,
      payloadSnapshot: args.fields,
      status: 'transport_error',
      httpCode: mint.httpCode ?? null,
      excerpt: mint.reason ?? 'Could not mint access token.',
      attempt: args.attempt,
      pendingLogId: args.pendingLogId,
    })
    return
  }
  const body = JSON.stringify({
    data: [args.fields],
    trigger: ['approval', 'workflow', 'blueprint'],
  })
  let status: 'success' | 'http_error' | 'timeout' | 'transport_error' = 'transport_error'
  let httpCode: number | null = null
  let excerpt: string | null = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const r = await fetch(`${apiHost(args.creds.region)}/crm/v8/${encodeURIComponent(args.module)}`, {
      method: 'POST',
      headers: {
        authorization: `Zoho-oauthtoken ${mint.token}`,
        'content-type': 'application/json',
      },
      body,
      cache: 'no-store',
      signal: controller.signal,
    })
    httpCode = r.status
    const text = await r.text()
    // Strip echoed PII before persisting: success response contains
    // the row we just created, error response may echo submitted
    // field values. Structural extract on JSON; scrubPii fallback
    // for non-JSON bodies (5xx HTML error pages, edge timeouts).
    try {
      const j = JSON.parse(text) as { data?: Array<{ code?: string; status?: string; details?: { id?: string } }> }
      const first = j.data?.[0]
      excerpt = JSON.stringify({ code: first?.code, status: first?.status, id: first?.details?.id }).slice(0, 480)
    } catch {
      excerpt = scrubPii(text).slice(0, 480)
    }
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
    provider: 'zoho',
    destinationId: `oauth:${args.module}`,
    payloadSnapshot: args.fields,
    status,
    httpCode,
    excerpt,
    attempt: args.attempt,
    pendingLogId: args.pendingLogId,
  })
}
