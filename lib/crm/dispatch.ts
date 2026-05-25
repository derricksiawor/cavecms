import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { getRawSetting } from '@/lib/integrations/getRawSetting'
import { contactFormCrmDestinationsSchema } from '@/lib/cms/block-registry'
import { submitHubspotForm, logDispatch } from './hubspot'
import { submitZohoOauth, submitZohoWebform, type ZohoOauthCreds } from './zoho'
import { type LeadSource, type ZohoModule } from './types'

// Lead-source CRM dispatcher. Called by every public lead submit
// handler AFTER the local leads INSERT succeeds.
//
// Synchronous-pending-row pattern:
//   1. Resolve destinations from current config (DB reads).
//   2. INSERT one `pending` row per destination synchronously
//      BEFORE we queue any outbound HTTP. If the worker is killed
//      (OOM, SIGTERM during deploy, Next route handler timeout)
//      between this point and the actual fetch, the pending row
//      is left for the retry worker (cron-crm-retry.ts) to find
//      via its stale-pending reaper.
//   3. queueMicrotask the outbound fetches. Each call advances its
//      pending row in place (UPDATE WHERE id=pendingLogId) so we
//      never duplicate rows across the retry boundary.
//
// Per-instance overrides:
//   When a contact_form block submits, the route passes the block's
//   `id`. We look up the block's `data.crmDestinations` and use
//   those instead of the site-wide formSourceMap default. Per-
//   instance config can omit webformAuthToken — it falls back to
//   the integrations setting's per-source token (per-instance
//   tokens are not persisted in block.data — they would bypass the
//   step-up reauth gate on settings).

export type { LeadSource } from './types'

export interface LeadPayload {
  leadId: number
  source: LeadSource
  /** Raw CaveCMS field values keyed by names operator maps against. */
  cavecmsFields: Record<string, string | null | undefined>
  /** When the lead came from a contact_form block, the block id. */
  blockId?: number
  /** HubSpot visitor-attribution cookie. */
  hutk?: string
  pageUri?: string
  ipAddress?: string
}

// Per-instance crmDestinations on a contact_form block. Validated by
// the block-registry Zod schema at save time. Webform tokens are NOT
// stored on the block — see comments above.
interface HubspotBlockDest {
  provider: 'hubspot'
  formId: string
  fieldMap: Record<string, string>
  listIds?: number[]
}
interface ZohoBlockDest {
  provider: 'zoho'
  module: ZohoModule
  mode: 'webform' | 'oauth'
  fieldMap: Record<string, string>
  assignmentRuleId?: string
}
type BlockDest = HubspotBlockDest | ZohoBlockDest

// Resolved spec for a single destination (block override OR site
// default). The webformAuthToken slot is filled from the
// integrations setting when the block-override path is taken so
// the dispatcher always has a token to use.
type ResolvedHubspot = HubspotBlockDest
interface ResolvedZoho extends ZohoBlockDest {
  webformAuthToken?: string
}
type ResolvedDest = ResolvedHubspot | ResolvedZoho

// dispatchLeadToCrms is awaited briefly by lead routes — long enough
// to insert the pending rows synchronously (~5-10ms), THEN the
// outbound HTTP runs in queueMicrotask so the user's response is
// not delayed. The "instant 200" contract is preserved (the HTTP
// fetches don't block the response); the pending-row insertion
// adds a few milliseconds + closes the worker-recycle gap.
export async function dispatchLeadToCrms(payload: LeadPayload): Promise<void> {
  try {
    const [hubspot, zoho] = await Promise.all([
      getRawSetting('integrations_hubspot'),
      getRawSetting('integrations_zoho_crm'),
    ])
    const destinations = await resolveDestinations(payload, hubspot, zoho)
    if (destinations.length === 0) return

    // Build the field-mapped payload + insert pending row for each
    // destination synchronously. Pending rows live for at most
    // RETRY_REAP_THRESHOLD_MS before the retry worker either
    // advances them (HTTP completed in microtask) or reaps them
    // back to retry_scheduled. Inserted in parallel so the user
    // response isn't delayed by 4× round-trips.
    const dispatches = destinations.map((d) => ({
      dest: d,
      mappedFields: mapFields(payload.cavecmsFields, d.fieldMap),
    }))
    const pendingIds = await Promise.all(
      dispatches.map((item) => insertPendingRow(payload, item.dest, item.mappedFields)),
    )

    const zohoOauthCreds: ZohoOauthCreds | null =
      zoho.enabled && zoho.authMode === 'oauth' &&
      zoho.oauthClientId && zoho.oauthClientSecret && zoho.oauthRefreshToken
        ? { region: zoho.region, clientId: zoho.oauthClientId, clientSecret: zoho.oauthClientSecret, refreshToken: zoho.oauthRefreshToken }
        : null

    queueMicrotask(() => {
      void runOutboundHttp(payload, dispatches, pendingIds, hubspot, zohoOauthCreds, zoho.region).catch((err) => {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'crm_dispatch_outer_failure',
          leadId: payload.leadId,
          source: payload.source,
          err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        }))
      })
    })
  } catch (err) {
    // Pending-row insertion failed before the microtask was even
    // queued — surface for ops. Local lead row is unaffected.
    console.error(JSON.stringify({
      level: 'error',
      msg: 'crm_dispatch_pending_setup_failed',
      leadId: payload.leadId,
      source: payload.source,
      err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    }))
  }
}

