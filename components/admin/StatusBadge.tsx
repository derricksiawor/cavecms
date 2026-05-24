import clsx from 'clsx'

// Tiny styled pill for status columns across admin lists. Tone maps to
// the brand palette: live/published = copper, draft/coming-soon =
// warm-stone, sold/trash = red, neutral = subdued.

export type StatusTone =
  | 'live'
  | 'draft'
  | 'coming-soon'
  | 'sold'
  | 'trashed'
  | 'neutral'

const TONE: Record<StatusTone, string> = {
  live: 'bg-copper-500/15 text-copper-700 ring-copper-400/40',
  draft: 'bg-cream-50 text-warm-stone ring-warm-stone/30',
  'coming-soon': 'bg-warm-stone/10 text-warm-stone ring-warm-stone/25',
  sold: 'bg-red-50 text-red-700 ring-red-200',
  trashed: 'bg-warm-stone/10 text-warm-stone ring-warm-stone/25',
  neutral: 'bg-cream-50 text-near-black/70 ring-warm-stone/20',
}

export function StatusBadge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: StatusTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] ring-1',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

// Map a project status enum value to a (tone, label) pair so every
// admin list renders consistently. `selling` is the operator's "live"
// state — gets the copper treatment to match the public-side Live
// pill on the project page.
export function projectStatusTone(status: string): {
  tone: StatusTone
  label: string
} {
  switch (status) {
    case 'selling':
      return { tone: 'live', label: 'Selling' }
    case 'sold_out':
      return { tone: 'sold', label: 'Sold out' }
    case 'under_construction':
      return { tone: 'coming-soon', label: 'Under construction' }
    case 'coming_soon':
      return { tone: 'coming-soon', label: 'Coming soon' }
    default:
      return { tone: 'neutral', label: status.replace(/_/g, ' ') }
  }
}
