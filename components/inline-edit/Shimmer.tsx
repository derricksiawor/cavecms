'use client'
import clsx from 'clsx'
import type { CSSProperties } from 'react'

// Copper-tinted skeleton block. The shimmer keyframe (`bwc-shimmer`)
// is defined in globals.css. Use this everywhere we previously
// printed "Loading…" — readers should never see a plain text
// placeholder again.

export function Shimmer({
  className,
  style,
  rounded = 'md',
}: {
  className?: string
  style?: CSSProperties
  rounded?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
}) {
  const r =
    rounded === 'full'
      ? 'rounded-full'
      : rounded === 'xl'
      ? 'rounded-2xl'
      : rounded === 'lg'
      ? 'rounded-xl'
      : rounded === 'sm'
      ? 'rounded'
      : 'rounded-lg'
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'block bg-gradient-to-r from-cream-50 via-warm-stone/15 to-cream-50 bg-[length:200%_100%] animate-bwc-shimmer',
        r,
        className,
      )}
      style={style}
    />
  )
}

// Stacked shimmer presets for common admin loading shapes.
export function ShimmerCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5">
      <Shimmer className="h-3 w-24" />
      <Shimmer className="h-6 w-2/3" />
      {Array.from({ length: rows }).map((_, i) => (
        <Shimmer
          key={i}
          className="h-3"
          style={{ width: `${60 + ((i * 13) % 30)}%` }}
        />
      ))}
    </div>
  )
}

export function ShimmerRow() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-warm-stone/15 bg-cream-50/60 px-4 py-3">
      <Shimmer rounded="full" className="h-9 w-9" />
      <Shimmer className="h-3 flex-1 max-w-[40%]" />
      <Shimmer className="h-3 w-24" />
    </div>
  )
}

export function ShimmerThumb() {
  return <Shimmer rounded="lg" className="h-full w-full aspect-square" />
}
