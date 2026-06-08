'use client'

import { useEffect, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/inline-edit/Switch'
import { PasswordPromptModal } from '@/components/admin/PasswordPromptModal'
import { usePasswordReauth } from '@/hooks/usePasswordReauth'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'

// Admin Integrations form. Seven cards, each independent (per-card
// draft + version + save) so a partial failure on one provider can
// never roll back another's commit. Mirrors the security page's
// per-card pattern; built lean (no live-validation halos) because the
// trust boundary is the Zod schema on the server.
//
// Credential UX: the HubSpot + Zoho CRM cards receive the row with
// secret fields redacted to empty strings and a sibling `isSet` map
// noting their prior presence. The form shows a "Token saved" badge
// when isSet is true. Operator clicks "Replace token" to expose the
// input; leaves it empty and saves → server preserves the stored
// value. Types a new value → server replaces. Clicks "Clear token"
// → form posts null and the server PATCH explicitly removes it.

const ZOHO_REGIONS = ['com', 'eu', 'in', 'com.au', 'jp'] as const
const HUBSPOT_LEAD_SOURCES = ['contact', 'newsletter', 'brochure', 'inquiry', 'form'] as const
const ZOHO_MODULES = ['Leads', 'Contacts', 'Deals'] as const

// CaveCMS field shapes per lead source. Used to seed the left column of
// the per-source field-map editor so operators see the field names
// they're mapping FROM. Mirrors the Zod Body schemas in the lead
// submit handlers (app/api/leads/*/route.ts).
const SOURCE_FIELDS: Record<(typeof HUBSPOT_LEAD_SOURCES)[number], string[]> = {
  contact: ['name', 'email', 'phone', 'message', 'enquiry_type', 'tour_date', 'tour_time', 'brochure_project'],
  newsletter: ['email', 'name'],
  brochure: ['name', 'email', 'phone', 'brochure_project'],
  inquiry: ['name', 'email', 'phone', 'message'],
  // Generic lx_form site-wide default. A form's field names are operator-defined
  // and vary per form, so this fixed left column is just the role-mapped basics;
  // the per-form CRM tab (block.data.crmDestinations) is the richer exact path.
  form: ['name', 'email', 'phone'],
}

// ─────────────────────────── Value shapes ───────────────────────────

interface GtmValue { enabled: boolean; containerId?: string }
interface Ga4Value { enabled: boolean; measurementId?: string; viaGtm: boolean }
interface AdsValue { enabled: boolean; conversionId?: string; defaultConversionLabel?: string }
interface HotjarValue { enabled: boolean; siteId?: string; snippetVersion: number }
interface SalesIqValue { enabled: boolean; widgetCode?: string; region: (typeof ZOHO_REGIONS)[number] }
interface HubspotDestination { formId: string; fieldMap: Record<string, string>; listIds?: number[] }
interface HubspotValue {
  enabled: boolean
  portalId?: string
  privateAppAccessToken?: string
  trackingEnabled: boolean
  formSourceMap?: Partial<Record<(typeof HUBSPOT_LEAD_SOURCES)[number], HubspotDestination>>
}
interface ZohoDestination {
  module: (typeof ZOHO_MODULES)[number]
  mode: 'webform' | 'oauth'
  webformAuthToken?: string
  fieldMap: Record<string, string>
  assignmentRuleId?: string
}
interface ZohoCrmValue {
  enabled: boolean
  region: (typeof ZOHO_REGIONS)[number]
  authMode: 'webform' | 'oauth'
  oauthClientId?: string
  oauthClientSecret?: string
  oauthRefreshToken?: string
  formSourceMap?: Partial<Record<(typeof HUBSPOT_LEAD_SOURCES)[number], ZohoDestination>>
}

interface Row {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
  isSet: Record<string, boolean>
}

interface Props {
  initial: Row[]
}

function findRow<T>(rows: Row[], key: string): { value: T; version: number; isSet: Record<string, boolean> } {
  const r = rows.find((x) => x.key === key)
  if (!r) throw new Error(`integration row missing: ${key}`)
  return { value: r.value as T, version: r.version, isSet: r.isSet }
}

// ─────────────────────────── Root ───────────────────────────

export function IntegrationsForm({ initial }: Props) {
  const toast = useToast()
  const reauthCtl = usePasswordReauth('Enter your password to save CRM credentials')
  const reauth = reauthCtl.ensureReauth

  const gtmI = findRow<GtmValue>(initial, 'integrations_gtm')
  const [gtm, setGtm] = useState<GtmValue>(gtmI.value)
  const [gtmVer, setGtmVer] = useState(gtmI.version)
  const gtmP = useMemo(() => gtmI.value, [gtmI.value])

  const ga4I = findRow<Ga4Value>(initial, 'integrations_ga4')
  const [ga4, setGa4] = useState<Ga4Value>(ga4I.value)
  const [ga4Ver, setGa4Ver] = useState(ga4I.version)
  const ga4P = useMemo(() => ga4I.value, [ga4I.value])

  const adsI = findRow<AdsValue>(initial, 'integrations_google_ads')
  const [ads, setAds] = useState<AdsValue>(adsI.value)
  const [adsVer, setAdsVer] = useState(adsI.version)
  const adsP = useMemo(() => adsI.value, [adsI.value])

  const hjI = findRow<HotjarValue>(initial, 'integrations_hotjar')
  const [hj, setHj] = useState<HotjarValue>(hjI.value)
  const [hjVer, setHjVer] = useState(hjI.version)
  const hjP = useMemo(() => hjI.value, [hjI.value])

  const siqI = findRow<SalesIqValue>(initial, 'integrations_zoho_salesiq')
  const [siq, setSiq] = useState<SalesIqValue>(siqI.value)
  const [siqVer, setSiqVer] = useState(siqI.version)
  const siqP = useMemo(() => siqI.value, [siqI.value])

  const hsI = findRow<HubspotValue>(initial, 'integrations_hubspot')
  const [hs, setHs] = useState<HubspotValue>(hsI.value)
  const [hsVer, setHsVer] = useState(hsI.version)
  const hsP = useMemo(() => hsI.value, [hsI.value])

  const zcI = findRow<ZohoCrmValue>(initial, 'integrations_zoho_crm')
  const [zc, setZc] = useState<ZohoCrmValue>(zcI.value)
  const [zcVer, setZcVer] = useState(zcI.version)
  const zcP = useMemo(() => zcI.value, [zcI.value])

  const [busy, setBusy] = useState<string | null>(null)

  const reauthFatal = reauthCtl.fatal
  const reauthClearFatal = reauthCtl.clearFatal
  useEffect(() => {
    if (reauthFatal === 'rate_limited') {
      toast.error('Too many tries — wait a moment and try again.')
      reauthClearFatal()
    } else if (reauthFatal === 'http') {
      toast.error("We couldn't verify your password. Try again.")
      reauthClearFatal()
    }
  }, [reauthFatal, reauthClearFatal, toast])

  async function save<T>(
    key: string,
    value: T,
    version: number,
    setNewVersion: (v: number) => void,
    needsReauth: boolean,
  ): Promise<boolean> {
    if (busy) return false
    setBusy(key)
    try {
      if (needsReauth && !(await reauth())) return false
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value, version }),
      })
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return false
      }
      if (r.status === 409) {
        toast.error('Someone else just saved this in another tab. Reload to see their changes.')
        return false
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return false
      }
      setNewVersion(version + 1)
      toast.success('Saved.')
      return true
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-10 space-y-6">
      <GtmCard
        value={gtm} pristine={gtmP} busy={busy === 'integrations_gtm'}
        onChange={setGtm}
        onSave={() => save('integrations_gtm', gtm, gtmVer, setGtmVer, false)}
        onDiscard={() => setGtm(gtmP)}
      />
      <Ga4Card
        value={ga4} pristine={ga4P} busy={busy === 'integrations_ga4'} gtmOn={gtm.enabled}
        onChange={setGa4}
        onSave={() => save('integrations_ga4', ga4, ga4Ver, setGa4Ver, false)}
        onDiscard={() => setGa4(ga4P)}
      />
      <AdsCard
        value={ads} pristine={adsP} busy={busy === 'integrations_google_ads'}
        onChange={setAds}
        onSave={() => save('integrations_google_ads', ads, adsVer, setAdsVer, false)}
        onDiscard={() => setAds(adsP)}
      />
      <HotjarCard
        value={hj} pristine={hjP} busy={busy === 'integrations_hotjar'}
        onChange={setHj}
        onSave={() => save('integrations_hotjar', hj, hjVer, setHjVer, false)}
        onDiscard={() => setHj(hjP)}
      />
      <SalesIqCard
        value={siq} pristine={siqP} busy={busy === 'integrations_zoho_salesiq'}
        onChange={setSiq}
        onSave={() => save('integrations_zoho_salesiq', siq, siqVer, setSiqVer, false)}
        onDiscard={() => setSiq(siqP)}
      />
      <HubspotCard
        value={hs} pristine={hsP} isSet={hsI.isSet} busy={busy === 'integrations_hubspot'}
        onChange={setHs}
        onSave={() => save('integrations_hubspot', hs, hsVer, setHsVer, true)}
        onDiscard={() => setHs(hsP)}
      />
      <ZohoCrmCard
        value={zc} pristine={zcP} isSet={zcI.isSet} busy={busy === 'integrations_zoho_crm'}
        onChange={setZc}
        onSave={() => save('integrations_zoho_crm', zc, zcVer, setZcVer, true)}
        onDiscard={() => setZc(zcP)}
      />
      <PasswordPromptModal {...reauthCtl.modalProps} />
    </section>
  )
}