interface HubspotConfig {
  enabled: boolean
  portalId?: string
  privateAppAccessToken?: string
}

type ZohoRegion = 'com' | 'eu' | 'in' | 'com.au' | 'jp'

async function runOutboundHttp(
  payload: LeadPayload,
  dispatches: Array<{ dest: ResolvedDest; mappedFields: Record<string, string> }>,
  pendingIds: number[],
  hubspot: HubspotConfig,
  zohoOauthCreds: ZohoOauthCreds | null,
  zohoRegion: ZohoRegion,
): Promise<void> {
  // Each dispatch resolves to a no-op (when the integration is
  // disabled / creds cleared between INSERT and queueMicrotask) OR
  // a real outbound HTTP call. The no-op path still advances the
  // pending row to retry_exhausted via logDispatch so operators
  // see "lead never reached CRM" in /admin/activity instead of a
  // silently abandoned pending row.
  const promises = dispatches.map((item, i) => {
    const pendingLogId = pendingIds[i]!
    const d = item.dest
    if (d.provider === 'hubspot') {
      if (!hubspot.enabled || !hubspot.portalId || !hubspot.privateAppAccessToken) {
        return markPendingIntegrationDisabled(payload, d, item.mappedFields, pendingLogId, 'hubspot_disabled_at_dispatch')
      }
      return submitHubspotForm({
        leadId: payload.leadId,
        source: payload.source,
        portalId: hubspot.portalId,
        formId: d.formId,
        fields: item.mappedFields,
        hutk: payload.hutk,
        pageUri: payload.pageUri,
        ipAddress: payload.ipAddress,
        pendingLogId,
      })
    }
    // Zoho
    if (d.mode === 'oauth') {
      if (!zohoOauthCreds) return markPendingIntegrationDisabled(payload, d, item.mappedFields, pendingLogId, 'zoho_oauth_creds_missing_at_dispatch')
      return submitZohoOauth({
        leadId: payload.leadId,
        source: payload.source,
        creds: zohoOauthCreds,
        module: d.module,
        fields: item.mappedFields,
        assignmentRuleId: d.assignmentRuleId,
        pendingLogId,
      })
    }
    if (!d.webformAuthToken) return markPendingIntegrationDisabled(payload, d, item.mappedFields, pendingLogId, 'zoho_webform_token_missing_at_dispatch')
    return submitZohoWebform({
      leadId: payload.leadId,
      source: payload.source,
      region: zohoRegion,
      module: d.module,
      webformAuthToken: d.webformAuthToken,
      fields: item.mappedFields,
      assignmentRuleId: d.assignmentRuleId,
      pendingLogId,
    })
  })
  await Promise.allSettled(promises)
}

// Advance an unreachable pending row to retry_exhausted so the
// operator gets a notification_failures alert. Without this the row
// would sit at 'pending' until the reaper sweeps it back to
// retry_scheduled, the retry worker would then mark it consumed,
// and the operator would never know the dispatch never fired.
async function markPendingIntegrationDisabled(
  payload: LeadPayload,
  dest: ResolvedDest,
  mappedFields: Record<string, string>,
  pendingLogId: number,
  reason: string,
): Promise<void> {
  const destinationId = dest.provider === 'hubspot'
    ? dest.formId
    : `${dest.mode}:${dest.module}`
  await logDispatch({
    leadId: payload.leadId,
    source: payload.source,
    provider: dest.provider,
    destinationId,
    payloadSnapshot: mappedFields,
    status: 'transport_error',
    httpCode: null,
    excerpt: reason,
    // attempt > RETRY_DELAYS_MS.length so computeNextRetry returns
    // null → finalStatus becomes retry_exhausted → notification_
    // failures alert fires.
    attempt: 99,
    pendingLogId,
  })
}

type HubspotSetting = Awaited<ReturnType<typeof getRawSetting<'integrations_hubspot'>>>
type ZohoSetting = Awaited<ReturnType<typeof getRawSetting<'integrations_zoho_crm'>>>

