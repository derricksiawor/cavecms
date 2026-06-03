import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import type { BlockData } from '@/lib/cms/block-registry'
import { resolveColorValue } from '@/lib/cms/designTokens'

// Standalone icon widget (Elementor Icon parity). A single lucide glyph at
// any size + colour, optionally inside a circle/square chip, rotatable, and
// linkable. Server component — IconByName renders the glyph; colour rides
// on currentColor so a tinted chip background derives from it via color-mix.

const ALIGN: Record<BlockData<'lx_icon'>['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}

export function LxIcon({
  data,
  outerClass,
}: {
  data: BlockData<'lx_icon'>
  outerClass?: string
}) {
  const color = resolveColorValue(data.color) ?? 'var(--color-champagne)'
  const hasShape = data.shape !== 'none'
  const chipBg = data.shapeColor
    ? resolveColorValue(data.shapeColor)
    : 'color-mix(in srgb, currentColor 12%, transparent)'
  const pad = Math.round(data.size * 0.5)

  const glyph = (
    <span
      className={clsx(
        'inline-flex items-center justify-center',
        hasShape && (data.shape === 'circle' ? 'rounded-full' : 'rounded-2xl'),
      )}
      style={{
        color,
        ...(hasShape ? { backgroundColor: chipBg, padding: `${pad}px` } : {}),
        ...(data.rotate ? { transform: `rotate(${data.rotate}deg)` } : {}),
      }}
    >
      <IconByName name={data.icon} size={data.size} strokeWidth={1.75} aria-hidden="true" />
    </span>
  )

  const node = data.link?.href ? (
    <a
      href={data.link.href}
      target={data.link.openInNew ? '_blank' : undefined}
      rel={data.link.openInNew ? 'noopener noreferrer' : undefined}
      className="inline-flex transition-transform duration-base ease-luxury hover:scale-105"
    >
      {glyph}
    </a>
  ) : (
    glyph
  )

  const content = <div className={clsx('flex w-full', ALIGN[data.alignment], outerClass)}>{node}</div>
  if (data.animation === 'none') return content
  return <MotionTarget preset={data.animation}>{content}</MotionTarget>
}
