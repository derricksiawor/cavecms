import clsx from 'clsx'
import { Star } from 'lucide-react'

// Two-layer star meter — an empty row underneath, a champagne-filled row
// clipped to value/max width on top. Supports fractional ratings (4.5)
// via the width clip. Server-safe (pure render). Used by lx_star_rating
// and lx_reviews.

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-7 w-7',
}

export function Stars({
  value,
  max = 5,
  size = 'md',
  emptyClass = 'text-warm-stone/30',
}: {
  value: number
  max?: number
  size?: 'sm' | 'md' | 'lg'
  emptyClass?: string
}) {
  const clamped = Math.max(0, Math.min(max, value))
  const pct = max > 0 ? (clamped / max) * 100 : 0
  const cls = SIZE_CLASS[size]
  const rounded = Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1)

  return (
    <span
      className="relative inline-flex w-fit"
      role="img"
      aria-label={`Rated ${rounded} out of ${max}`}
    >
      <span className="flex gap-1" aria-hidden="true">
        {Array.from({ length: max }).map((_, i) => (
          <Star key={i} className={clsx(cls, 'shrink-0', emptyClass)} strokeWidth={1.5} />
        ))}
      </span>
      <span
        className="absolute inset-0 flex gap-1 overflow-hidden"
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      >
        {Array.from({ length: max }).map((_, i) => (
          <Star
            key={i}
            className={clsx(cls, 'shrink-0 fill-champagne text-champagne')}
            strokeWidth={1.5}
          />
        ))}
      </span>
    </span>
  )
}
