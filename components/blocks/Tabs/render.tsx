'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { InlineEditable } from '@/components/inline-edit/InlineEditable'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor-parity Tabs widget. Canonical Elementor fields per
// `includes/widgets/tabs.php`:
//   - tabs (repeater): tab_title + tab_content (richtext WYSIWYG)
//   - type: horizontal | vertical
//   - tabs_align_horizontal/vertical (start / center / end / stretch)
//
// BWC narrows for v1: horizontal-only (vertical adds layout-shift
// complexity the catalog doesn't justify yet — operators compose
// vertical tabs with a Section + 2 columns when they need it). The
// active-tab tracking is IDENTITY-based (we remember which item is
// active by its label), not POSITION-based — so when an operator
// reorders tabs via the EditDrawer's SortableList, the active panel
// follows the same tab rather than silently switching to whatever
// landed at that position. Falls back to position 0 when the
// originally-active label is removed from items.
//
// ARIA tabs pattern (WAI-ARIA APG):
//   - role="tablist" + role="tab" + role="tabpanel"
//   - aria-selected on the active tab
//   - aria-controls binds each tab to its panel
//   - roving tabindex (only the active tab is tab-stoppable)
//   - arrow keys cycle; Home/End jump to first/last
//   - all panels rendered in DOM (hidden when inactive) so SEO crawlers
//     see every panel's body text and screen readers can pre-traverse
//
// Click + keyboard handlers call stopPropagation so the EditableBlock
// wrapper's "click body → open drawer" handler doesn't intercept the
// operator's tab-switching gesture in edit mode.
//
// Reference URLs:
//   - https://elementor.com/help/tabs-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/tabs.php
//   - https://www.w3.org/WAI/ARIA/apg/patterns/tabs/

interface TabsItem {
  label: string
  body_richtext: string
}

interface TabsData {
  items: TabsItem[]
  default_tab_index?: number
}

// Tailwind Typography prose overrides matching the BWC palette — without
// these, anchor links inside rich text render in default prose blue and
// strong/em fall back to greyscale, breaking the editorial copper accent.
const PROSE_PALETTE =
  'prose-headings:text-near-black prose-a:text-copper-600 prose-a:no-underline hover:prose-a:underline prose-strong:text-near-black prose-em:text-copper-700 prose-li:marker:text-copper-500'

function clampedInitialIndex(data: TabsData): number {
  if (
    typeof data.default_tab_index === 'number' &&
    data.default_tab_index >= 0 &&
    data.default_tab_index < data.items.length
  ) {
    return data.default_tab_index
  }
  return 0
}

