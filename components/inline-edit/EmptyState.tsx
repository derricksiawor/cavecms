import clsx from 'clsx'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

// Premium empty-state card. Glow halo behind the icon, generous
// breathing space, an example to teach what good looks like, and a
// primary CTA. Optionally a row of preset chips for one-click adds.
// Used in place of every bare "No items yet" string across admin.

export interface PresetChip {
  label: string
  icon?: LucideIcon
  onSelect: () => void
  disabled?: boolean
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  example,
  cta,
  presets,
  className,
  size = 'md',
}: {
  icon: LucideIcon
  title: string
  description?: ReactNode
  example?: ReactNode
  cta?: {
    label: string
    onClick?: () => void
    href?: string
    icon?: LucideIcon
  }
  presets?: PresetChip[]
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const pad =
    size === 'sm'
      ? 'px-6 py-8'
      : size === 'lg'
      ? 'px-10 py-14'
      : 'px-8 py-10'
  const haloSize = size === 'lg' ? 'h-20 w-20' : size === 'sm' ? 'h-12 w-12' : 'h-16 w-16'
  const iconSize = size === 'lg' ? 32 : size === 'sm' ? 18 : 24
  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 text-center backdrop-blur-sm',
        pad,
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-48 w-48 rounded-full bg-copper-300/25 blur-3xl"
      />
      <div className="relative mx-auto flex flex-col items-center gap-4">
        <span
          className={clsx(
            'relative inline-flex items-center justify-center rounded-full bg-copper-500/10 text-copper-700 ring-1 ring-copper-300/30',
            haloSize,
          )}
        >
          <span className="pointer-events-none absolute inset-0 rounded-full bg-copper-400/25 blur-xl" />
          <Icon size={iconSize} strokeWidth={1.8} className="relative" />
        </span>
        <div>
          <h3 className="font-serif text-xl font-bold tracking-tight text-near-black">
            {title}
          </h3>
          {description && (
            <p className="mt-2 max-w-md text-sm leading-relaxed text-warm-stone mx-auto">
              {description}
            </p>
          )}
          {example && (
            <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-copper-600">
              {example}
            </p>
          )}
        </div>
        {cta &&
          (cta.href ? (
            <Link
              href={cta.href}
              className="mt-1 inline-flex w-fit items-center gap-2 rounded-full bg-near-black px-6 py-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_18px_40px_-22px_rgba(5,5,5,0.6)] transition-all hover:bg-copper-700 hover:shadow-[0_24px_50px_-22px_rgba(196,124,68,0.6)]"
            >
              {cta.icon && <cta.icon size={14} strokeWidth={2.2} />}
              {cta.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={cta.onClick}
              className="mt-1 inline-flex w-fit items-center gap-2 rounded-full bg-near-black px-6 py-2.5 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_18px_40px_-22px_rgba(5,5,5,0.6)] transition-all hover:bg-copper-700 hover:shadow-[0_24px_50px_-22px_rgba(196,124,68,0.6)]"
            >
              {cta.icon && <cta.icon size={14} strokeWidth={2.2} />}
              {cta.label}
            </button>
          ))}
        {presets && presets.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 max-w-xl">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
              Quick add
            </span>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={p.onSelect}
                disabled={p.disabled}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-all',
                  p.disabled
                    ? 'border-warm-stone/15 text-warm-stone/50 cursor-not-allowed'
                    : 'border-warm-stone/30 text-near-black hover:border-copper-400 hover:bg-copper-50/40 hover:-translate-y-[1px]',
                )}
              >
                {p.icon && <p.icon size={12} strokeWidth={2.2} />}
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
