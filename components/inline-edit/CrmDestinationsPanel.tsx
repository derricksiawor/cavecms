'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

// Per-block CRM destination editor. Lives on the EditDrawer's 'crm'
// tab when the active widget's schema declares a `crmDestinations`
// field (currently: contact_form). Edits a draft array and bubbles
// it up via onChange — actual save happens through the existing
// block PATCH route when the operator clicks Save in the drawer.
//
// Reads the operator's available HubSpot forms / Zoho modules via
// the admin integration API routes. When neither integration is
// connected, surfaces a deep-link to /admin/settings/integrations
// instead of an empty picker.

const CAVECMS_FIELDS_BY_SOURCE: Record<string, string[]> = {
  contact: ['name', 'email', 'phone', 'message', 'enquiry_type', 'tour_date', 'tour_time', 'brochure_project'],
}
const ZOHO_MODULES = ['Leads', 'Contacts', 'Deals'] as const

type ProviderKey = 'hubspot' | 'zoho'

interface HubspotDest {
  provider: 'hubspot'
  formId: string
  fieldMap: Record<string, string>
  listIds?: number[]
}
interface ZohoDest {
  provider: 'zoho'
  module: (typeof ZOHO_MODULES)[number]
  mode: 'webform' | 'oauth'
  fieldMap: Record<string, string>
  assignmentRuleId?: string
}
type Destination = HubspotDest | ZohoDest

interface HubspotFormSummary { id: string; name: string }
interface HubspotFormField { name: string; label: string; fieldType: string }

interface Props {
  /** Source key — for contact_form blocks this is 'contact'. Drives
   *  the left column of the field-map UI. */
  cavecmsSource?: string
  destinations: Destination[]
  onChange: (next: Destination[]) => void
}

export function CrmDestinationsPanel({ cavecmsSource = 'contact', destinations, onChange }: Props) {
  const cavecmsFields = CAVECMS_FIELDS_BY_SOURCE[cavecmsSource] ?? CAVECMS_FIELDS_BY_SOURCE.contact ?? []

  // Fetch operator's HubSpot forms once on mount. Empty list means
  // either HubSpot isn't connected OR the operator has no forms —
  // the UI distinguishes via the response's `message` field.
  const [hubspotForms, setHubspotForms] = useState<HubspotFormSummary[] | null>(null)
  const [hubspotMessage, setHubspotMessage] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const r = await fetch('/api/admin/integrations/hubspot/forms', { cache: 'no-store', signal: controller.signal })
        if (controller.signal.aborted) return
        const j = (await r.json().catch(() => null)) as { ok?: boolean; forms?: HubspotFormSummary[]; message?: string } | null
        if (controller.signal.aborted) return
        if (j?.ok) setHubspotForms(j.forms ?? [])
        else { setHubspotForms([]); setHubspotMessage(j?.message ?? null) }
      } catch {
        // Aborted by cleanup — drop silently.
      }
    })()
    return () => controller.abort()
  }, [])

  function addDestination(provider: ProviderKey) {
    if (provider === 'hubspot') {
      onChange([...destinations, { provider: 'hubspot', formId: '', fieldMap: {} }])
    } else {
      onChange([...destinations, { provider: 'zoho', module: 'Leads', mode: 'webform', fieldMap: {} }])
    }
  }

  function updateAt(idx: number, next: Destination) {
    const out = [...destinations]
    out[idx] = next
    onChange(out)
  }

  function removeAt(idx: number) {
    onChange(destinations.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-5 text-cream-50">
      <div className="rounded-2xl border border-cream-50/12 bg-cream-50/[0.03] p-5">
        <h3 className="font-serif text-lg font-bold tracking-tight text-cream-50">CRM destinations</h3>
        <p className="mt-2 text-sm leading-relaxed text-cream-50/70">
          Where this form&rsquo;s submissions go in addition to your local leads inbox.
          You can ship a single submission to multiple CRMs (up to 4). Configure provider
          credentials in{' '}
          <Link className="underline text-copper-300 hover:text-copper-200" href="/admin/settings/integrations">
            Settings → Integrations
          </Link>.
        </p>
        {hubspotForms === null && (
          <p className="mt-3 text-xs text-cream-50/50">Loading HubSpot forms…</p>
        )}
        {hubspotForms?.length === 0 && hubspotMessage && (
          <p className="mt-3 text-xs text-copper-300">{hubspotMessage}</p>
        )}
      </div>

      {destinations.length === 0 && (
        <p className="rounded-xl bg-cream-50/[0.04] p-4 text-sm text-cream-50/60">
          No CRM destinations configured. This form&rsquo;s submissions will write to your local leads inbox only.
        </p>
      )}

      <div className="space-y-4">
        {destinations.map((d, i) => (
          <div key={i} className="rounded-2xl border border-cream-50/12 bg-cream-50/[0.04] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-copper-300">
                {d.provider === 'hubspot' ? 'HubSpot' : 'Zoho CRM'}
              </p>
              <Button type="button" size="sm" variant="ghost" onClick={() => removeAt(i)}>Remove</Button>
            </div>
            {d.provider === 'hubspot' ? (
              <HubspotDestEditor
                value={d}
                forms={hubspotForms ?? []}
                cavecmsFields={cavecmsFields}
                onChange={(next) => updateAt(i, next)}
              />
            ) : (
              <ZohoDestEditor
                value={d}
                cavecmsFields={cavecmsFields}
                onChange={(next) => updateAt(i, next)}
              />
            )}
          </div>
        ))}
      </div>

      {destinations.length < 4 && (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => addDestination('hubspot')}>+ Add HubSpot</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => addDestination('zoho')}>+ Add Zoho</Button>
        </div>
      )}
    </div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50/55">{children}</span>
}