// ─────────────────────────── Card shell ───────────────────────────

function CardShell({
  eyebrow, heading, help, dirty, busy, onSave, onDiscard, saveDisabled, children,
}: {
  eyebrow: string
  heading: string
  help?: string
  dirty: boolean
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  saveDisabled?: boolean
  children: React.ReactNode
}) {
  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">{eyebrow}</p>
        <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">{heading}</h2>
        {help && <p className="mt-2 max-w-2xl text-sm text-warm-stone leading-relaxed">{help}</p>}
      </header>
      <div className="mt-6 flex flex-col gap-5">{children}</div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={onSave} disabled={busy || !dirty || saveDisabled}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
            Undo changes
          </Button>
        )}
        {dirty && (
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
            <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
            Unsaved changes
          </span>
        )}
      </div>
    </article>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">{children}</span>
}
function FieldHelp({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 block text-[11px] text-warm-stone/80">{children}</span>
}

// ─────────────────────────── GTM ───────────────────────────

function GtmCard({ value, pristine, busy, onChange, onSave, onDiscard }: {
  value: GtmValue; pristine: GtmValue; busy: boolean
  onChange: (v: GtmValue) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const shapeOk = !value.enabled || (!!value.containerId && /^GTM-[A-Z0-9]+$/.test(value.containerId))
  return (
    <CardShell
      eyebrow="Tag manager"
      heading="Google Tag Manager"
      help="Loads the GTM container snippet on every public page. Use GTM when you want to centralise GA4, Ads, and custom tags in one place."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard} saveDisabled={!shapeOk}
    >
      <Switch label="Inject GTM on public pages" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <label className="block">
        <FieldLabel>Container ID</FieldLabel>
        <Input className="mt-1.5" value={value.containerId ?? ''} maxLength={20} placeholder="GTM-XXXXXXX" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...value, containerId: e.target.value.toUpperCase().trim() || undefined })}
        />
        {!shapeOk && value.containerId && <FieldHelp>Should look like <code>GTM-ABC1234</code>.</FieldHelp>}
      </label>
    </CardShell>
  )
}

