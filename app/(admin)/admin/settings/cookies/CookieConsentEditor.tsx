'use client'

import { useState } from 'react'
import { Plus, Trash2, Lock } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import type { CookieConsentConfig } from '@/lib/cms/settings-registry'

type Category = CookieConsentConfig['categories'][number]

const POSITIONS: Array<{ value: CookieConsentConfig['position']; label: string }> = [
  { value: 'bottom-left', label: 'Bottom left (card)' },
  { value: 'bottom-right', label: 'Bottom right (card)' },
  { value: 'bottom', label: 'Bottom bar (full width)' },
  { value: 'center', label: 'Center (modal)' },
]
const THEMES: Array<{ value: CookieConsentConfig['theme']; label: string }> = [
  { value: 'auto', label: 'Auto (dark)' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const inputCls =
  'mt-1.5 w-full rounded-lg border border-warm-stone/25 bg-white px-3 py-2 text-sm text-near-black focus:border-copper-400 focus:outline-none'
const labelCls = 'text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone'

export function CookieConsentEditor({
  initial,
}: {
  initial: { value: CookieConsentConfig; version: number }
}) {
  const toast = useToast()
  const [cfg, setCfg] = useState<CookieConsentConfig>(initial.value)
  const [version, setVersion] = useState(initial.version)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof CookieConsentConfig>(k: K, v: CookieConsentConfig[K]) =>
    setCfg((c) => ({ ...c, [k]: v }))
  const setBtn = (k: keyof CookieConsentConfig['buttons'], v: string) =>
    setCfg((c) => ({ ...c, buttons: { ...c.buttons, [k]: v } }))
  const setCat = (i: number, patch: Partial<Category>) =>
    setCfg((c) => ({ ...c, categories: c.categories.map((cat, idx) => (idx === i ? { ...cat, ...patch } : cat)) }))
  const addCat = () =>
    setCfg((c) =>
      c.categories.length >= 8
        ? c
        : { ...c, categories: [...c.categories, { key: `cat_${c.categories.length}`, label: 'New category', description: '', required: false }] },
    )
  const removeCat = (i: number) =>
    setCfg((c) => ({ ...c, categories: c.categories.filter((_, idx) => idx !== i) }))

  async function save() {
    // Client-side guard mirroring the server schema so the operator gets a
    // friendly message instead of a raw 400.
    if (!cfg.categories.some((c) => c.required)) {
      toast.error('Keep at least one “always on” category (the strictly-necessary one).')
      return
    }
    const keys = cfg.categories.map((c) => c.key)
    if (new Set(keys).size !== keys.length) {
      toast.error('Two categories share the same key — make each key unique.')
      return
    }
    if (cfg.categories.some((c) => !/^[a-z][a-z0-9_]{0,23}$/.test(c.key))) {
      toast.error('Category keys must be lowercase letters/digits/underscore, starting with a letter.')
      return
    }
    setSaving(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'cookie_consent', value: cfg, version }),
      })
      if (!r.ok) {
        toast.error("That didn't save. Check the fields and try again.")
        return
      }
      const data = (await r.json().catch(() => null)) as { version?: number } | null
      if (typeof data?.version === 'number') setVersion(data.version)
      toast.success('Cookie consent saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-10 space-y-8">
      {/* Enable */}
      <section className="rounded-3xl border border-warm-stone/20 bg-cream-50/40 p-6 sm:p-8">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="block font-serif text-xl font-bold tracking-tight text-near-black">Show the consent banner</span>
            <span className="mt-1 block text-sm text-warm-stone">Turn the whole feature on or off. Off = no banner, zero bytes on every page.</span>
          </span>
          <input type="checkbox" className="h-5 w-5 accent-copper-500" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        </label>
      </section>

      {/* Copy */}
      <section className="rounded-3xl border border-warm-stone/20 bg-cream-50/40 p-6 sm:p-8">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">Wording</h2>
        <div className="mt-5 space-y-4">
          <label className="block">
            <span className={labelCls}>Title</span>
            <input className={inputCls} value={cfg.title} maxLength={120} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Message</span>
            <textarea className={`${inputCls} min-h-[88px] resize-y`} value={cfg.message} maxLength={600} onChange={(e) => set('message', e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Privacy policy link</span>
            <input className={inputCls} value={cfg.policyUrl} placeholder="/privacy" onChange={(e) => set('policyUrl', e.target.value)} />
          </label>
        </div>
      </section>

      {/* Appearance */}
      <section className="rounded-3xl border border-warm-stone/20 bg-cream-50/40 p-6 sm:p-8">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">Appearance</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>Position</span>
            <select className={inputCls} value={cfg.position} onChange={(e) => set('position', e.target.value as CookieConsentConfig['position'])}>
              {POSITIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Theme</span>
            <select className={inputCls} value={cfg.theme} onChange={(e) => set('theme', e.target.value as CookieConsentConfig['theme'])}>
              {THEMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
        </div>
      </section>

      {/* Categories */}
      <section className="rounded-3xl border border-warm-stone/20 bg-cream-50/40 p-6 sm:p-8">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">Cookie categories</h2>
        <p className="mt-2 max-w-2xl text-sm text-warm-stone">
          Each category gets its own toggle in the banner’s Customise view. The
          “always on” category (strictly necessary) can’t be turned off by
          visitors. Well-known keys <code>analytics</code>, <code>marketing</code>,
          <code> preferences</code> map to Google Consent Mode signals automatically.
        </p>
        <div className="mt-5 space-y-3">
          {cfg.categories.map((cat, i) => {
            // Lock ONLY the canonical necessary category (first row, or key
            // 'necessary') — it can't be un-required or removed. Every OTHER
            // category keeps an editable "Always on" toggle + a delete button,
            // so an operator who marks one required can always reverse it.
            const locked = i === 0 || cat.key === 'necessary'
            return (
            <div key={i} className="rounded-2xl border border-warm-stone/20 bg-white p-4">
              <div className="grid gap-3 sm:grid-cols-[140px_1fr_auto]">
                <label className="block">
                  <span className={labelCls}>Key</span>
                  <input className={`${inputCls} font-mono`} value={cat.key} maxLength={24} disabled={locked} onChange={(e) => setCat(i, { key: e.target.value })} />
                </label>
                <label className="block">
                  <span className={labelCls}>Label</span>
                  <input className={inputCls} value={cat.label} maxLength={48} onChange={(e) => setCat(i, { label: e.target.value })} />
                </label>
                <div className="flex items-end gap-2 pb-1">
                  <label className="flex items-center gap-1.5 text-xs text-warm-stone">
                    <input type="checkbox" className="h-4 w-4 accent-copper-500" checked={cat.required} disabled={locked} onChange={(e) => setCat(i, { required: e.target.checked })} />
                    Always on
                  </label>
                  {locked ? (
                    <span className="rounded-md p-2 text-warm-stone/50" title="The necessary category can't be removed"><Lock size={15} /></span>
                  ) : (
                    <button type="button" onClick={() => removeCat(i)} aria-label="Remove category" className="rounded-md p-2 text-warm-stone transition-colors hover:text-red-500"><Trash2 size={15} /></button>
                  )}
                </div>
              </div>
              <label className="mt-3 block">
                <span className={labelCls}>Description</span>
                <textarea className={`${inputCls} min-h-[56px] resize-y`} value={cat.description} maxLength={300} onChange={(e) => setCat(i, { description: e.target.value })} />
              </label>
            </div>
            )
          })}
        </div>
        {cfg.categories.length < 8 && (
          <button type="button" onClick={addCat} className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-warm-stone/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400">
            <Plus size={13} /> Add category
          </button>
        )}
      </section>

      {/* Buttons + behaviour */}
      <section className="rounded-3xl border border-warm-stone/20 bg-cream-50/40 p-6 sm:p-8">
        <h2 className="font-serif text-xl font-bold tracking-tight text-near-black">Buttons &amp; behaviour</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block"><span className={labelCls}>“Accept all” label</span><input className={inputCls} value={cfg.buttons.allowAll} maxLength={40} onChange={(e) => setBtn('allowAll', e.target.value)} /></label>
          <label className="block"><span className={labelCls}>“Reject all” label</span><input className={inputCls} value={cfg.buttons.rejectAll} maxLength={40} onChange={(e) => setBtn('rejectAll', e.target.value)} /></label>
          <label className="block"><span className={labelCls}>“Customise” label</span><input className={inputCls} value={cfg.buttons.customize} maxLength={40} onChange={(e) => setBtn('customize', e.target.value)} /></label>
          <label className="block"><span className={labelCls}>“Allow selected” label</span><input className={inputCls} value={cfg.buttons.save} maxLength={40} onChange={(e) => setBtn('save', e.target.value)} /></label>
        </div>
        <div className="mt-5 space-y-4">
          <label className="flex items-center justify-between gap-4">
            <span><span className="block text-sm font-semibold text-near-black">Google Consent Mode v2</span><span className="mt-0.5 block text-xs text-warm-stone">Gate Google Analytics / Ads / GTM tags by consent (recommended).</span></span>
            <input type="checkbox" className="h-5 w-5 accent-copper-500" checked={cfg.googleConsentMode} onChange={(e) => set('googleConsentMode', e.target.checked)} />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span><span className="block text-sm font-semibold text-near-black">Footer “Cookie preferences” link</span><span className="mt-0.5 block text-xs text-warm-stone">Lets visitors reopen the banner anytime from the footer.</span></span>
            <input type="checkbox" className="h-5 w-5 accent-copper-500" checked={cfg.showReopenLink} onChange={(e) => set('showReopenLink', e.target.checked)} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block"><span className={labelCls}>Reopen-link label</span><input className={inputCls} value={cfg.reopenLabel} maxLength={40} onChange={(e) => set('reopenLabel', e.target.value)} /></label>
            <label className="block">
              <span className={labelCls}>Consent version</span>
              <input type="number" className={inputCls} value={cfg.consentVersion} min={1} max={99999} onChange={(e) => set('consentVersion', Math.max(1, Math.min(99999, Number(e.target.value) || 1)))} />
              <span className="mt-1 block text-[11px] text-warm-stone/80">Bump this to re-ask every visitor (e.g. after changing your policy).</span>
            </label>
          </div>
        </div>
      </section>

      <div className="sticky bottom-4 flex justify-end">
        <button type="button" onClick={save} disabled={saving} className="inline-flex items-center rounded-full bg-near-black px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-cream-50 shadow-lg transition-colors hover:bg-copper-700 disabled:opacity-50">
          {saving ? 'Saving…' : 'Save cookie settings'}
        </button>
      </div>
    </div>
  )
}
