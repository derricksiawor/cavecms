import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import { isSectionSurfaceDark, type SectionMeta } from '@/lib/cms/blockMeta'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury icon box — single card with icon + headline + body + optional
// link. For a row of cards, compose three lx_icon_box widgets inside
// threeCols. Accent controls the surface treatment:
//   champagne-fill    — champagne radial glow on a dark glassy ground
//                       (marquee feature, for dark sections)
//   champagne-outline — SECTION-AWARE (default editorial). On a dark
//                       section: a transparent card + champagne hairline
//                       border (crisp gold on near-black, matching the
//                       legacy copper-outline it migrated from). On a
//                       light section: the quiet ivory fill that reads as
//                       a soft card on cream/ivory. Adapts so it never
//                       decays to mud — the old behaviour was a fixed
//                       translucent ivory FILL (bg-ivory/60), which over a
//                       dark section became a muddy gray.
//   cream-tint        — soft cream surface, sits on dark sections
//                       (obsidian / near-black)

const TONE_HEAD: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_BODY: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/75',
}

// The two background-coupled accents (both assume a dark section).
// champagne-outline is section-aware — computed in champagneOutlineSurface.
const ACCENT_SURFACE: Record<'champagne-fill' | 'cream-tint', string> = {
  'champagne-fill':
    'relative bg-obsidian/90 px-8 py-10 sm:px-10 sm:py-12 overflow-hidden',
  'cream-tint':
    'relative bg-cream/95 px-8 py-10 sm:px-10 sm:py-12 transition-colors hover:bg-cream',
}

// champagne-outline adapts to the section background so it never decays to
// mud. Dark section → transparent card + champagne hairline border (crisp
// gold on near-black). Light section → the quiet ivory fill that reads as
// a soft editorial card on cream/ivory.
function champagneOutlineSurface(onDark: boolean): string {
  const base = 'relative px-8 py-10 sm:px-10 sm:py-12 transition-colors group'
  return onDark
    ? clsx(base, 'border border-champagne/35 hover:border-champagne/70 hover:bg-champagne/[0.05]')
    : clsx(base, 'bg-ivory/60 backdrop-blur-sm hover:bg-ivory/90')
}

export function LxIconBox({
  data,
  inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_icon_box'>
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const headClass = isToken ? TONE_HEAD[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const isCenter = data.alignment === 'center'

  // champagne-outline adapts to the ancestor section's surface; the other
  // two accents carry their own (dark-section) ground.
  const surfaceClass =
    data.accent === 'champagne-outline'
      ? champagneOutlineSurface(isSectionSurfaceDark(sectionMeta))
      : ACCENT_SURFACE[data.accent]

  const card = (
    <div
      className={clsx(
        surfaceClass,
        isCenter ? 'text-center' : 'text-left',
        outerClass,
      )}
    >
      {data.accent === 'champagne-fill' && (
        <div aria-hidden="true" className="lx-glow-champagne absolute inset-0 opacity-60" />
      )}
      <div className={clsx('relative flex flex-col gap-4', isCenter ? 'items-center' : 'items-start')}>
        <div className="relative inline-flex h-14 w-14 items-center justify-center">
          <div aria-hidden="true" className="lx-glow-champagne-icon absolute inset-0" />
          <IconByName
            name={data.icon}
            className="relative h-8 w-8 text-champagne"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </div>
        {inlineEdit ? (
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="headline"
            kind="plain"
            initialValue={data.headline}
            as="h3"
            className={clsx(
              'font-serif font-semibold text-2xl tracking-tight',
              headClass,
            )}
            style={customColor ? { color: customColor } : undefined}
            placeholder="Headline"
          />
        ) : (
          <h3
            className={clsx(
              'font-serif font-semibold text-2xl tracking-tight',
              headClass,
            )}
            style={customColor ? { color: customColor } : undefined}
          >
            {data.headline}
          </h3>
        )}
        {inlineEdit ? (
          <InlineEditable
            blockId={inlineEdit.blockId}
            blockVersion={inlineEdit.blockVersion}
            pageId={inlineEdit.pageId}
            pageVersion={inlineEdit.pageVersion}
            initialData={data}
            field="body"
            kind="text"
            initialValue={data.body ?? ''}
            as="p"
            className={clsx(
              'font-sans text-base leading-relaxed',
              bodyClass,
            )}
            style={customColor ? { color: customColor, opacity: 0.8 } : undefined}
            placeholder="Supporting copy (optional)"
          />
        ) : (
          data.body && (
            <p
              className={clsx(
                'font-sans text-base leading-relaxed',
                bodyClass,
              )}
              style={customColor ? { color: customColor, opacity: 0.8 } : undefined}
            >
              {data.body}
            </p>
          )
        )}
      </div>
    </div>
  )

  const linked = data.link ? (
    <a
      href={data.link.href}
      target={data.link.openInNew ? '_blank' : undefined}
      rel={data.link.openInNew ? 'noopener noreferrer' : undefined}
      className="block"
    >
      {card}
    </a>
  ) : (
    card
  )

  if (data.animation === 'none') return linked
  return <MotionTarget preset={data.animation}>{linked}</MotionTarget>
}