// ─────────────────────────── GA4 ───────────────────────────

function Ga4Card({ value, pristine, busy, gtmOn, onChange, onSave, onDiscard }: {
  value: Ga4Value; pristine: Ga4Value; busy: boolean; gtmOn: boolean
  onChange: (v: Ga4Value) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const shapeOk = !value.enabled || (!!value.measurementId && /^G-[A-Z0-9]+$/.test(value.measurementId))
  return (
    <CardShell
      eyebrow="Analytics"
      heading="Google Analytics 4"
      help="Standalone gtag.js loader. If you load GA4 through GTM, flip the toggle below so we don't double-count."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard} saveDisabled={!shapeOk}
    >
      <Switch label="Inject GA4 on public pages" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <label className="block">
        <FieldLabel>Measurement ID</FieldLabel>
        <Input className="mt-1.5" value={value.measurementId ?? ''} maxLength={20} placeholder="G-XXXXXXXXXX" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...value, measurementId: e.target.value.toUpperCase().trim() || undefined })}
        />
        {!shapeOk && value.measurementId && <FieldHelp>Should look like <code>G-ABCDE12345</code>.</FieldHelp>}
      </label>
      <Switch label="GA4 fires through GTM (suppress standalone loader)" checked={value.viaGtm} onChange={(v) => onChange({ ...value, viaGtm: v })} />
      {value.viaGtm && !gtmOn && (
        <p className="rounded-lg bg-copper-50 px-3 py-2 text-xs text-copper-800">GTM is off — GA4 won&rsquo;t fire. Enable GTM above first.</p>
      )}
    </CardShell>
  )
}

