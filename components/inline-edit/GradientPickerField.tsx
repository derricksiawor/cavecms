'use client'

import { useId } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { compileGradient, type Gradient, type GradientStop } from '@/lib/cms/gradient'
import { ColorPickerField } from './pickers/ColorPicker'

// Visual gradient picker — the builder counterpart to MCP/REST's
// structured `gradient` value. Edits a { kind, angle, stops[] } descriptor
// with a live preview, so an operator dials in a gradient by eye instead
// of writing CSS. Used for text gradients (heading/text/eyebrow), section/
// column backgrounds, and button fills. Bounded by design: 2–6 stops, one
// angle, two kinds — premium gradients are simple, and the cap keeps both
// the UI and the compiled string tidy (scales to any number of pickers on
// a page without unbounded rows).

const MAX_STOPS = 6
const MIN_STOPS = 2

// Brand-palette default (copper). Tailwind blue/violet (#3b82f6 → #8b5cf6)
// is banned by the design system — gradients start from the warm copper
// scale so toggling one on never produces an off-brand blue/purple wash.
const DEFAULT_GRADIENT: Gradient = {
  kind: 'linear',
  angle: 180,
  stops: [{ color: '#ECC8AB' }, { color: '#B87333' }],
}

export function GradientPickerField({
  label,
  help,
  value,
  onChange,
}: {
  label: string
  help?: string
  value: Gradient | undefined
  onChange: (v: Gradient | undefined) => void
}) {
  const baseId = useId()
  const enabled = !!value && Array.isArray(value.stops) && value.stops.length >= MIN_STOPS
  const g: Gradient = enabled ? value! : DEFAULT_GRADIENT
  const previewCss = compileGradient(g) ?? 'none'

  const patch = (next: Partial<Gradient>) => onChange({ ...g, ...next })

  const setStop = (i: number, next: Partial<GradientStop>) => {
    const stops = g.stops.map((s, idx) => (idx === i ? { ...s, ...next } : s))
    onChange({ ...g, stops })
  }
  const addStop = () => {
    if (g.stops.length >= MAX_STOPS) return
    const last = g.stops[g.stops.length - 1]
    onChange({ ...g, stops: [...g.stops, { color: last?.color ?? '#ffffff' }] })
  }
  const removeStop = (i: number) => {
    if (g.stops.length <= MIN_STOPS) return
    onChange({ ...g, stops: g.stops.filter((_, idx) => idx !== i) })
  }

  return (
    <div className="block">
      <div className="flex items-center justify-between">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          {label}
        </span>
        {/* Enable / clear toggle — clearing sets the value to undefined so
            the optional schema stores nothing and the renderer falls back
            to the solid tone / token background. */}
        <button
          type="button"
          onClick={() => (enabled ? onChange(undefined) : onChange(DEFAULT_GRADIENT))}
          className={
            'rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors ' +
            (enabled
              ? 'bg-copper-500 text-white hover:bg-copper-600'
              : 'bg-cream-50 text-warm-stone ring-1 ring-warm-stone/30 hover:ring-copper-400')
          }
          aria-pressed={enabled}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      {enabled && (
        <div className="mt-2 space-y-3 rounded-xl border border-warm-stone/25 bg-cream-50/60 p-3">
          {/* Live preview */}
          <div
            className="h-12 w-full rounded-lg ring-1 ring-warm-stone/20"
            style={{ backgroundImage: previewCss }}
            aria-hidden="true"
          />

          {/* Kind + angle */}
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-lg bg-white p-0.5 ring-1 ring-warm-stone/25">
              {(['linear', 'radial'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => patch({ kind: k })}
                  className={
                    'rounded-md px-3 py-1 text-[11px] font-semibold capitalize transition-colors ' +
                    (g.kind === k
                      ? 'bg-copper-500 text-white'
                      : 'text-warm-stone hover:text-near-black')
                  }
                  aria-pressed={g.kind === k}
                >
                  {k}
                </button>
              ))}
            </div>
            {g.kind === 'linear' && (
              <label className="flex flex-1 items-center gap-2">
                <span className="text-[11px] text-warm-stone">Angle</span>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={g.angle ?? 180}
                  onChange={(e) => patch({ angle: Number(e.target.value) })}
                  className="flex-1 accent-copper-500"
                  aria-label="Gradient angle in degrees"
                />
                <span className="w-10 text-right text-[11px] tabular-nums text-warm-stone">
                  {g.angle ?? 180}°
                </span>
              </label>
            )}
          </div>

          {/* Color stops */}
          <div className="space-y-2">
            {g.stops.map((stop, i) => (
              <div key={`${baseId}-stop-${i}`} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {/* On-brand picker (token swatches + react-colorful + hex)
                      in hexOnly mode — replaces the native OS <input
                      type="color"> that clashed with the dark drawer + bypassed
                      the brand palette. allowAlpha=false: gradient stops are
                      6-digit hex. */}
                  <ColorPickerField
                    label={`Stop ${i + 1}`}
                    value={stop.color}
                    onChange={(v) => setStop(i, { color: v ?? stop.color })}
                    hexOnly
                    allowAlpha={false}
                  />
                </div>
                <label className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={typeof stop.position === 'number' ? stop.position : ''}
                    placeholder="auto"
                    onChange={(e) =>
                      setStop(i, {
                        position: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    className="w-16 rounded-lg border border-warm-stone/25 bg-white px-2 py-1 text-[11px] text-near-black focus:border-copper-400 focus:outline-none"
                    aria-label={`Stop ${i + 1} position percent`}
                  />
                  <span className="text-[11px] text-warm-stone">%</span>
                </label>
                <button
                  type="button"
                  onClick={() => removeStop(i)}
                  disabled={g.stops.length <= MIN_STOPS}
                  className="ml-auto rounded-md p-1 text-warm-stone transition-colors hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label={`Remove stop ${i + 1}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          {g.stops.length < MAX_STOPS && (
            <button
              type="button"
              onClick={addStop}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-semibold text-copper-600 ring-1 ring-warm-stone/25 transition-colors hover:ring-copper-400"
            >
              <Plus size={13} /> Add color stop
            </button>
          )}
        </div>
      )}

      {help && <span className="mt-1 block text-[11px] text-warm-stone/80">{help}</span>}
    </div>
  )
}
