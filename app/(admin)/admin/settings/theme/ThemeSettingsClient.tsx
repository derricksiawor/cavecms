'use client'
import { useCallback, useMemo, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/inline-edit/Toast'
import { structuralEqual } from '@/lib/structuralEqual'
import { ColorPickerField } from '@/components/inline-edit/pickers/ColorPicker'
import {
  THEME_PALETTE_DEFAULT,
  brandVarsCss,
  type ThemePalette,
} from '@/lib/cms/themeCss'
import { wcagRatio, apcaLc } from '@/lib/cms/contrast'

interface Props {
  initial: { value: ThemePalette; version: number }
}

// A contrast check rendered next to a color control. `gate` is the WCAG
// pairing the Save soft-block is computed from; APCA is advisory only.
function ContrastReadout({
  fg,
  bg,
  label,
}: {
  fg: string
  bg: string
  label: string
}) {
  const ratio = wcagRatio(fg, bg)
  const lc = Math.abs(apcaLc(fg, bg))
  const level = ratio >= 4.5 ? 'aa' : ratio >= 3 ? 'warn' : 'fail'
  const color =
    level === 'aa'
      ? 'text-emerald-700'
      : level === 'warn'
        ? 'text-amber-700'
        : 'text-red-700'
  return (
    <p className={`mt-1 text-[11px] font-medium ${color}`}>
      {label}: {ratio.toFixed(2)}:1{' '}
      {level === 'aa'
        ? '· passes AA'
        : level === 'warn'
          ? '· below AA (4.5:1)'
          : '· too low (under 3:1)'}
      <span className="ml-2 text-warm-stone/70">APCA Lc {Math.round(lc)}</span>
    </p>
  )
}

export function ThemeSettingsClient({ initial }: Props) {
  const toast = useToast()
  const [form, setForm] = useState<ThemePalette>(initial.value)
  const [pristine, setPristine] = useState<ThemePalette>(initial.value)
  const [version, setVersion] = useState(initial.version)
  const [saving, setSaving] = useState(false)

  const dirty = useMemo(() => !structuralEqual(form, pristine), [form, pristine])

  // Lowest contrast among the gated pairings — drives the soft-block.
  const minGatedRatio = useMemo(() => {
    const pairs: Array<[string, string]> = [
      [form.primary, form.surfaceLight], // headings on light
      [form.secondary, form.surfaceLight], // muted text on light
    ]
    return Math.min(...pairs.map(([f, b]) => wcagRatio(f, b)))
  }, [form])

  const set = useCallback(
    (key: keyof ThemePalette) => (v: string | undefined) => {
      if (!v) return
      setForm((f) => ({ ...f, [key]: v.toUpperCase() }))
    },
    [],
  )

  const handleSave = useCallback(async () => {
    if (saving || !dirty) return
    // Soft-block: anything under 3:1 requires explicit confirmation.
    if (minGatedRatio < 3 && typeof window !== 'undefined') {
      const ok = window.confirm(
        'Some text colors are below the minimum readable contrast (3:1). ' +
          'Visitors may not be able to read them. Save anyway?',
      )
      if (!ok) return
    }
    setSaving(true)
    try {
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'theme_palette', value: form, version }),
      })
      if (r.status === 400) {
        toast.error('Some colors look off — check them and try again.')
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
      toast.success('Theme saved.')
    } finally {
      setSaving(false)
    }
  }, [saving, dirty, form, version, toast, minGatedRatio])

  // Live preview — scope the brand vars to this wrapper so the preview
  // re-skins instantly without touching the live admin page. brandVarsCss
  // emits `:root{…}`; strip to the inner declarations and apply as inline
  // style on the wrapper.
  const previewStyle = useMemo(() => {
    const inner = brandVarsCss(form)
      .replace(/^:root\{/, '')
      .replace(/\}$/, '')
    const style: Record<string, string> = {}
    for (const decl of inner.split(';')) {
      const idx = decl.indexOf(':')
      if (idx === -1) continue
      const k = decl.slice(0, idx).trim()
      const v = decl.slice(idx + 1).trim()
      if (k && v) style[k] = v
    }
    return style as React.CSSProperties
  }, [form])

  return (
    <section className="mt-10 space-y-6">
      <article className="rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-6 backdrop-blur-sm">
        {/* Default theme toggle */}
        <div className="mb-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Default theme
          </p>
          <div className="mt-2 inline-flex rounded-xl border border-warm-stone/25 p-1">
            {(['light', 'dark'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setForm((f) => ({ ...f, mode: m }))}
                className={
                  'rounded-lg px-4 py-1.5 text-sm font-semibold capitalize transition-colors ' +
                  (form.mode === m
                    ? 'bg-near-black text-cream-50'
                    : 'text-warm-stone hover:text-near-black')
                }
              >
                {m}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-warm-stone">
            Sets the base page surface and the default header/footer feel.
          </p>
        </div>

        {/* Color controls + contrast readouts. The picker popover is a
            dark surface, so it sits fine on the cream admin card. */}
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <ColorPickerField
              hexOnly
              allowAlpha={false}
              label="Primary (headings)"
              value={form.primary}
              onChange={set('primary')}
            />
            <ContrastReadout
              label="on light surface"
              fg={form.primary}
              bg={form.surfaceLight}
            />
          </div>
          <div>
            <ColorPickerField
              hexOnly
              allowAlpha={false}
              label="Secondary (muted text)"
              value={form.secondary}
              onChange={set('secondary')}
            />
            <ContrastReadout
              label="on light surface"
              fg={form.secondary}
              bg={form.surfaceLight}
            />
          </div>
          <div>
            <ColorPickerField
              hexOnly
              allowAlpha={false}
              label="Accent (buttons, links)"
              value={form.accent}
              onChange={set('accent')}
            />
            <ContrastReadout
              label="surface on accent"
              fg={form.surfaceDark}
              bg={form.accent}
            />
          </div>
          <div>
            <ColorPickerField
              hexOnly
              allowAlpha={false}
              label="Dark surface"
              value={form.surfaceDark}
              onChange={set('surfaceDark')}
            />
          </div>
          <div>
            <ColorPickerField
              hexOnly
              allowAlpha={false}
              label="Light surface"
              value={form.surfaceLight}
              onChange={set('surfaceLight')}
            />
          </div>
        </div>

        {/* Live preview */}
        <div className="mt-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            Preview
          </p>
          <div
            className="mt-3 overflow-hidden rounded-2xl border border-warm-stone/20"
            style={previewStyle}
          >
            <div
              className="space-y-3 p-8"
              style={{ background: 'var(--color-ivory)' }}
            >
              <h3
                className="font-serif text-3xl font-bold"
                style={{ color: 'var(--color-primary)' }}
              >
                A luxury headline
              </h3>
              <p className="text-sm" style={{ color: 'var(--color-obsidian)' }}>
                Body copy sits on the light surface.{' '}
                <span style={{ color: 'var(--color-warm-stone)' }}>
                  This is supporting text.
                </span>
              </p>
              <button
                type="button"
                className="rounded-full px-5 py-2 text-sm font-semibold"
                style={{
                  background: 'var(--color-champagne)',
                  color: 'var(--color-obsidian)',
                }}
              >
                Primary button
              </button>
            </div>
            <div
              className="space-y-3 p-8"
              style={{ background: 'var(--color-obsidian)' }}
            >
              <h3
                className="font-serif text-3xl font-bold"
                style={{ color: 'var(--color-ivory)' }}
              >
                On a dark section
              </h3>
              <p className="text-sm" style={{ color: 'var(--color-ivory)' }}>
                Headings auto-flip to the light surface so they stay readable.
              </p>
              <button
                type="button"
                className="rounded-full px-5 py-2 text-sm font-semibold"
                style={{
                  background: 'var(--color-champagne)',
                  color: 'var(--color-obsidian)',
                }}
              >
                Accent button
              </button>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving…' : 'Save'}
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
            onClick={() => setForm(THEME_PALETTE_DEFAULT)}
            disabled={saving || structuralEqual(form, THEME_PALETTE_DEFAULT)}
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
      </article>
    </section>
  )
}
