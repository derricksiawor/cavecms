import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury divider — editorial hairline rule with an optional fleuron
// (small ornamental diamond at center, the section-break punctuation
// used in luxury print + at Aman-tier hotels). The simple case is a
// single clean horizontal rule; `style: 'fleuron'` swaps to two
// hairlines flanking a rotated diamond.

const WIDTH_CLASS: Record<BlockData<'lx_divider'>['width'], string> = {
  full: 'w-full',
  half: 'w-1/2',
  quarter: 'w-1/4',
  short: 'w-16',
}

const ALIGN_CLASS: Record<BlockData<'lx_divider'>['alignment'], string> = {
  left: 'mr-auto',
  center: 'mx-auto',
  right: 'ml-auto',
}

const TONE_BORDER_TOKEN: Record<string, string> = {
  champagne: 'border-champagne/60',
  'warm-stone': 'border-warm-stone/50',
  copper: 'border-copper-500/70',
  obsidian: 'border-obsidian/80',
  ivory: 'border-ivory/40',
}

const TONE_DIAMOND_TOKEN: Record<string, string> = {
  champagne: 'bg-champagne',
  'warm-stone': 'bg-warm-stone',
  copper: 'bg-copper-500',
  obsidian: 'bg-obsidian',
  ivory: 'bg-ivory',
}

const STYLE_CLASS: Record<BlockData<'lx_divider'>['style'], string> = {
  solid: 'border-solid',
  dashed: 'border-dashed',
  dotted: 'border-dotted',
  fleuron: 'border-solid',
}

const THICKNESS_CLASS: Record<BlockData<'lx_divider'>['thickness'], string> = {
  hairline: 'border-t',
  '1px': 'border-t',
  '2px': 'border-t-2',
}

export function LxDivider({
  data,
  outerClass,
}: {
  data: BlockData<'lx_divider'>
  outerClass?: string
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const borderClass = isToken ? TONE_BORDER_TOKEN[tone] : undefined
  const diamondClass = isToken ? TONE_DIAMOND_TOKEN[tone] : undefined
  const customStyle = !isToken ? { borderColor: resolveColorValue(tone) } : undefined
  const customDiamondStyle = !isToken ? { backgroundColor: resolveColorValue(tone) } : undefined

  const composed = data.style === 'fleuron' ? (
    <div
      className={clsx(
        'flex items-center justify-center gap-4 py-2',
        WIDTH_CLASS[data.width],
        ALIGN_CLASS[data.alignment],
        outerClass,
      )}
      role="separator"
      aria-orientation="horizontal"
    >
      <div
        className={clsx('flex-1', borderClass, THICKNESS_CLASS[data.thickness])}
        style={customStyle}
      />
      <div
        aria-hidden="true"
        className={clsx('h-2 w-2 rotate-45', diamondClass)}
        style={customDiamondStyle}
      />
      <div
        className={clsx('flex-1', borderClass, THICKNESS_CLASS[data.thickness])}
        style={customStyle}
      />
    </div>
  ) : (
    // `border-0` is intentionally NOT added here — the THICKNESS_CLASS
    // utilities (border-t / border-t-2) only set the TOP side; the
    // other sides default to `border-style: none` so no chrome leaks
    // in. Combining `border-0` with `border-t` was a class-collision
    // bug in 0.1.44 — Tailwind's utility order is not guaranteed and
    // `border-0` could win, rendering an invisible rule.
    <hr
      className={clsx(
        WIDTH_CLASS[data.width],
        ALIGN_CLASS[data.alignment],
        THICKNESS_CLASS[data.thickness],
        STYLE_CLASS[data.style],
        borderClass,
        outerClass,
      )}
      style={customStyle}
    />
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
