import clsx from 'clsx'
import { Check } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Luxury pricing table (Elementor: Price Table). A single plan card —
// compose three in a section's columns for a 3-up. `featured` adds a
// champagne ring + eyebrow + lift. Server component.

const TONE_HEAD: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_BODY: Record<string, string> = { obsidian: 'text-warm-stone', ivory: 'text-ivory/70' }
const TONE_BORDER: Record<string, string> = {
  obsidian: 'border-obsidian/10',
  ivory: 'border-ivory/15',
}

export function LxPricingTable({
  data,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_pricing_table'>
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const headClass = isToken ? TONE_HEAD[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const borderClass = isToken ? TONE_BORDER[tone] : undefined
  const custom = !isToken ? resolveColorValue(tone) : undefined

  const showCta = !!(data.ctaLabel && data.ctaHref)

  const composed = (
    <div
      className={clsx(
        'relative mx-auto flex w-full max-w-sm flex-col rounded-2xl border px-8 py-10 transition-transform duration-standard ease-standard',
        data.featured
          ? 'border-champagne/60 ring-1 ring-champagne/40 sm:-translate-y-2'
          : borderClass,
        outerClass,
      )}
    >
      {data.featured && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-champagne px-4 py-1 font-sans text-[10px] font-semibold uppercase tracking-eyebrow text-obsidian">
          {data.featuredLabel || 'Most popular'}
        </span>
      )}
      <h3
        className={clsx('font-sans text-sm font-semibold uppercase tracking-eyebrow text-champagne')}
      >
        {data.planName}
      </h3>
      <div className="mt-4 flex items-end gap-1">
        <span
          className={clsx('font-serif text-5xl font-bold tracking-tight', headClass)}
          style={custom ? { color: custom } : undefined}
        >
          {data.price}
        </span>
        {data.period && (
          <span className={clsx('mb-1.5 font-sans text-sm', bodyClass)}>{data.period}</span>
        )}
      </div>
      {data.description && (
        <p className={clsx('mt-3 font-sans text-sm leading-relaxed', bodyClass)}>
          {data.description}
        </p>
      )}
      <ul className="mt-8 flex flex-col gap-3">
        {data.features.map((f, i) => (
          <li key={i} className="flex items-start gap-3">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-champagne" strokeWidth={2.5} aria-hidden="true" />
            <span className={clsx('font-sans text-sm leading-relaxed', headClass)} style={custom ? { color: custom } : undefined}>
              {f}
            </span>
          </li>
        ))}
      </ul>
      {showCta && (
        <a
          href={data.ctaHref}
          target={data.ctaOpenInNew ? '_blank' : undefined}
          rel={data.ctaOpenInNew ? 'noopener noreferrer' : undefined}
          className={clsx(
            'mt-8 inline-flex w-full items-center justify-center rounded-full px-6 py-3 font-sans text-xs font-semibold uppercase tracking-[0.18em] transition-colors',
            data.featured
              ? 'bg-champagne text-obsidian hover:bg-antique-gold'
              : 'bg-obsidian text-ivory hover:bg-near-black',
          )}
        >
          {data.ctaLabel}
        </a>
      )}
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