function HubspotDestEditor({
  value, forms, cavecmsFields, onChange,
}: {
  value: HubspotDest
  forms: HubspotFormSummary[]
  cavecmsFields: string[]
  onChange: (v: HubspotDest) => void
}) {
  const [fields, setFields] = useState<HubspotFormField[]>([])
  const [loadingFields, setLoadingFields] = useState(false)
  useEffect(() => {
    if (!value.formId) { setFields([]); return }
    const controller = new AbortController()
    setLoadingFields(true)
    void (async () => {
      try {
        const r = await fetch(`/api/admin/integrations/hubspot/forms/${encodeURIComponent(value.formId)}/fields`, { cache: 'no-store', signal: controller.signal })
        if (controller.signal.aborted) return
        const j = (await r.json().catch(() => null)) as { ok?: boolean; fields?: HubspotFormField[] } | null
        if (controller.signal.aborted) return
        setFields(j?.ok ? (j.fields ?? []) : [])
        setLoadingFields(false)
      } catch {
        // Aborted by cleanup.
      }
    })()
    return () => controller.abort()
  }, [value.formId])

  return (
    <>
      <label className="block">
        <FieldLabel>HubSpot form</FieldLabel>
        <select
          className="mt-1.5 w-full rounded-xl border border-cream-50/15 bg-near-black/40 px-4 py-3 text-sm text-cream-50 focus:outline-none focus:ring-2 focus:ring-copper-400/40"
          value={value.formId}
          onChange={(e) => onChange({ ...value, formId: e.target.value })}
        >
          <option value="">— pick a form —</option>
          {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      <div>
        <FieldLabel>Field map (CaveCMS → HubSpot)</FieldLabel>
        <div className="mt-2 space-y-1.5">
          {cavecmsFields.map((cavecms) => (
            <div key={cavecms} className="flex items-center gap-2">
              <code className="w-32 shrink-0 text-xs font-mono text-cream-50/60">{cavecms}</code>
              <span className="text-cream-50/30">→</span>
              {fields.length > 0 ? (
                <select
                  className="flex-1 rounded-xl border border-cream-50/15 bg-near-black/40 px-3 py-2 text-sm text-cream-50 focus:outline-none focus:ring-2 focus:ring-copper-400/40"
                  value={value.fieldMap[cavecms] ?? ''}
                  onChange={(e) => {
                    const next = { ...value.fieldMap }
                    if (e.target.value) next[cavecms] = e.target.value
                    else delete next[cavecms]
                    onChange({ ...value, fieldMap: next })
                  }}
                >
                  <option value="">— skip —</option>
                  {fields.map((f) => <option key={f.name} value={f.name}>{f.label} ({f.name})</option>)}
                </select>
              ) : (
                <Input
                  className="flex-1"
                  value={value.fieldMap[cavecms] ?? ''}
                  placeholder={loadingFields ? 'loading…' : 'hubspot_property_name'}
                  onChange={(e) => {
                    const next = { ...value.fieldMap }
                    if (e.target.value.trim()) next[cavecms] = e.target.value.trim()
                    else delete next[cavecms]
                    onChange({ ...value, fieldMap: next })
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function ZohoDestEditor({
  value, cavecmsFields, onChange,
}: {
  value: ZohoDest
  cavecmsFields: string[]
  onChange: (v: ZohoDest) => void
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <FieldLabel>Module</FieldLabel>
          <select
            className="mt-1.5 w-full rounded-xl border border-cream-50/15 bg-near-black/40 px-4 py-3 text-sm text-cream-50 focus:outline-none focus:ring-2 focus:ring-copper-400/40"
            value={value.module}
            onChange={(e) => onChange({ ...value, module: e.target.value as ZohoDest['module'] })}
          >
            {ZOHO_MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="block">
          <FieldLabel>Mode</FieldLabel>
          <select
            className="mt-1.5 w-full rounded-xl border border-cream-50/15 bg-near-black/40 px-4 py-3 text-sm text-cream-50 focus:outline-none focus:ring-2 focus:ring-copper-400/40"
            value={value.mode}
            onChange={(e) => onChange({ ...value, mode: e.target.value as ZohoDest['mode'] })}
          >
            <option value="webform">Webform</option>
            <option value="oauth">OAuth (uses account creds)</option>
          </select>
        </label>
      </div>
      {value.mode === 'webform' && (
        <p className="rounded-lg bg-cream-50/[0.04] px-3 py-2 text-xs text-cream-50/60">
          Webform mode uses the <code>xnQsjsdp</code> token configured for <em>contact</em>{' '}
          in{' '}
          <Link className="underline text-copper-300 hover:text-copper-200" href="/admin/settings/integrations">
            Settings → Integrations → Zoho CRM
          </Link>.
          Block-level webform tokens aren&rsquo;t saved here so they can&rsquo;t bypass your password gate.
        </p>
      )}
      <label className="block">
        <FieldLabel>Assignment rule ID (optional)</FieldLabel>
        <Input className="mt-1.5"
          value={value.assignmentRuleId ?? ''}
          onChange={(e) => onChange({ ...value, assignmentRuleId: e.target.value.trim() || undefined })}
        />
      </label>
      <div>
        <FieldLabel>Field map (CaveCMS → Zoho)</FieldLabel>
        <div className="mt-2 space-y-1.5">
          {cavecmsFields.map((cavecms) => (
            <div key={cavecms} className="flex items-center gap-2">
              <code className="w-32 shrink-0 text-xs font-mono text-cream-50/60">{cavecms}</code>
              <span className="text-cream-50/30">→</span>
              <Input className="flex-1"
                value={value.fieldMap[cavecms] ?? ''}
                placeholder="Zoho_API_Name"
                onChange={(e) => {
                  const next = { ...value.fieldMap }
                  if (e.target.value.trim()) next[cavecms] = e.target.value.trim()
                  else delete next[cavecms]
                  onChange({ ...value, fieldMap: next })
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
