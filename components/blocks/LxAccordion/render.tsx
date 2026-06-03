import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'
import { adaptToneForSurface, type SectionMeta } from '@/lib/cms/blockMeta'

// Luxury accordion — FAQ with smooth open/close motion. Uses native
// <details>/<summary> so it works without JS (SSR-friendly, screen
// readers get the right semantics, no "use client" needed). The
// chevron rotates via CSS `details[open]` selector.
//
// variant 'list' renders every body permanently visible (a quiet
// FAQ-as-reading-room treatment) — collapses to a divider stack.

const TONE_TITLE: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_BODY: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/75',
}

const TONE_RULE: Record<string, string> = {
  obsidian: 'border-warm-stone/30',
  ivory: 'border-ivory/20',
}

export function LxAccordion({
  data,
  // inlineEdit threading accepted for dispatcher-type compatibility.
  // Per-item inline-edit (title + body_richtext on each items[] entry)
  // is a follow-up. Operators today edit items via the EditDrawer's
  // repeater; the field paths are still registered in
  // INLINE_EDITABLE_FIELDS so the future overlay implementation needs
  // only the renderer change.
  inlineEdit: _inlineEdit,
  outerClass,
  sectionMeta,
}: {
  data: BlockData<'lx_accordion'>
  inlineEdit?: InlineEditContext
  outerClass?: string
  sectionMeta?: SectionMeta
}) {
  const tone = adaptToneForSurface(data.tone, sectionMeta)
  const isToken = isColorToken(tone)
  const titleClass = isToken ? TONE_TITLE[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const ruleClass = isToken ? TONE_RULE[tone] : undefined
  const titleStyle = !isToken ? { color: resolveColorValue(tone) } : undefined

  const items = data.items.map((item, idx) => {
    if (data.variant === 'list') {
      return (
        <div
          key={idx}
          className={clsx('flex flex-col gap-4 py-8 border-t', ruleClass)}
        >
          <h3
            className={clsx(
              'font-serif font-semibold text-2xl tracking-tight',
              titleClass,
            )}
            style={titleStyle}
          >
            {item.title}
          </h3>
          <div
            className={clsx('font-sans text-base leading-relaxed', bodyClass)}
            dangerouslySetInnerHTML={{ __html: item.body_richtext }}
          />
        </div>
      )
    }
    return (
      <details
        key={idx}
        open={idx === data.defaultOpen}
        className={clsx('group border-t py-6', ruleClass)}
      >
        <summary
          className={clsx(
            'flex cursor-pointer items-center justify-between gap-6 list-none',
            'font-serif font-semibold text-xl tracking-tight',
            'transition-colors hover:text-champagne',
            titleClass,
          )}
          style={titleStyle}
        >
          <span>{item.title}</span>
          <ChevronDown
            className="h-5 w-5 shrink-0 text-champagne transition-transform duration-300 group-open:rotate-180"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </summary>
        <div
          className={clsx(
            'mt-4 font-sans text-base leading-relaxed',
            bodyClass,
          )}
          dangerouslySetInnerHTML={{ __html: item.body_richtext }}
        />
      </details>
    )
  })

  // Closing rule for the last item so the stack has top + bottom rules.
  const stack = (
    <div className={clsx('flex flex-col w-full max-w-3xl mx-auto', outerClass)}>
      {items}
      <div className={clsx('border-t', ruleClass)} />
    </div>
  )

  if (data.animation === 'none') return stack
  return <MotionTarget preset={data.animation}>{stack}</MotionTarget>
}
