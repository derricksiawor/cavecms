import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'
import { adaptToneForSurface, isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'
import { CopyButton } from '../LxCode/CopyButton'

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

const GRID_COLS: Record<1 | 2 | 3, string> = {
  1: '',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
}

export function LxIconList({
  data,
  // Per-item inline-edit follow-up. Operators edit via the drawer.
  inlineEdit: _inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_icon_list'>
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const headClass = isToken ? TONE_HEAD[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const isCenter = data.alignment === 'center'
  // 'row' places the icon BESIDE the headline (icon-left, text-right,
  // vertically centred) instead of above it — the "directory / nearby"
  // register (e.g. points-of-interest with a drive-time sub-line).
  const isRow = data.variant === 'row'
  // 'checklist' = compact green-check feature list (small icon, no glow).
  const isChecklist = data.variant === 'checklist'

  // Optional icon colour. lucide icons stroke with currentColor, so we set
  // the colour on a wrapping span; when no iconColor is set the champagne
  // class + glow stay. A custom iconColor drops the glow (it's champagne-
  // specific) for a clean tinted icon (e.g. a green check).
  const iconStyle = data.iconColor ? { color: resolveColorValue(data.iconColor) } : undefined
  // Filled feature-card grid (variant:'grid' + card:true). Surface-aware:
  // a light translucent fill on dark sections, a dark one on light.
  const isCard = data.card
  const onDark = isSectionSurfaceDark(sectionMeta)
  const cardClass = isCard
    ? clsx(
        'rounded-2xl p-8 sm:p-10',
        onDark ? 'bg-white/[0.02] ring-1 ring-white/[0.07]' : 'bg-obsidian/[0.03] ring-1 ring-obsidian/10',
      )
    : undefined
  const dropGlow = !!data.iconColor || isChecklist || isCard

  const items = data.items.map((item, idx) => {
    const icon = isChecklist ? (
      <span
        className={clsx('relative inline-flex shrink-0', !data.iconColor && 'text-champagne')}
        style={iconStyle}
      >
        <IconByName name={item.icon} className="h-5 w-5" strokeWidth={2.25} aria-hidden="true" />
      </span>
    ) : isCard ? (
      <span
        className={clsx('relative inline-flex', !data.iconColor && 'text-ivory/75')}
        style={iconStyle}
      >
        <IconByName name={item.icon} className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />
      </span>
    ) : (
      <div
        className={clsx(
          'relative inline-flex h-12 w-12 items-center justify-center',
          isRow && 'shrink-0',
        )}
      >
        {!dropGlow && <div aria-hidden="true" className="lx-glow-champagne-icon absolute inset-0" />}
        <span
          className={clsx('relative inline-flex', !data.iconColor && 'text-champagne')}
          style={iconStyle}
        >
          <IconByName name={item.icon} className="h-7 w-7" strokeWidth={1.5} aria-hidden="true" />
        </span>
      </div>
    )
    const heading = (
      <h3
        className={clsx('font-serif font-semibold text-xl tracking-tight', headClass)}
        style={customColor ? { color: customColor } : undefined}
      >
        {item.headline}
      </h3>
    )
    const body = item.body ? (
      <p
        className={clsx(
          'font-sans leading-relaxed',
          isRow ? 'text-sm' : 'text-base max-w-prose',
          bodyClass,
        )}
        style={customColor ? { color: customColor, opacity: 0.8 } : undefined}
      >
        {item.body}
      </p>
    ) : null
    // Optional mini terminal strip inside a card (e.g. an install command).
    const codeEl = item.code ? (
      <div className="mt-2 flex items-center justify-between gap-3 overflow-hidden rounded-xl bg-[#121212] px-4 py-3 ring-1 ring-white/10">
        <code className="overflow-x-auto whitespace-nowrap font-mono text-xs text-[#dbd7ca]">
          <span className="text-emerald-400">$ </span>
          {item.code}
        </code>
        <CopyButton text={item.code} />
      </div>
    ) : null

    if (isChecklist) {
      // One line per item: a small tinted icon + the headline text. Body,
      // if present, sits as a muted sub-line.
      return (
        <div key={idx} className="flex flex-row items-start gap-3 text-left">
          <span className="mt-0.5">{icon}</span>
          <div className="flex flex-col gap-0.5">
            <span
              className={clsx('font-sans text-base leading-relaxed', headClass)}
              style={customColor ? { color: customColor } : undefined}
            >
              {item.headline}
            </span>
            {body}
          </div>
        </div>
      )
    }
    if (isRow) {
      return (
        <div key={idx} className="flex flex-row items-center gap-4 text-left">
          {icon}
          <div className="flex flex-col gap-0.5">
            {heading}
            {body}
          </div>
        </div>
      )
    }
    return (
      <div
        key={idx}
        className={clsx(
          'flex flex-col gap-3',
          cardClass,
          // Cards are always left-aligned; non-card grids honour alignment.
          isCard || !isCenter ? 'items-start text-left' : 'items-center text-center',
        )}
      >
        {icon}
        {heading}
        {body}
        {codeEl}
      </div>
    )
  })

  const composed =
    isChecklist ? (
      <div
        className={clsx(
          'flex flex-col gap-3',
          isCenter ? 'items-center' : 'items-start',
          outerClass,
        )}
      >
        {items}
      </div>
    ) : data.variant === 'grid' ? (
      <div className={clsx('grid grid-cols-1 gap-10', GRID_COLS[data.columns], outerClass)}>
        {items}
      </div>
    ) : isRow ? (
      <div
        className={clsx(
          'grid grid-cols-1 gap-x-10 gap-y-6 max-w-4xl mx-auto',
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
