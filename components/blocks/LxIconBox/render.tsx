import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { IconByName } from '@/components/project-sections/_shared/IconByName'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury icon box — single card with icon + headline + body + optional
// link. For a row of cards, compose three lx_icon_box widgets inside
// threeCols. Accent controls the surface treatment:
//   champagne-fill    — champagne radial glow on obsidian-ish ground
//                       (marquee feature)
//   champagne-outline — quiet ivory surface, champagne ring on hover
//                       (default editorial)
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

const ACCENT_SURFACE: Record<BlockData<'lx_icon_box'>['accent'], string> = {
  'champagne-fill':
    'relative bg-obsidian/90 px-8 py-10 sm:px-10 sm:py-12 overflow-hidden',
  'champagne-outline':
    'relative bg-ivory/60 backdrop-blur-sm px-8 py-10 sm:px-10 sm:py-12 transition-colors hover:bg-ivory/90 group',
  'cream-tint':
    'relative bg-cream/95 px-8 py-10 sm:px-10 sm:py-12 transition-colors hover:bg-cream',
}

export function LxIconBox({
  data,
  inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_icon_box'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const tone = data.tone
  const isToken = isColorToken(tone)
  const headClass = isToken ? TONE_HEAD[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const isCenter = data.alignment === 'center'

  const card = (
    <div
      className={clsx(
        ACCENT_SURFACE[data.accent],
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
