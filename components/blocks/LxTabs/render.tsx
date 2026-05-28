'use client'
import { useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'
import {
  isColorToken,
  resolveColorValue,
} from '@/lib/cms/designTokens'

// Luxury tabs — product-page tabbed sections. Each tab carries
// richtext body so operators can drop in mid-length editorial copy.
// Tab labels use the lx_eyebrow tracking treatment so the row reads
// as part of the editorial system.
//
// ARIA tabs pattern (WAI-ARIA APG):
//   - role="tablist" on the row, with `aria-orientation="horizontal"`.
//   - role="tab" on each button, with `aria-selected`, `aria-controls`,
//     and `tabIndex` (0 on the active tab, -1 elsewhere — keyboard
//     focus tracks the active tab, not every tab).
//   - role="tabpanel" on the body, with `aria-labelledby` pointing at
//     the active tab's id.
//   - Keyboard: ArrowLeft / ArrowRight cycle, Home / End jump to first
//     / last. Tab key exits the tablist (focus moves to the panel —
//     because tabIndex=0 on the panel is implicit when it owns a
//     focusable child via dangerouslySetInnerHTML, otherwise we set
//     tabIndex=0 explicitly so screen-readers can read the body).

const TONE_LABEL: Record<string, string> = {
  obsidian: 'text-warm-stone',
  ivory: 'text-ivory/65',
}

const TONE_LABEL_ACTIVE: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_BODY: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
}

const TONE_RULE: Record<string, string> = {
  obsidian: 'border-warm-stone/30',
  ivory: 'border-ivory/20',
}

export function LxTabs({
  data,
  // Per-item inline-edit (label + body_richtext on each tabs[] entry)
  // is a follow-up. Operators edit via the EditDrawer's repeater; the
  // field paths are still registered in INLINE_EDITABLE_FIELDS.
  inlineEdit: _inlineEdit,
  outerClass,
}: {
  data: BlockData<'lx_tabs'>
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  const [active, setActive] = useState(data.defaultIndex)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // Unique base id per render so two LxTabs widgets on the same page
  // don't share aria-controls/aria-labelledby IDs.
  const baseId = useId()

  const tone = data.tone
  const isToken = isColorToken(tone)
  const labelClass = isToken ? TONE_LABEL[tone] : undefined
  const labelActiveClass = isToken ? TONE_LABEL_ACTIVE[tone] : undefined
  const bodyClass = isToken ? TONE_BODY[tone] : undefined
  const ruleClass = isToken ? TONE_RULE[tone] : undefined
  const customColor = !isToken ? resolveColorValue(tone) : undefined

  const safeActive = active >= 0 && active < data.tabs.length ? active : 0

  const tabId = (idx: number) => `${baseId}-tab-${idx}`
  const panelId = (idx: number) => `${baseId}-panel-${idx}`

  const focusTab = (idx: number) => {
    setActive(idx)
    // Move focus to the new tab so the operator's keyboard navigation
    // tracks their selection (the standard APG behaviour).
    requestAnimationFrame(() => {
      tabRefs.current[idx]?.focus()
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const last = data.tabs.length - 1
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        focusTab(idx === last ? 0 : idx + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        focusTab(idx === 0 ? last : idx - 1)
        break
      case 'Home':
        e.preventDefault()
        focusTab(0)
        break
      case 'End':
        e.preventDefault()
        focusTab(last)
        break
    }
  }

  const tabs = data.tabs.map((t, idx) => {
    const isActive = idx === safeActive
    return (
      <button
        key={idx}
        ref={(el) => {
          tabRefs.current[idx] = el
        }}
        type="button"
        role="tab"
        id={tabId(idx)}
        aria-selected={isActive}
        aria-controls={panelId(idx)}
        tabIndex={isActive ? 0 : -1}
        onClick={() => setActive(idx)}
        onKeyDown={(e) => onKeyDown(e, idx)}
        className={clsx(
          'relative font-sans text-xs font-semibold uppercase tracking-eyebrow py-3 px-1 transition-colors',
          isActive ? labelActiveClass : labelClass,
          'hover:text-champagne',
        )}
        style={
          isActive && customColor ? { color: customColor } : undefined
        }
      >
        {t.label}
        {isActive && (
          <span
            aria-hidden="true"
            className="absolute -bottom-px left-0 right-0 h-px bg-champagne"
          />
        )}
      </button>
    )
  })

  const body = data.tabs[safeActive]?.body_richtext ?? ''

  const composed = (
    <div className={clsx('flex flex-col w-full max-w-3xl mx-auto', outerClass)}>
      <div
        className={clsx(
          'flex flex-wrap gap-8 border-b',
          ruleClass,
          data.alignment === 'center' ? 'justify-center' : 'justify-start',
        )}
        role="tablist"
        aria-orientation="horizontal"
      >
        {tabs}
      </div>
      <div
        id={panelId(safeActive)}
        role="tabpanel"
        aria-labelledby={tabId(safeActive)}
        tabIndex={0}
        className={clsx(
          'mt-8 font-sans text-base leading-relaxed prose prose-luxury max-w-none',
          bodyClass,
        )}
        style={customColor ? { color: customColor } : undefined}
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  )

  if (data.animation === 'none') return composed
  return <MotionTarget preset={data.animation}>{composed}</MotionTarget>
}
