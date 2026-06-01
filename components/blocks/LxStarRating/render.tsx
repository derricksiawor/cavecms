import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { Stars } from '../_shared/Stars'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Luxury star rating (Elementor: Star Rating). Champagne-filled meter
// with optional numeric value. Fractional ratings supported via the
// Stars clip. Server component.

const ALIGN: Record<BlockData<'lx_star_rating'>['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}
const TONE_VALUE: Record<string, string> = {
  champagne: 'text-champagne',
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

export function LxStarRating({
  data,
  outerClass,
}: {
  data: BlockData<'lx_star_rating'>
  outerClass?: string
}) {
  const isToken = isColorToken(data.tone)
  const valueClass = isToken ? TONE_VALUE[data.tone] : undefined
  const custom = !isToken ? resolveColorValue(data.tone) : undefined
  const rounded = Number.isInteger(data.value) ? String(data.value) : data.value.toFixed(1)

  const composed = (
    <div className={clsx('flex items-center gap-3', ALIGN[data.alignment], outerClass)}>
      <Stars value={data.value} max={data.max} size={data.size} />
      {data.showValue && (
        <span
          className={clsx('font-sans text-sm font-semibold tabular-nums', valueClass)}
          style={custom ? { color: custom } : undefined}
        >
          {rounded}
          <span className="text-warm-stone/60"> / {data.max}</span>
        </span>
      )}
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
