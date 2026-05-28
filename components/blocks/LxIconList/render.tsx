import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury icon list — vertical feature list. Each row: lucide icon
// in a champagne-glow halo, display headline, optional body. Reads
// as the "what you get" section on premium SaaS landings, tuned for
// editorial restraint.

const TONE_HEAD: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
  champagne: 'text-champagne',
}

const TONE_BODY: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/75',
  champagne: 'text-champagne/80',
}

const GRID_COLS: Record<2 | 3, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
}

export function LxIconList({
  data,
  // Per-item inline-edit follow-up. Operators edit via the drawer.
  inlineEdit: _inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_icon_list'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const headClass = isToken ? TONE_HEAD[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const isCenter = data.alignment === 'center'

  const items = data.items.map((item, idx) => {
    return (
      <div
        key={idx}
        className={clsx(
          'flex flex-col gap-3',
          isCenter ? 'items-center text-center' : 'items-start text-left',
        )}
      >
        <div className="relative inline-flex h-12 w-12 items-center justify-center">
          <div aria-hidden="true" className="lx-glow-champagne-icon absolute inset-0" />
          <IconByName
            name={item.icon}
            className="relative h-7 w-7 text-champagne"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </div>
        <h3
          className={clsx(
            'font-serif font-semibold text-xl tracking-tight',
            headClass,
          )}
          style={customColor ? { color: customColor } : undefined}
        >
          {item.headline}
        </h3>
        {item.body && (
          <p
            className={clsx(
              'font-sans text-base leading-relaxed max-w-prose',
              bodyClass,
            )}
            style={customColor ? { color: customColor, opacity: 0.8 } : undefined}
          >
            {item.body}
          </p>
        )}
      </div>
    )
  })

  const composed = data.variant === 'grid' ? (
    <div
      className={clsx(
        'grid grid-cols-1 gap-10',
        GRID_COLS[data.columns],
        outerClass,
      )}
    >
      {items}
    </div>
  ) : (
    <div className={clsx('flex flex-col gap-12 max-w-3xl mx-auto', outerClass)}>
      {items}
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
