import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Luxury price list (Elementor: Price List) — menu-style rows: title +
// optional description on the left, price on the right, joined by a
// dotted champagne leader. Server component.

const TONE_TITLE: Record<string, string> = { obsidian: 'text-obsidian', ivory: 'text-ivory' }
const TONE_DESC: Record<string, string> = { obsidian: 'text-warm-stone', ivory: 'text-ivory/65' }

export function LxPricingList({
  data,
  outerClass,
}: {
  data: BlockData<'lx_pricing_list'>
  outerClass?: string
}) {
  const isToken = isColorToken(data.tone)
  const titleClass = isToken ? TONE_TITLE[data.tone] : undefined
  const descClass = isToken ? TONE_DESC[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined

  const composed = (
    <ul className={clsx('mx-auto flex w-full max-w-2xl flex-col gap-6', outerClass)}>
      {data.items.map((item, i) => (
        <li key={i} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-3">
            <span
              className={clsx('font-serif text-lg font-semibold tracking-tight', titleClass)}
              style={custom ? { color: custom } : undefined}
            >
              {item.title}
            </span>
            <span
              aria-hidden="true"
              className="mb-1 flex-1 border-b border-dashed border-champagne/40"
            />
            <span className="font-serif text-lg font-semibold tracking-tight text-champagne">
              {item.price}
            </span>
          </div>
          {item.description && (
            <p className={clsx('font-sans text-sm leading-relaxed', descClass)}>
              {item.description}
            </p>
          )}
        </li>
      ))}
    </ul>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
