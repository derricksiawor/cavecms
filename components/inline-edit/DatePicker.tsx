'use client'
import clsx from 'clsx'

// Luxury wrapper around the native date input. iOS/Android both render
// great native pickers; desktop Chrome / Safari / Firefox have polished
// popovers. We just take a YYYY-MM-DD string and pass it through.
//
// Why not a custom calendar component? The native picker is a11y-clean,
// keyboard-driven out of the box, respects the user's locale, and zero
// new deps. Reach for a custom one only if/when we need a date-range
// selector with hover preview — not the case anywhere in this admin.
export function DatePicker({
  value,
  onChange,
  disabled,
  min,
  max,
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  disabled?: boolean
  min?: string
  max?: string
}) {
  return (
    <div className="relative">
      <input
        type="date"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={disabled}
        min={min}
        max={max}
        className={clsx(
          'w-full rounded-xl border border-warm-stone/25 bg-cream-50/80 px-4 py-3 pr-10 text-sm text-near-black transition-all duration-quick',
          'hover:border-warm-stone/40',
          'focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/40',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'min-h-[44px]',
          // Hide the default WebKit calendar indicator — we render our own
          // visual cue on the right (more on brand than the chrome glyph).
          '[&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:right-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer',
        )}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-warm-stone"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </span>
    </div>
  )
}