// ─────────────────────────── Google Ads ───────────────────────────

function AdsCard({ value, pristine, busy, onChange, onSave, onDiscard }: {
  value: AdsValue; pristine: AdsValue; busy: boolean
  onChange: (v: AdsValue) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const shapeOk = !value.enabled || (!!value.conversionId && /^AW-[0-9]+$/.test(value.conversionId))
  return (
    <CardShell
      eyebrow="Advertising"
      heading="Google Ads"
      help="Loads the Ads gtag and fires a conversion when a lead form succeeds. Shares the gtag.js loader with GA4 to avoid double-loading."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard} saveDisabled={!shapeOk}
    >
      <Switch label="Inject Google Ads" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <label className="block">
        <FieldLabel>Conversion ID</FieldLabel>
        <Input className="mt-1.5" value={value.conversionId ?? ''} maxLength={20} placeholder="AW-1234567890" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...value, conversionId: e.target.value.toUpperCase().trim() || undefined })}
        />
      </label>
      <label className="block">
        <FieldLabel>Default conversion label (optional)</FieldLabel>
        <Input className="mt-1.5" value={value.defaultConversionLabel ?? ''} maxLength={40} placeholder="abc123XYZ" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...value, defaultConversionLabel: e.target.value.trim() || undefined })}
        />
        <FieldHelp>Fired on lead-submit success when set. Leave empty if you only fire conversions from Ads itself.</FieldHelp>
      </label>
    </CardShell>
  )
}

// ─────────────────────────── Hotjar ───────────────────────────

function HotjarCard({ value, pristine, busy, onChange, onSave, onDiscard }: {
  value: HotjarValue; pristine: HotjarValue; busy: boolean
  onChange: (v: HotjarValue) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const shapeOk = !value.enabled || !!value.siteId
  return (
    <CardShell
      eyebrow="Heatmaps"
      heading="Hotjar"
      help="Session recording and heatmaps. Loads the standard IIFE snippet in <head>."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard} saveDisabled={!shapeOk}
    >
      <Switch label="Inject Hotjar on public pages" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <FieldLabel>Site ID</FieldLabel>
          <Input className="mt-1.5" value={value.siteId ?? ''} maxLength={20} placeholder="1234567" spellCheck={false} autoCapitalize="off"
            onChange={(e) => onChange({ ...value, siteId: e.target.value.trim() || undefined })}
          />
        </label>
        <label className="block">
          <FieldLabel>Snippet version</FieldLabel>
          <Input className="mt-1.5" type="number" min={6} max={8}
            value={value.snippetVersion}
            onChange={(e) => onChange({ ...value, snippetVersion: Number(e.target.value) })}
          />
          <FieldHelp>Hotjar&rsquo;s current snippet is 6. Bump only if Hotjar tells you to.</FieldHelp>
        </label>
      </div>
    </CardShell>
  )
}

// ─────────────────────────── SalesIQ ───────────────────────────

