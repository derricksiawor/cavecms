'use client'
import { useCallback, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { FontFamilyPickerField } from '@/components/inline-edit/pickers/FontFamilyPicker'
import { CustomFontsManager } from './CustomFontsManager'
import { GoogleFontsManager } from './GoogleFontsManager'
import {
  FONT_CATALOG,
  FONT_CATEGORY_LABELS,
  TYPOGRAPHY_ROLES_DEFAULT,
  fontCatalogVar,
  isFontKeySlug,
  type TypographyRole,
} from '@/lib/typography/catalog'

interface Roles {
  display: string
  body: string
}

interface Props {
  initial: { value: Roles; version: number }
}

// Category · weight-range descriptor for a catalog key — the refined
// sub-label under each role's chosen face.
function fontMeta(key: string): string {
  const f = FONT_CATALOG[key]
  if (!f) return ''
  const w = f.weightRange
    ? `${f.weightRange[0]}–${f.weightRange[1]}`
    : `${f.staticWeight ?? 400}`
  return `${FONT_CATEGORY_LABELS[f.category]} · ${w}`
}

export function TypographySettingsClient({ initial }: Props) {
  const toast = useToast()
  const [form, setForm] = useState<Roles>(initial.value)
  const [pristine, setPristine] = useState<Roles>(initial.value)
  const [version, setVersion] = useState(initial.version)
  const [saving, setSaving] = useState(false)

  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  const set = useCallback(
    (role: TypographyRole) => (v: string | undefined) => {
      // Accept any valid font key — a bundled catalog slug, a custom upload
      // (cf-…), or an activated Google font (gf-…). The role can be backed by
      // any active runtime font (roleVarsCss resolves it; fails closed to the
      // default if it isn't active). Reject only undefined / malformed keys.
      if (!v || !isFontKeySlug(v)) return
      setForm((f) => ({ ...f, [role]: v }))
    },
    [],
  )

  const handleSave = useCallback(async () => {
    if (saving || !dirty) return
    setSaving(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'typography_roles', value: form, version }),
      })
      if (r.status === 400) {
        toast.error('That font selection looks off — try again.')
        return
      }
      if (r.status === 409) {
        toast.error('Settings changed in another tab. Refresh to see them.')
        return
      }
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      setVersion((v) => v + 1)
      setPristine(form)
      toast.success('Typography saved.')
    } finally {
      setSaving(false)
    }
  }, [saving, dirty, form, version, toast])

  // Preview resolves through the catalog vars the layout already injects,
  // so it shows the operator's exact chosen faces live as they pick.
  const displayVar = `var(${fontCatalogVar(form.display)})`
  const bodyVar = `var(${fontCatalogVar(form.body)})`
  const displayName = FONT_CATALOG[form.display]?.family ?? form.display
  const bodyName = FONT_CATALOG[form.body]?.family ?? form.body
  const isDefault = structuralEqual(form, TYPOGRAPHY_ROLES_DEFAULT)

  return (
    <section className="mt-10 space-y-6">
      {/* ── The pairing ────────────────────────────────────────────────
          Two roles presented as one deliberate pairing of faces. The
          pickers read as refined "current font" chips on the cream card. */}
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Site-wide fonts
          </p>
          <p className="font-serif text-sm italic text-warm-stone">
            {displayName} <span className="not-italic text-warm-stone/50">&times;</span>{' '}
            {bodyName}
          </p>
        </div>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-warm-stone">
          Two faces carry your whole site — a display face for headings and a
          body face for everything else. Every block follows this pairing unless
          it overrides its own font. Fonts are self-hosted, so nothing leaks to
          third parties.
        </p>

        {/* Role pickers. The popover is dark-surfaced; the trigger chips use
            surface="light" so they read clearly on the cream card. */}
        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <FontFamilyPickerField
            mode="role"
            surface="light"
            label="Headings — display"
            help="Headings, titles, and display copy."
            value={form.display}
            onChange={set('display')}
          />
          <FontFamilyPickerField
            mode="role"
            surface="light"
            label="Body — text & UI"
            help="Body copy, buttons, eyebrows, and UI."
            value={form.body}
            onChange={set('body')}
          />
        </div>
      </article>

      {/* ── The hero: live specimen ────────────────────────────────────
          Showcases the chosen pairing at a tasteful editorial scale. */}
      <article className="overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-4 border-b border-warm-stone/15 px-6 py-4 sm:px-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Live specimen
          </p>
          <p
            className="text-[10px] uppercase tracking-[0.22em] text-warm-stone/70"
            style={{ fontFamily: bodyVar }}
          >
            {fontMeta(form.display)}
            <span className="mx-2 text-warm-stone/40">/</span>
            {fontMeta(form.body)}
          </p>
        </div>

        <div className="bg-cream-50 px-6 py-10 sm:px-12 sm:py-14">
          <p
            className="text-[11px] font-medium uppercase tracking-[0.32em] text-copper-600"
            style={{ fontFamily: bodyVar }}
          >
            {displayName}
          </p>
          <h3
            className="mt-4 text-5xl font-bold leading-[1.04] tracking-tight text-near-black sm:text-6xl"
            style={{ fontFamily: displayVar }}
          >
            The quick brown fox jumps
          </h3>
          <p
            className="mt-6 max-w-prose text-base leading-relaxed text-warm-stone sm:text-lg"
            style={{ fontFamily: bodyVar }}
          >
            Body copy renders in {bodyName} — set at a comfortable reading size
            with generous line-height. The five boxing wizards jump quickly,
            measuring every glyph from{' '}
            <span className="font-semibold text-near-black">A&nbsp;to&nbsp;Z</span>{' '}
            and 0123456789.
          </p>
          <div
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] uppercase tracking-[0.14em] text-warm-stone/70"
            style={{ fontFamily: displayVar }}
          >
            <span>ABCDEFGHIJKLM</span>
            <span>NOPQRSTUVWXYZ</span>
          </div>
        </div>
      </article>

      {/* ── Actions ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save typography'}
        </Button>
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setForm(pristine)}
            disabled={saving}
          >
            Undo changes
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setForm({ ...TYPOGRAPHY_ROLES_DEFAULT })}
          disabled={saving || isDefault}
        >
          Reset to defaults
        </Button>
        {dirty && (
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-copper-700">
            <span className="inline-flex h-2 w-2 rounded-full bg-copper-500 animate-cavecms-pulse-copper" />
            Unsaved changes
          </span>
        )}
      </div>

      {/* ── Custom fonts (operator uploads) ─────────────────────────────── */}
      <CustomFontsManager />

      {/* ── Google fonts (activated on demand, self-hosted) ─────────────── */}
      <GoogleFontsManager />
    </section>
  )
}
