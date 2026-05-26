'use client'
import { useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/inline-edit/Switch'
import { ZodForm } from '@/components/inline-edit/ZodForm'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { MOBILE_CTA_ICONS } from '@/lib/cms/mobileCtaIcons'
import {
  Phone, MessageCircle, Mail, Download, FileDown, MapPin,
  Calendar, CalendarClock,
  ShoppingBag, ShoppingCart, CreditCard,
  ArrowRight, ExternalLink, Sparkles,
  type LucideIcon,
} from 'lucide-react'

// Mirror of the renderer's ICON_MAP (components/MobileCtaBar.tsx).
// Kept inline so the admin picker doesn't have to import from a
// client-mounted bundle the picker can directly render against.
const ICON_PREVIEW_MAP: Record<(typeof MOBILE_CTA_ICONS)[number], LucideIcon> = {
  Phone, MessageCircle, Mail, Download, FileDown, MapPin,
  Calendar, CalendarClock,
  ShoppingBag, ShoppingCart, CreditCard,
  ArrowRight, ExternalLink, Sparkles,
}
import {
  SETTINGS_SHAPES,
  SETTINGS_LABELS,
  SETTINGS_HELP,
  SETTINGS_ROOT_KIND,
} from '@/lib/cms/settings-shapes'

interface Row {
  key: string
  value: unknown
  version: number
  updated_at: Date | string
}

interface Draft extends Row {
  form: Record<string, unknown>
  pristine: Record<string, unknown>
}

function wrap(key: string, value: unknown): Record<string, unknown> {
  if (SETTINGS_ROOT_KIND[key] === 'array') {
    // Coerce to [] if the DB row holds a non-array (a setting saved
    // under an older shape, a hand-edited row, etc.). The operator
    // can then add fresh entries and the Zod schema will validate on
    // save.
    return { __root: Array.isArray(value) ? value : [] }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  // Same defence for object-kind settings: if the DB row is null or
  // any other non-object scalar, hand the form an empty record.
  return {}
}

function unwrap(key: string, form: Record<string, unknown>): unknown {
  return SETTINGS_ROOT_KIND[key] === 'array' ? form.__root : form
}

// Visual settings editor. One card per `settings.key`; shape comes
// from SETTINGS_SHAPES which mirrors settings-registry.ts (the Zod
// schema is the trust boundary — server validates on save). No JSON
// fallback anywhere — every field has a premium widget.
export function SettingsForm({ initial }: { initial: Row[] }) {
  const toast = useToast()
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    initial.map((r) => {
      const wrapped = wrap(r.key, r.value)
      return {
        ...r,
        form: wrapped,
        pristine: wrapped,
      }
    }),
  )
  const [busy, setBusy] = useState<string | null>(null)

  function patchDraft(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  }

  async function save(key: string) {
    if (busy) return
    const d = drafts.find((x) => x.key === key)
    if (!d) return
    const payload = unwrap(key, d.form)
    setBusy(key)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value: payload, version: d.version }),
      })
      if (r.status === 400) {
        toast.error('Some fields look off — check them and try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Someone else just changed this in another browser tab. Refresh to see their changes.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      patchDraft(key, {
        version: d.version + 1,
        pristine: d.form,
      })
      toast.success(`${SETTINGS_LABELS[key] ?? key} saved.`)
    } finally {
      setBusy(null)
    }
  }

  function discard(key: string) {
    const d = drafts.find((x) => x.key === key)
    if (!d) return
    patchDraft(key, { form: d.pristine })
    toast.info('Changes undone.')
  }

  return (
    <section className="mt-10 space-y-6">
      {drafts.length === 0 && (
        <p className="text-sm text-warm-stone">
          Your site settings haven&rsquo;t been set up yet. Ask an admin to get started.
        </p>
      )}
      {drafts.map((d) => {
        // mobile_cta has a non-trivial buttons-array shape (text + href
        // + icon enum per item) that the generic ZodForm widget set
        // doesn't render cleanly. Custom card slot below; everything
        // else stays on the generic SettingCard path.
        if (d.key === 'mobile_cta') {
          return (
            <MobileCtaCard
              key={d.key}
              draft={d}
              busy={busy === d.key}
              onSave={() => save(d.key)}
              onDiscard={() => discard(d.key)}
              onChange={(form) => patchDraft(d.key, { form })}
            />
          )
        }
        return (
          <SettingCard
            key={d.key}
            draft={d}
            busy={busy === d.key}
            onSave={() => save(d.key)}
            onDiscard={() => discard(d.key)}
            onChange={(form) => patchDraft(d.key, { form })}
          />
        )
      })}
    </section>
  )
}

