'use client'
import { Check } from 'lucide-react'
import clsx from 'clsx'
import type { Engine } from '@/lib/seo/indexnow/submit'
import { INDEXNOW_ENGINES } from './engines'
import { EngineLogo } from './EngineLogo'

// Visual multi-select for the IndexNow engine list (#0.59 — visual
// choices render visually, never a text dropdown). Each engine is a
// clickable tile showing its official logo (or a clean lucide glyph when
// none exists); the selected tiles get a copper ring + tinted background so
// the active set reads at a glance. Each tile is a real <button> with
// aria-pressed for native focus + screen-reader state.
//
// `indexnow` (the shared clearing-house) is effectively always worth
// keeping on, but it's still a normal toggle — the operator stays in
// control. A tiny note under each name explains what pinging that engine
// actually does, so the choice is informed rather than guesswork.
export function EngineToggle({
  selected,
  onChange,
  disabled,
}: {
  selected: Engine[]
  onChange: (next: Engine[]) => void
  disabled?: boolean
}) {
  function toggle(key: Engine) {
    if (disabled) return
    onChange(
      selected.includes(key)
        ? selected.filter((e) => e !== key)
        : [...selected, key],
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {INDEXNOW_ENGINES.map((engine) => {
        const isOn = selected.includes(engine.key)
        return (
          <button
            key={engine.key}
            type="button"
            disabled={disabled}
            aria-pressed={isOn}
            onClick={() => toggle(engine.key)}
            className={clsx(
              'group relative flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition-all duration-quick ease-standard cavecms-focus-ring',
              disabled && 'cursor-not-allowed opacity-50',
              isOn
                ? 'border-copper-500 bg-copper-500/10 ring-1 ring-copper-500/60'
                : 'border-warm-stone/20 bg-cream-50/80 hover:border-copper-300 hover:bg-cream-100/60',
            )}
          >
            <span className="flex w-full items-center justify-between">
              <EngineLogo logo={engine.logo} name={engine.name} size={26} />
              <span
                className={clsx(
                  'inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors',
                  isOn
                    ? 'border-copper-500 bg-copper-500 text-cream-50'
                    : 'border-warm-stone/30 bg-transparent text-transparent',
                )}
              >
                <Check size={12} strokeWidth={3} aria-hidden />
              </span>
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-near-black">
                {engine.name}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-warm-stone">
                {engine.note}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
