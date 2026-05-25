'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { TONE_CHIPS, type ToneChip } from '@/lib/ai/prompts/inlineCatalog'

// Rewrite tab — the headline AI affordance.
//
// Two affordances:
//   1. Tone chips: a wrapping row of pill-shaped buttons. Clicking a
//      chip selects it. Click a second time to deselect (operator can
//      then submit with free-text only).
//   2. Free-text input (240 char cap, matches server validation):
//      "…or describe how you want it". Submit button is disabled
//      until either a tone OR free-text is provided.

const TONE_LABELS: Record<ToneChip, string> = {
  punchier: 'Punchier',
  shorter: 'Shorter',
  longer: 'Longer',
  warmer: 'Warmer',
  professional: 'More professional',
  casual: 'More casual',
  playful: 'More playful',
  authoritative: 'More authoritative',
  simpler: 'Simpler',
  elegant: 'More elegant',
}

interface Props {
  onSubmit: (toneChip: ToneChip | undefined, freeText: string | undefined) => void
}

export function AISparkleRewriteCard(p: Props) {
  const [tone, setTone] = useState<ToneChip | null>(null)
  const [freeText, setFreeText] = useState('')

  const canSubmit = tone !== null || freeText.trim().length > 0

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSubmit) return
        p.onSubmit(
          tone ?? undefined,
          freeText.trim().length > 0 ? freeText.trim() : undefined,
        )
      }}
      className="flex flex-col gap-4"
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700">
          Pick a tone
        </p>
        <p className="mt-1 text-[11px] text-warm-stone">
          Or describe what you want below.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tone presets">
        {TONE_CHIPS.map((chip) => {
          const active = chip === tone
          return (
            <button
              key={chip}
              type="button"
              aria-pressed={active}
              onClick={() => setTone(active ? null : chip)}
              className={clsx(
                'rounded-full px-3 py-1.5 text-[11px] font-medium tracking-tight transition-colors',
                active
                  ? 'bg-copper-500 text-cream-50'
                  : 'bg-cream-100 text-near-black hover:bg-copper-50 hover:text-copper-700',
              )}
            >
              {TONE_LABELS[chip]}
            </button>
          )
        })}
      </div>
      <label className="block">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-warm-stone">
          Or in your own words
        </span>
        <textarea
          maxLength={240}
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="e.g. mention our 10-year warranty"
          rows={3}
          className="mt-1.5 w-full resize-none rounded-xl border border-warm-stone/25 bg-white px-3 py-2 text-[12px] leading-relaxed text-near-black placeholder:text-warm-stone/60 focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
        />
        <span className="mt-1 block text-right text-[10px] tabular-nums text-warm-stone/70">
          {freeText.length} / 240
        </span>
      </label>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-full bg-copper-500 px-5 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-cream-50 hover:bg-copper-600 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          Rewrite
        </button>
      </div>
    </form>
  )
}