function SalesIqCard({ value, pristine, busy, onChange, onSave, onDiscard }: {
  value: SalesIqValue; pristine: SalesIqValue; busy: boolean
  onChange: (v: SalesIqValue) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const shapeOk = !value.enabled || !!value.widgetCode
  return (
    <CardShell
      eyebrow="Live chat"
      heading="Zoho SalesIQ"
      help="Live chat widget on public pages. Paste the widget code from your SalesIQ embed snippet."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard} saveDisabled={!shapeOk}
    >
      <Switch label="Inject SalesIQ widget on public pages" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <label className="block">
        <FieldLabel>Widget code</FieldLabel>
        <Input className="mt-1.5" value={value.widgetCode ?? ''} maxLength={400} placeholder="siq…" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...value, widgetCode: e.target.value.trim() || undefined })}
        />
        <FieldHelp>Find this in your SalesIQ embed code (the value inside <code>widgetcode</code> or in the embed URL).</FieldHelp>
      </label>
      <label className="block">
        <FieldLabel>Region</FieldLabel>
        <select className="mt-1.5 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-300/40"
          value={value.region} onChange={(e) => onChange({ ...value, region: e.target.value as SalesIqValue['region'] })}
        >
          {ZOHO_REGIONS.map((r) => <option key={r} value={r}>zoho.{r}</option>)}
        </select>
      </label>
    </CardShell>
  )
}

// ─────────────────────────── HubSpot ───────────────────────────

function HubspotCard({ value, pristine, isSet, busy, onChange, onSave, onDiscard }: {
  value: HubspotValue; pristine: HubspotValue; isSet: Record<string, boolean>; busy: boolean
  onChange: (v: HubspotValue) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const [showTokenInput, setShowTokenInput] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const toast = useToast()
  const portalOk = !value.enabled || (!!value.portalId && /^[0-9]+$/.test(value.portalId))
  const tokenOk = !value.enabled || isSet.privateAppAccessToken || (!!value.privateAppAccessToken && value.privateAppAccessToken.length >= 20)

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await csrfFetch('/api/admin/integrations/hubspot/test', { method: 'POST' })
      const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null
      if (r.ok && j?.ok) {
        setTestResult('ok')
        toast.success('HubSpot connection works.')
      } else {
        setTestResult(j?.message ?? 'Connection failed.')
        toast.error(j?.message ?? "Couldn't reach HubSpot with these credentials.")
      }
    } finally {
      setTesting(false)
    }
  }

  return (
    <CardShell
      eyebrow="CRM"
      heading="HubSpot"
      help="Send leads to HubSpot via the Forms API and (optionally) mint visitor-attribution cookies with the tracking script. We re-prompt for your password before saving CRM credentials."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard}
      saveDisabled={!portalOk || !tokenOk}
    >
      <Switch label="Enable HubSpot integration" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <Switch label="Inject tracking script (mints hubspotutk cookie for attribution)"
        checked={value.trackingEnabled} onChange={(v) => onChange({ ...value, trackingEnabled: v })}
        disabled={!value.enabled}
      />
      <label className="block">
        <FieldLabel>Portal ID</FieldLabel>
        <Input className="mt-1.5" value={value.portalId ?? ''} maxLength={20} placeholder="1234567" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...value, portalId: e.target.value.trim() || undefined })}
        />
      </label>

      {/* Private App access token — write-only */}
      <div>
        <FieldLabel>Private App access token</FieldLabel>
        {isSet.privateAppAccessToken && !showTokenInput ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-800">
              ✓ Token saved
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowTokenInput(true)}>Replace token</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...value, privateAppAccessToken: null as unknown as string })}>
              Clear stored token
            </Button>
          </div>
        ) : (
          <Input className="mt-1.5" type="password" value={value.privateAppAccessToken ?? ''} maxLength={200}
            placeholder="pat-na1-…" spellCheck={false} autoCapitalize="off"
            onChange={(e) => onChange({ ...value, privateAppAccessToken: e.target.value || undefined })}
          />
        )}
        <FieldHelp>Generate in HubSpot → Settings → Integrations → Private Apps. Required scopes: <code>crm.objects.contacts.write</code>, <code>forms</code>.</FieldHelp>
      </div>

      {/* Test connection */}
      <div className="rounded-xl bg-cream-100/60 p-4 text-sm">
        <p className="font-semibold text-near-black">Test connection</p>
        <p className="mt-1 text-warm-stone">Pings <code>/crm/v3/properties/contacts</code> with the stored token.</p>
        <Button type="button" size="sm" variant="ghost" className="mt-3" onClick={testConnection} disabled={testing || !isSet.privateAppAccessToken}>
          {testing ? 'Testing…' : testResult === 'ok' ? '✓ Verified — re-test' : 'Test connection'}
        </Button>
        {testResult && testResult !== 'ok' && <p className="mt-2 text-xs text-red-700">{testResult}</p>}
      </div>

      {/* Per-source destination map */}
      <DestinationsEditor
        provider="hubspot"
        value={value.formSourceMap ?? {}}
        onChange={(m) => onChange({ ...value, formSourceMap: Object.keys(m).length === 0 ? undefined : m })}
      />
    </CardShell>
  )
}