export function Tabs({
  data,
  inlineEdit,
  outerClass,
}: {
  data: TabsData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  // useId here is for stable per-instance tab/panel id prefixes so two
  // Tabs widgets on the same page never share role="tab" aria-controls
  // targets.
  const id = useId().replace(/:/g, '')

  // Identity-based active tracking: store the active tab's LABEL, not its
  // position. When the operator reorders items (positions swap but labels
  // stay), the active tab follows its content. When the operator renames
  // the active tab's label, the controlled state catches up via the
  // sync-effect below.
  const initialIdx = clampedInitialIndex(data)
  const initialLabel = data.items[initialIdx]?.label ?? null
  const [activeLabel, setActiveLabel] = useState<string | null>(initialLabel)

  // Per-tab refs so arrow-key navigation can MOVE DOM focus to the
  // newly-active tab, per WAI-ARIA APG. Setting aria-selected and
  // tabIndex=0 alone is not enough — without an explicit .focus()
  // call, keyboard-only users hear the active label but their physical
  // focus stays on the previous tab, and the next Tab keypress exits
  // the tablist instead of moving to the active tab's panel.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // focusRequestRef is set by keyboard activations only — mouse-driven
  // setActiveByIndex deliberately does NOT request focus (clicking a
  // tab should not steal focus from the user's cursor target).
  const focusRequestRef = useRef<number | null>(null)
  useEffect(() => {
    if (focusRequestRef.current === null) return
    const i = focusRequestRef.current
    focusRequestRef.current = null
    tabRefs.current[i]?.focus()
  })

  // Reconcile when default_tab_index changes mid-session (operator edits
  // the default via the EditDrawer) — without this, useState's first-
  // mount-only initialiser ignores subsequent prop changes and the live
  // render lies about the new default until page refresh.
  useEffect(() => {
    if (
      typeof data.default_tab_index === 'number' &&
      data.default_tab_index >= 0 &&
      data.default_tab_index < data.items.length
    ) {
      const nextLabel = data.items[data.default_tab_index]?.label ?? null
      setActiveLabel(nextLabel)
    }
  }, [data.default_tab_index, data.items])

  // Defensive empty-array guard runs AFTER hooks so rules-of-hooks are
  // satisfied. Zod's items.min(1) makes this unreachable via the API
  // path; the check survives a hypothetical DB restore or raw INSERT
  // that bypasses parseAndSanitize.
  if (data.items.length === 0) return null

  // Resolve label → index at render time. -1 → operator removed the
  // active tab (or first paint after rename); fall back to position 0
  // visually while leaving activeLabel untouched (the next user
  // interaction will write a fresh label).
  const foundIndex = activeLabel
    ? data.items.findIndex((t) => t.label === activeLabel)
    : -1
  const safeActive = foundIndex >= 0 ? foundIndex : 0

  const setActiveByIndex = (i: number, withFocus = false) => {
    const next = data.items[i]?.label
    if (typeof next !== 'string') return
    if (withFocus) focusRequestRef.current = i
    setActiveLabel(next)
  }

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const len = data.items.length
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      setActiveByIndex((safeActive + 1) % len, true)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      setActiveByIndex((safeActive - 1 + len) % len, true)
    } else if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      setActiveByIndex(0, true)
    } else if (e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      setActiveByIndex(len - 1, true)
    } else if (e.key === ' ' || e.key === 'Enter') {
      // Native button activation runs onClick; we only need to stop the
      // edit-mode wrapper from opening the drawer in parallel.
      e.stopPropagation()
    }
  }

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      <div
        role="tablist"
        aria-orientation="horizontal"
        className="flex gap-2 overflow-x-auto border-b border-warm-stone/20"
      >
        {data.items.map((tab, i) => (
          <button
            key={tab.label + '-' + i}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            type="button"
            role="tab"
            id={`tabs-${id}-tab-${i}`}
            aria-controls={`tabs-${id}-panel-${i}`}
            aria-selected={i === safeActive}
            tabIndex={i === safeActive ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation()
              setActiveByIndex(i)
            }}
            onKeyDown={onTabKey}
            className={clsx(
              'shrink-0 border-b-2 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] transition-colors duration-standard ease-standard min-h-[44px] motion-reduce:transition-none',
              i === safeActive
                ? 'border-copper-500 text-near-black'
                : 'border-transparent text-warm-stone hover:text-near-black',
            )}
          >
            {inlineEdit ? (
              <InlineEditable
                blockId={inlineEdit.blockId}
                blockVersion={inlineEdit.blockVersion}
                pageId={inlineEdit.pageId}
                pageVersion={inlineEdit.pageVersion}
                initialData={data}
                field="items[].label"
                arrayIndices={[i]}
                kind="plain"
                initialValue={tab.label}
                as="span"
                placeholder="Tab label"
              />
            ) : (
              tab.label
            )}
          </button>
        ))}
      </div>
      {data.items.map((tab, i) => (
        <div
          key={tab.label + '-' + i}
          id={`tabs-${id}-panel-${i}`}
          role="tabpanel"
          aria-labelledby={`tabs-${id}-tab-${i}`}
          hidden={i !== safeActive}
          className={i === safeActive ? 'mt-6' : undefined}
        >
          {inlineEdit ? (
            <InlineEditable
              blockId={inlineEdit.blockId}
              blockVersion={inlineEdit.blockVersion}
              pageId={inlineEdit.pageId}
              pageVersion={inlineEdit.pageVersion}
              initialData={data}
              field="items[].body_richtext"
              arrayIndices={[i]}
              kind="richtext"
              initialValue={tab.body_richtext}
              as="div"
              className={clsx('prose max-w-none', PROSE_PALETTE)}
              placeholder="Tab body…"
            />
          ) : (
            // server-sanitized via parseForRead — RICHTEXT_FIELDS walker
            // catches `body_richtext` at any depth
            <div
              className={clsx('prose max-w-none', PROSE_PALETTE)}
              dangerouslySetInnerHTML={{ __html: tab.body_richtext }}
            />
          )}
        </div>
      ))}
    </section>
  )
}
