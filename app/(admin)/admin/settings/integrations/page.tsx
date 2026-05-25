import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { registry, type SettingsKey } from '@/lib/cms/settings-registry'
import { IntegrationsForm } from './IntegrationsForm'

// Admin-only third-party integrations. Mirrors the Security page
// shape: one custom card per provider, each with independent draft +
// version + save flow so a partial failure can't half-configure two
// providers at once.
//
// Credential redaction happens here on the server (not in the form).
// Secret fields (HubSpot privateAppAccessToken, Zoho OAuth
// client/secret/refresh tokens) are stripped from the row before
// the data reaches the client component — paired with an `_isSet`
// flag the form uses to render "Token saved — replace?" UI. The
// PATCH route (app/api/admin/settings/route.ts) then preserves any
// incoming undefined/empty credential against the stored value, so
// "save without editing" never clobbers the stored secret.

const INTEGRATION_KEYS: SettingsKey[] = [
  'integrations_gtm',
  'integrations_ga4',
  'integrations_google_ads',
  'integrations_hotjar',
  'integrations_zoho_salesiq',
  'integrations_hubspot',
  'integrations_zoho_crm',
]

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface SettingRow {
  key: string
  value: unknown
  version: number
  updated_at: Date
}

// Server-side credential redaction. Strips the secret out of the row
// JSON before it leaves the server, and notes its prior presence in
// a sibling `_isSet` map. Client form uses `_isSet` to render the
// "Token saved" badge + "Replace" affordance; the redacted fields
// arrive as empty strings (or absent) so a leaked client bundle can
// never replay the real secret.
function redactCredentials(key: string, value: unknown): { value: unknown; isSet: Record<string, boolean> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value, isSet: {} }
  }
  const v = { ...(value as Record<string, unknown>) }
  const isSet: Record<string, boolean> = {}
  const secretFields =
    key === 'integrations_hubspot'
      ? ['privateAppAccessToken']
      : key === 'integrations_zoho_crm'
        ? ['oauthClientId', 'oauthClientSecret', 'oauthRefreshToken']
        : []
  for (const f of secretFields) {
    isSet[f] = typeof v[f] === 'string' && (v[f] as string).length > 0
    if (isSet[f]) v[f] = ''
  }
  // Zoho `formSourceMap.*.webformAuthToken` — the xnQsjsdp token
  // that ships in public Zoho webforms. Lower impact than the
  // OAuth secrets above (it's already publicly visible in any
  // legitimate Zoho webform), but redact for consistency so an
  // admin-side XSS / stolen-session attacker can't enumerate the
  // operator's token via the admin page payload.
  if (key === 'integrations_zoho_crm') {
    const fsm = v.formSourceMap
    if (fsm && typeof fsm === 'object' && !Array.isArray(fsm)) {
      const cleanFsm: Record<string, unknown> = {}
      for (const [source, dest] of Object.entries(fsm as Record<string, unknown>)) {
        if (dest && typeof dest === 'object' && !Array.isArray(dest)) {
          const d = { ...(dest as Record<string, unknown>) }
          if (typeof d.webformAuthToken === 'string' && d.webformAuthToken.length > 0) {
            d.webformAuthToken = ''
          }
          cleanFsm[source] = d
        } else {
          cleanFsm[source] = dest
        }
      }
      v.formSourceMap = cleanFsm
    }
  }
  return { value: v, isSet }
}

export default async function IntegrationsSettingsPage() {
  await requireRoleOrRedirect(['admin'])

  const [rawRows] = (await db.execute(sql`
    SELECT \`key\`, value, version, updated_at
    FROM settings
    WHERE \`key\` LIKE 'integrations\\_%'
    ORDER BY \`key\`
  `)) as unknown as [SettingRow[]]

  // Parse JSON (mysql2 returns JSON as string for LONGTEXT-aliased
  // columns — same pattern as the security page).
  const parsed = rawRows.map((r) => ({
    ...r,
    value:
      typeof r.value === 'string'
        ? (() => {
            try {
              return JSON.parse(r.value as string)
            } catch {
              return r.value
            }
          })()
        : r.value,
  }))

  const byKey = new Map(parsed.map((r) => [r.key, r]))
  const synthesizedNow = new Date()
  const rows = INTEGRATION_KEYS.map((k) => {
    const existing = byKey.get(k)
    const raw = existing ? existing.value : (registry[k].default as unknown)
    const { value, isSet } = redactCredentials(k, raw)
    return {
      key: k,
      value,
      version: existing ? existing.version : 0,
      updated_at: existing ? existing.updated_at : synthesizedNow,
      isSet,
    }
  })

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Site settings
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Integrations
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Analytics, advertising, chat widgets, and CRM lead capture for
        HubSpot and Zoho. Each integration is independent — saving one
        provider never touches another&rsquo;s row. CRM credentials are
        write-only: we&rsquo;ll show <em>Token saved</em> after a successful save
        and never echo the value back. Editing a CRM token re-prompts for your password.
      </p>
      <IntegrationsForm initial={rows} />
    </div>
  )
}
