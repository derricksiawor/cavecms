'use client'
import { useCallback } from 'react'
import clsx from 'clsx'

// Number stepper with explicit −/+ buttons and a centred numeric
// readout. Replaces the bare <input type="number"> in every visual
// form — much friendlier on touch devices and impossible to fat-finger.
//
// Empty value model: passing `undefined` clears the field. The +/−
// buttons treat undefined as "start at min ?? 0".
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
  disabled,
}: {
  value: number | undefined
  onChange: (v: number | undefined) => void
  min?: number
  max?: number
  step?: number
  placeholder?: string
  disabled?: boolean
}) {
  const decimals = (() => {
    const s = String(step)
    const i = s.indexOf('.')
    return i === -1 ? 0 : s.length - i - 1
  })()

  const clamp = useCallback(
    (n: number): number => {
      if (min !== undefined && n < min) return min
      if (max !== undefined && n > max) return max
      return Number(n.toFixed(decimals))
    },
    [min, max, decimals],
  )

  const bump = (dir: 1 | -1) => {
    const base = typeof value === 'number' ? value : (min ?? 0)
    onChange(clamp(base + dir * step))
  }

  const canDec = !disabled && (value === undefined || min === undefined || value > min)
  const canInc = !disabled && (max === undefined || (value ?? min ?? 0) < max)

  return (
    <div className="inline-flex items-stretch w-full max-w-[12rem] rounded-xl border border-warm-stone/25 bg-cream-50/80 overflow-hidden">
      <button
        type="button"
        onClick={() => bump(-1)}
        disabled={!canDec}
        aria-label="Decrease"
        className={clsx(
          'w-11 h-11 inline-flex items-center justify-center text-near-black transition-colors',
          'hover:bg-cream-100 disabled:opacity-30 disabled:cursor-not-allowed',
        )}
      >
        <span aria-hidden className="text-lg leading-none font-light">−</span>
      </button>
      <input
        type="number"
        inputMode="decimal"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value
          if (raw === '') {
            onChange(undefined)
            return
          }
          const n = Number(raw)
          if (Number.isFinite(n)) onChange(clamp(n))
        }}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-w-0 bg-transparent text-center text-sm font-medium text-near-black focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={() => bump(1)}
        disabled={!canInc}
        aria-label="Increase"
        className={clsx(
          'w-11 h-11 inline-flex items-center justify-center text-near-black transition-colors',
          'hover:bg-cream-100 disabled:opacity-30 disabled:cursor-not-allowed',
        )}
      >
        <span aria-hidden className="text-lg leading-none font-light">+</span>
      </button>
    </div>
  )
}