// ─────────────────────────── Zoho CRM ───────────────────────────

function ZohoCrmCard({ value, pristine, isSet, busy, onChange, onSave, onDiscard }: {
  value: ZohoCrmValue; pristine: ZohoCrmValue; isSet: Record<string, boolean>; busy: boolean
  onChange: (v: ZohoCrmValue) => void; onSave: () => void; onDiscard: () => void
}) {
  const dirty = !structuralEqual(value, pristine)
  const [showOauthInputs, setShowOauthInputs] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const toast = useToast()
  const oauthOk = value.authMode !== 'oauth' || !value.enabled ||
    ((isSet.oauthClientId || !!value.oauthClientId) &&
     (isSet.oauthClientSecret || !!value.oauthClientSecret) &&
     (isSet.oauthRefreshToken || !!value.oauthRefreshToken))

  async function testConnection() {
    setTesting(true); setTestResult(null)
    try {
      const r = await csrfFetch('/api/admin/integrations/zoho/test', { method: 'POST' })
      const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null
      if (r.ok && j?.ok) { setTestResult('ok'); toast.success('Zoho connection works.') }
      else { setTestResult(j?.message ?? 'Connection failed.'); toast.error(j?.message ?? "Couldn't reach Zoho with these credentials.") }
    } finally { setTesting(false) }
  }

  return (
    <CardShell
      eyebrow="CRM"
      heading="Zoho CRM"
      help="Send leads to Zoho CRM via webform tokens (simple, per-form) or OAuth v8 (full REST, triggers workflows). We re-prompt for your password before saving CRM credentials."
      dirty={dirty} busy={busy} onSave={onSave} onDiscard={onDiscard}
      saveDisabled={!oauthOk}
    >
      <Switch label="Enable Zoho CRM integration" checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />

      <label className="block">
        <FieldLabel>Region</FieldLabel>
        <select className="mt-1.5 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-300/40"
          value={value.region} onChange={(e) => onChange({ ...value, region: e.target.value as ZohoCrmValue['region'] })}
        >
          {ZOHO_REGIONS.map((r) => <option key={r} value={r}>zoho.{r}</option>)}
        </select>
      </label>

      <div>
        <FieldLabel>Auth mode</FieldLabel>
        <div className="mt-1.5 flex gap-2">
          {(['webform', 'oauth'] as const).map((m) => (
            <button key={m} type="button"
              onClick={() => onChange({ ...value, authMode: m })}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${value.authMode === m ? 'bg-near-black text-cream-50' : 'bg-cream-50 text-near-black border border-warm-stone/30 hover:bg-cream-100'}`}
            >
              {m === 'webform' ? 'Webform (simpler)' : 'OAuth (richer)'}
            </button>
          ))}
        </div>
        <FieldHelp>
          Webform: paste each form&rsquo;s <code>xnQsjsdp</code> token per source below. OAuth: paste Client ID/Secret + Refresh Token once; we rotate access tokens server-side.
        </FieldHelp>
      </div>

      {value.authMode === 'oauth' && (
        <div className="rounded-xl bg-cream-100/40 p-4 space-y-3">
          <p className="font-semibold text-near-black text-sm">OAuth credentials</p>
          {isSet.oauthClientId && isSet.oauthClientSecret && isSet.oauthRefreshToken && !showOauthInputs ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-800">
                ✓ OAuth credentials saved
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setShowOauthInputs(true)}>Replace credentials</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange({
                ...value,
                oauthClientId: null as unknown as string,
                oauthClientSecret: null as unknown as string,
                oauthRefreshToken: null as unknown as string,
              })}>Clear all OAuth credentials</Button>
            </div>
          ) : (
            <>
              <label className="block">
                <FieldLabel>OAuth Client ID</FieldLabel>
                <Input className="mt-1.5" type="password" maxLength={200} value={value.oauthClientId ?? ''} spellCheck={false} autoCapitalize="off"
                  onChange={(e) => onChange({ ...value, oauthClientId: e.target.value || undefined })}
                />
              </label>
              <label className="block">
                <FieldLabel>OAuth Client Secret</FieldLabel>
                <Input className="mt-1.5" type="password" maxLength={200} value={value.oauthClientSecret ?? ''} spellCheck={false} autoCapitalize="off"
                  onChange={(e) => onChange({ ...value, oauthClientSecret: e.target.value || undefined })}
                />
              </label>
              <label className="block">
                <FieldLabel>OAuth Refresh Token</FieldLabel>
                <Input className="mt-1.5" type="password" maxLength={400} value={value.oauthRefreshToken ?? ''} spellCheck={false} autoCapitalize="off"
                  onChange={(e) => onChange({ ...value, oauthRefreshToken: e.target.value || undefined })}
                />
              </label>
            </>
          )}
        </div>
      )}

      {/* Test connection */}
      <div className="rounded-xl bg-cream-100/60 p-4 text-sm">
        <p className="font-semibold text-near-black">Test connection</p>
        <p className="mt-1 text-warm-stone">
          {value.authMode === 'oauth' ? <>Pings <code>/crm/v8/users?type=CurrentUser</code>.</> : <>Webform mode has no API to test; success on first form submit.</>}
        </p>
        <Button type="button" size="sm" variant="ghost" className="mt-3" onClick={testConnection}
          disabled={testing || value.authMode !== 'oauth' || !(isSet.oauthClientId && isSet.oauthClientSecret && isSet.oauthRefreshToken)}
        >
          {testing ? 'Testing…' : testResult === 'ok' ? '✓ Verified — re-test' : 'Test connection'}
        </Button>
        {testResult && testResult !== 'ok' && <p className="mt-2 text-xs text-red-700">{testResult}</p>}
      </div>

      <DestinationsEditor
        provider="zoho"
        value={value.formSourceMap ?? {}}
        onChange={(m) => onChange({ ...value, formSourceMap: Object.keys(m).length === 0 ? undefined : m })}
      />
    </CardShell>
  )
}

// ─────────────────────────── Destinations editor ───────────────────────────
// Per-source destination map for non-block lead endpoints. The
// contact_form BLOCK widget overrides per-instance via its own
// crmDestinations on the block tree (configured in the edit drawer).
// This card lets the operator wire newsletter / brochure / inquiry
// (and a default contact mapping) to a CRM destination.

function DestinationsEditor<P extends 'hubspot' | 'zoho'>({
  provider, value, onChange,
}: {
  provider: P
  value: Record<string, HubspotDestination | ZohoDestination>
  onChange: (v: Record<string, HubspotDestination | ZohoDestination>) => void
}) {
  const sources = HUBSPOT_LEAD_SOURCES
  return (
    <div className="rounded-xl bg-cream-100/40 p-4">
      <p className="font-semibold text-near-black text-sm">Per-source destinations</p>
      <p className="mt-1 text-xs text-warm-stone">
        Where each lead source dispatches when the local DB write succeeds.{' '}
        <em>contact</em> here is the fallback when a contact_form block doesn&rsquo;t set its own destination in the edit drawer.
      </p>
      <div className="mt-3 space-y-3">
        {sources.map((s) => {
          const dest = value[s]
          return (
            <details key={s} className="rounded-lg bg-cream-50/80 p-3" open={!!dest}>
              <summary className="cursor-pointer text-sm font-semibold text-near-black">
                {s} {dest && <span className="ml-2 text-xs font-medium text-emerald-700">configured</span>}
              </summary>
              <div className="mt-3 space-y-2">
                {provider === 'hubspot' ? (
                  <HubspotDestinationFields source={s}
                    value={(dest as HubspotDestination | undefined) ?? null}
                    onChange={(d) => {
                      const next = { ...value }
                      if (d === null) delete next[s]
                      else next[s] = d
                      onChange(next)
                    }}
                  />
                ) : (
                  <ZohoDestinationFields source={s}
                    value={(dest as ZohoDestination | undefined) ?? null}
                    onChange={(d) => {
                      const next = { ...value }
                      if (d === null) delete next[s]
                      else next[s] = d
                      onChange(next)
                    }}
                  />
                )}
              </div>
            </details>
          )
        })}
      </div>
    </div>
  )
}

function FieldMapEditor({
  source, fieldMap, onChange,
}: {
  source: (typeof HUBSPOT_LEAD_SOURCES)[number]
  fieldMap: Record<string, string>
  onChange: (m: Record<string, string>) => void
}) {
  const cavecmsFields = SOURCE_FIELDS[source]
  return (
    <div className="space-y-1.5">
      <FieldLabel>Field map (CaveCMS → CRM)</FieldLabel>
      <div className="space-y-1.5">
        {cavecmsFields.map((f) => (
          <div key={f} className="flex items-center gap-2">
            <code className="w-32 shrink-0 text-xs font-mono text-warm-stone">{f}</code>
            <span className="text-warm-stone/50">→</span>
            <Input value={fieldMap[f] ?? ''} maxLength={120} placeholder="crm_field_name" spellCheck={false} autoCapitalize="off"
              onChange={(e) => {
                const v = e.target.value.trim()
                const next = { ...fieldMap }
                if (v) next[f] = v
                else delete next[f]
                onChange(next)
              }}
            />
          </div>
        ))}
      </div>
      <FieldHelp>Leave a row blank to skip that field. Unmapped fields aren&rsquo;t sent to the CRM.</FieldHelp>
    </div>
  )
}

function HubspotDestinationFields({ source, value, onChange }: {
  source: (typeof HUBSPOT_LEAD_SOURCES)[number]
  value: HubspotDestination | null
  onChange: (d: HubspotDestination | null) => void
}) {
  const v = value ?? { formId: '', fieldMap: {} as Record<string, string> }
  return (
    <>
      <label className="block">
        <FieldLabel>HubSpot form GUID</FieldLabel>
        <Input className="mt-1.5" value={v.formId} maxLength={40} placeholder="abcd1234-…" spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...v, formId: e.target.value.trim() })}
        />
      </label>
      <FieldMapEditor source={source} fieldMap={v.fieldMap} onChange={(m) => onChange({ ...v, fieldMap: m })} />
      {value && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>Remove destination for {source}</Button>
      )}
    </>
  )
}

function ZohoDestinationFields({ source, value, onChange }: {
  source: (typeof HUBSPOT_LEAD_SOURCES)[number]
  value: ZohoDestination | null
  onChange: (d: ZohoDestination | null) => void
}) {
  const v = value ?? {
    module: 'Leads' as const,
    mode: 'webform' as const,
    fieldMap: {} as Record<string, string>,
  }
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <FieldLabel>Module</FieldLabel>
          <select className="mt-1.5 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-300/40"
            value={v.module} onChange={(e) => onChange({ ...v, module: e.target.value as ZohoDestination['module'] })}
          >
            {ZOHO_MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Mode</FieldLabel>
          <select className="mt-1.5 w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-300/40"
            value={v.mode} onChange={(e) => onChange({ ...v, mode: e.target.value as ZohoDestination['mode'] })}
          >
            <option value="webform">Webform</option>
            <option value="oauth">OAuth (uses account creds)</option>
          </select>
        </label>
      </div>
      {v.mode === 'webform' && (
        <label className="block">
          <FieldLabel>xnQsjsdp token (per-form)</FieldLabel>
          <Input className="mt-1.5" type="password" value={v.webformAuthToken ?? ''} maxLength={200} spellCheck={false} autoCapitalize="off"
            onChange={(e) => onChange({ ...v, webformAuthToken: e.target.value || undefined })}
          />
          <FieldHelp>Copy the <code>xnQsjsdp</code> value from your Zoho form&rsquo;s HTML.</FieldHelp>
        </label>
      )}
      <label className="block">
        <FieldLabel>Assignment rule ID (optional)</FieldLabel>
        <Input className="mt-1.5" value={v.assignmentRuleId ?? ''} maxLength={40} spellCheck={false} autoCapitalize="off"
          onChange={(e) => onChange({ ...v, assignmentRuleId: e.target.value.trim() || undefined })}
        />
      </label>
      <FieldMapEditor source={source} fieldMap={v.fieldMap} onChange={(m) => onChange({ ...v, fieldMap: m })} />
      {value && (
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>Remove destination for {source}</Button>
      )}
    </>
  )
}