// Returns destinations enriched with the webform token from the
// integrations setting (when applicable) so the dispatcher has
// everything it needs to fire without extra DB reads.
async function resolveDestinations(
  payload: LeadPayload,
  hubspot: HubspotSetting,
  zoho: ZohoSetting,
): Promise<ResolvedDest[]> {
  // 1. Per-instance: block.data.crmDestinations (contact_form only).
  if (payload.blockId && payload.source === 'contact') {
    const perInstance = await loadBlockCrmDestinations(payload.blockId)
    if (perInstance && perInstance.length > 0) {
      return perInstance.map((d) => enrichBlockDest(d, zoho))
    }
  }
  // 2. Fallback: integrations_*.formSourceMap[source]
  const out: ResolvedDest[] = []
  const hsDefault = hubspot.formSourceMap?.[payload.source]
  if (hsDefault && hubspot.enabled) {
    out.push({ provider: 'hubspot', formId: hsDefault.formId, fieldMap: hsDefault.fieldMap, listIds: hsDefault.listIds })
  }
  const zcDefault = zoho.formSourceMap?.[payload.source]
  if (zcDefault && zoho.enabled) {
    out.push({
      provider: 'zoho',
      module: zcDefault.module,
      mode: zcDefault.mode,
      webformAuthToken: zcDefault.webformAuthToken,
      fieldMap: zcDefault.fieldMap,
      assignmentRuleId: zcDefault.assignmentRuleId,
    })
  }
  return out
}

// Enrich a block-override Zoho destination with the webform token
// from the integrations setting. The block schema deliberately
// omits webformAuthToken to keep the token out of operator-readable
// block.data — the token only lives in settings, which is gated by
// step-up reauth + server-side redaction.
function enrichBlockDest(d: BlockDest, zoho: ZohoSetting): ResolvedDest {
  if (d.provider === 'hubspot') return d
  if (d.mode !== 'webform') return d
  // Pull the per-source webform token from the integrations setting
  // for THIS contact_form block's source ('contact'). Webform tokens
  // are intentionally NOT persisted on block.data — that would bypass
  // the step-up reauth gate on integrations settings. If the operator
  // didn't configure a contact-source token, the dispatch helper
  // short-circuits (no token → null dispatch with structured log).
  const sourceDest = zoho.formSourceMap?.['contact']
  if (sourceDest?.mode === 'webform' && sourceDest.webformAuthToken) {
    return { ...d, webformAuthToken: sourceDest.webformAuthToken }
  }
  return d
}

async function loadBlockCrmDestinations(blockId: number): Promise<BlockDest[] | null> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT data FROM content_blocks WHERE id = ${blockId}
    `)) as unknown as [Array<{ data: unknown }>]
    if (!rows[0]) return null
    const raw = rows[0].data
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null
    const dests = (parsed as { crmDestinations?: unknown }).crmDestinations
    if (!Array.isArray(dests)) return null
    // STRICT re-validation via the registry schema. .strict() on each
    // branch strips unknown keys (defence in depth against any path
    // that could surface a hand-edited row / restored backup carrying
    // a stale `webformAuthToken` or future-schema field we don't
    // recognise). safeParse — never throw; on failure, log + ignore
    // the per-instance config and fall back to site defaults.
    const result = contactFormCrmDestinationsSchema.safeParse(dests)
    if (!result.success) {
      console.error(JSON.stringify({
        level: 'error',
        msg: 'block_crm_destinations_invalid',
        blockId,
        issue: result.error.issues[0]?.message ?? 'unknown',
      }))
      return null
    }
    return result.data as BlockDest[]
  } catch {
    return null
  }
}

function mapFields(
  cavecmsFields: Record<string, string | null | undefined>,
  fieldMap: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [cavecms, crm] of Object.entries(fieldMap)) {
    const v = cavecmsFields[cavecms]
    if (v != null && v !== '') out[crm] = String(v)
  }
  return out
}

// Synchronously insert a pending row before any outbound HTTP.
// Returns the inserted id so the dispatcher can advance it in place
// instead of inserting a new row when the HTTP completes.
async function insertPendingRow(
  payload: LeadPayload,
  dest: ResolvedDest,
  mappedFields: Record<string, string>,
): Promise<number> {
  const leadIdSql = payload.leadId > 0 ? payload.leadId : null
  const destinationId = dest.provider === 'hubspot'
    ? dest.formId
    : `${dest.mode}:${dest.module}`
  const snapshotJson = JSON.stringify(mappedFields)
  const [r] = (await db.execute(sql`
    INSERT INTO crm_dispatch_log
      (lead_id, source, provider, destination_id, payload_snapshot,
       status, http_code, response_excerpt, attempt, next_retry_at)
    VALUES (
      ${leadIdSql}, ${payload.source}, ${dest.provider}, ${destinationId},
      ${snapshotJson},
      'pending', NULL, NULL, 1, NULL
    )
  `)) as unknown as [{ insertId: number }]
  return Number(r.insertId)
}
