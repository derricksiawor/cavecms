'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'

interface Swatch {
  label: string
  color: string
}

// Operator-defined global brand swatches (E18). Saved to the
// `theme_swatches` setting; every colour picker in the editor surfaces
// these as quick picks. Self-contained so it doesn't entangle the palette
// form's single-key save.
export function BrandSwatchesEditor({
  initial,
}: {
  initial: { value: { swatches: Swatch[] }; version: number }
}) {
  const toast = useToast()
  const [swatches, setSwatches] = useState<Swatch[]>(initial.value.swatches ?? [])
  const [version, setVersion] = useState(initial.version)
  const [saving, setSaving] = useState(false)

  const update = (i: number, next: Partial<Swatch>) =>
    setSwatches((s) => s.map((sw, idx) => (idx === i ? { ...sw, ...next } : sw)))
  const add = () =>
    setSwatches((s) => (s.length >= 24 ? s : [...s, { label: 'Brand', color: '#3b82f6' }]))
  const remove = (i: number) => setSwatches((s) => s.filter((_, idx) => idx !== i))

  async function save() {
    setSaving(true)
    try {
      const clean = swatches
        .map((s) => ({ label: s.label.trim().slice(0, 40), color: s.color }))
        .filter((s) => s.label && /^#[0-9a-fA-F]{6}$/.test(s.color))
        .slice(0, 24)
      const r = await csrfFetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'theme_swatches', value: { swatches: clean }, version }),
      })
      if (!r.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      const data = (await r.json().catch(() => null)) as { version?: number } | null
      if (typeof data?.version === 'number') setVersion(data.version)
      toast.success('Brand swatches saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-12 rounded-3xl border border-warm-stone/20 bg-cream-50/40 p-6 sm:p-8">
      <h2 className="font-serif text-2xl font-bold tracking-tight text-near-black">Brand swatches</h2>
      <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Save your brand colours here once — they appear as quick picks in every
        colour picker across the editor. Define them once, reuse everywhere.
      </p>

      <div className="mt-5 space-y-3">
        {swatches.length === 0 && (
          <p className="text-sm text-warm-stone/80">No swatches yet — add your brand colours below.</p>
        )}
        {swatches.map((s, i) => (
          <div key={i} className="flex items-center gap-3">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#000000'}
              onChange={(e) => update(i, { color: e.target.value })}
              className="h-9 w-12 shrink-0 cursor-pointer rounded border border-warm-stone/30 bg-white p-0.5"
              aria-label={`Swatch ${i + 1} colour`}
            />
            <input
              type="text"
              value={s.color}
              onChange={(e) => update(i, { color: e.target.value })}
              className="w-28 rounded-lg border border-warm-stone/25 bg-white px-2 py-1.5 font-mono text-xs text-near-black focus:border-copper-400 focus:outline-none"
              aria-label={`Swatch ${i + 1} hex`}
            />
            <input
              type="text"
              value={s.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Name (e.g. Brand blue)"
              className="flex-1 rounded-lg border border-warm-stone/25 bg-white px-3 py-1.5 text-sm text-near-black focus:border-copper-400 focus:outline-none"
              aria-label={`Swatch ${i + 1} name`}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`Remove swatch ${i + 1}`}
              className="rounded-md p-2 text-warm-stone transition-colors hover:text-red-500"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3">
        {swatches.length < 24 && (
          <button
            type="button"
            onClick={add}
            className="inline-flex items-center gap-1.5 rounded-full border border-warm-stone/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black transition-colors hover:border-copper-400"
          >
            <Plus size={13} /> Add swatch
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center rounded-full bg-near-black px-6 py-2.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:bg-copper-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save swatches'}
        </button>
      </div>
    </section>
  )
}