// ─────────────────────── Mobile CTA card ───────────────────────
// Narrow custom card slot for the mobile_cta key. Renders the
// site-wide enable toggle + up to 2 button rows (text / href / icon
// picker). Lives here rather than as a new FieldShape kind because
// the icon picker needs a specific 12-option lucide allowlist —
// pushing that into ZodForm would surface a config knob no other
// setting uses.

interface MobileCtaButton {
  text: string
  href: string
  icon: (typeof MOBILE_CTA_ICONS)[number]
}
interface MobileCtaValue {
  enabled: boolean
  buttons: MobileCtaButton[]
}

function MobileCtaCard({
  draft, busy, onSave, onDiscard, onChange,
}: {
  draft: Draft
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  onChange: (form: Record<string, unknown>) => void
}) {
  const value = draft.form as unknown as MobileCtaValue
  const heading = SETTINGS_LABELS[draft.key] ?? 'Mobile call-to-action bar'
  const help = SETTINGS_HELP[draft.key] ??
    "A sticky bottom bar shown on phones (under md). Up to 2 quick-action buttons — call, WhatsApp, email, book, whatever the operator wants pinned to thumb-reach."
  const dirty = useMemo(() => !structuralEqual(draft.form, draft.pristine), [draft.form, draft.pristine])

  function patch(next: MobileCtaValue) {
    onChange(next as unknown as Record<string, unknown>)
  }

  function updateButton(i: number, b: MobileCtaButton) {
    const buttons = value.buttons.slice()
    buttons[i] = b
    patch({ ...value, buttons })
  }

  function addButton() {
    // Cap at 4 — matches the Zod schema. The renderer adapts: 1-2
    // buttons get the roomy horizontal layout; 3-4 switch to a
    // vertical icon-over-text stack so the pill stays readable.
    if (value.buttons.length >= 4) return
    patch({
      ...value,
      buttons: [...value.buttons, { text: '', href: '', icon: 'Phone' }],
    })
  }

  function removeButton(i: number) {
    patch({ ...value, buttons: value.buttons.filter((_, j) => j !== i) })
  }

  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">Mobile</p>
        <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">{heading}</h2>
        <p className="mt-2 max-w-2xl text-sm text-warm-stone leading-relaxed">{help}</p>
      </header>
      <div className="mt-6 flex flex-col gap-5">
        <Switch
          label="Show the sticky bar on mobile public pages"
          checked={value.enabled}
          onChange={(v) => patch({ ...value, enabled: v })}
        />
        <div className="space-y-3">
          {value.buttons.map((b, i) => (
            <div key={i} className="rounded-xl bg-cream-100/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">Button {i + 1}</p>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeButton(i)}>Remove</Button>
              </div>
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">Label</span>
                <Input className="mt-1.5" value={b.text} maxLength={40} placeholder="Call"
                  onChange={(e) => updateButton(i, { ...b, text: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">Goes to</span>
                <Input className="mt-1.5" value={b.href} maxLength={500} placeholder="tel:+1…, https://wa.me/…, mailto:…, or /contact"
                  onChange={(e) => updateButton(i, { ...b, href: e.target.value })}
                />
                <span className="mt-1 block text-[11px] text-warm-stone/80">
                  Accepts <code>tel:</code>, <code>https://</code>, <code>mailto:</code>, or a same-origin path.
                </span>
              </label>
              {/* Icon picker — visual grid of clickable lucide
                  previews. Per rule #0.59: visual choices must
                  render visually, never as a list of identifiers.
                  Selected tile gets a copper ring + tinted bg so
                  the active selection reads at a glance. Each
                  tile is a real <button> so it inherits native
                  focus + keyboard activation. The icon name sits
                  in `title` + sr-only `<span>` for screen
                  readers and operators who want the identifier. */}
              <div>
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">Icon</span>
                <div className="mt-1.5 grid grid-cols-7 gap-1.5">
                  {MOBILE_CTA_ICONS.map((name) => {
                    const PreviewIcon = ICON_PREVIEW_MAP[name]
                    const selected = b.icon === name
                    return (
                      <button
                        type="button"
                        key={name}
                        title={name}
                        aria-label={name}
                        aria-pressed={selected}
                        onClick={() => updateButton(i, { ...b, icon: name })}
                        className={`flex h-10 w-full items-center justify-center rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-copper-300/40 ${
                          selected
                            ? 'bg-copper-500/15 ring-2 ring-copper-500 text-copper-700'
                            : 'bg-cream-50/80 ring-1 ring-warm-stone/20 text-warm-stone hover:bg-cream-100 hover:text-near-black'
                        }`}
                      >
                        <PreviewIcon className="h-5 w-5" aria-hidden="true" />
                        <span className="sr-only">{name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          ))}
          {value.buttons.length < 4 && (
            <Button type="button" size="sm" variant="ghost" onClick={addButton}>+ Add button</Button>
          )}
          {value.buttons.length === 0 && (
            <p className="text-xs text-warm-stone/70">No buttons yet — add at least one to make the bar useful.</p>
          )}
          {value.buttons.length >= 3 && (
            <p className="text-xs text-warm-stone/70">
              3+ buttons render as a tab-bar (icon over text) so labels like <em>BROCHURE</em> or <em>CONTACT</em> fit on mobile. Keep labels short — long words truncate with an ellipsis.
            </p>
          )}
        </div>
        {value.enabled && value.buttons.length === 0 && (
          <p className="rounded-lg bg-copper-50 px-3 py-2 text-xs text-copper-800">
            The bar is enabled but has no buttons. It won&rsquo;t render until you add at least one.
          </p>
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={onSave} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>Undo changes</Button>
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

function SettingCard({
  draft,
  busy,
  onSave,
  onDiscard,
  onChange,
}: {
  draft: Draft
  busy: boolean
  onSave: () => void
  onDiscard: () => void
  onChange: (form: Record<string, unknown>) => void
}) {
  const shapes = SETTINGS_SHAPES[draft.key]
  const heading = SETTINGS_LABELS[draft.key] ?? draft.key
  const help = SETTINGS_HELP[draft.key]

  // Per-card dirty detection. Short-circuiting structural equality
  // returns on the first divergent key instead of stringifying the
  // whole payload twice per keystroke — matters for footer columns +
  // legal links which can grow unbounded.
  const dirty = useMemo(
    () => !structuralEqual(draft.form, draft.pristine),
    [draft.form, draft.pristine],
  )

  return (
    <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Site-wide
          </p>
          <h2 className="mt-1 font-serif text-xl font-bold tracking-tight text-near-black">
            {heading}
          </h2>
          {help && (
            <p className="mt-2 max-w-2xl text-sm text-warm-stone leading-relaxed">
              {help}
            </p>
          )}
        </div>
      </header>

      <div className="mt-6">
        {shapes ? (
          <ZodForm shapes={shapes} value={draft.form} onChange={onChange} />
        ) : (
          <p className="text-sm text-red-700">
            This setting doesn&rsquo;t have a form yet. Please let an admin know so it can be added.
          </p>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={onSave} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={busy}
          >
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
