'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LayoutGrid, Plus, X } from 'lucide-react'
import { WidgetPickerBody } from './WidgetPicker'

// Notion / Wix-style "drop a block here" affordance. Rendered between
// every pair of EditableBlock children on the public page in edit mode
// (plus before the first block and after the last). Sits as a thin
// invisible spacer that expands into a copper "+ Add block here" pill
// on hover; clicking opens the WIDGETS picker — the SAME search +
// categorized-pill UI as the left-pinned WidgetPicker rail — as a
// floating popover anchored beside the insert point.
//
// The popover is portaled to <body> so it "hovers" above the document
// and is never clipped by a column's overflow / transform / stacking
// context. It is placed on whichever horizontal side of the trigger has
// more room (so it's never pushed off the viewport edge), its height is
// capped to the viewport, and the option list scrolls inside — fixing
// the old inline menu that ran off the bottom of the page.
//
// `position` is OPTIONAL on the insert API — when omitted the server
// appends at the end. The popover forwards afterBlockId / beforeBlockId
// / parentId straight through WidgetPickerBody → useInsertBlock so the
// new block lands at THIS slot.

export function InsertBlockHere({
  pageId,
  afterBlockId,
  beforeBlockId,
  parentId,
}: {
  pageId: number
  // Block id this insert-point sits AFTER. Numeric → server bisects
  // sibling positions sharing parentId. Null/undefined → defer to
  // `beforeBlockId` (BEFORE-first pill) or append-to-tail.
  afterBlockId?: number | null
  // Block id this insert-point sits IMMEDIATELY BEFORE. Mutually
  // exclusive with afterBlockId.
  beforeBlockId?: number | null
  // Parent column id when this affordance lives inside an editable
  // column. Null/undefined → top-level loose widget under parent_id
  // IS NULL.
  parentId?: number | null
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Restore focus to the trigger when the popover closes (only after a
  // real open→close transition, not on initial mount).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true
      return
    }
    if (wasOpenRef.current) triggerRef.current?.focus()
    wasOpenRef.current = false
  }, [open])

  return (
    <div className="group/insert relative my-1 flex h-6 items-center justify-center">
      {/* Thin divider line, invisible until hover. When hovered, a
          copper "+ Add block here" pill appears centered on the line. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Insert a new block here"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Chunk H — when this pill lives inside a column (parentId is
        // numeric), tag it with the column id so the context menu's
        // column "Add widget" verb can find it via a stable selector and
        // click() it to open the picker. Loose pills skip the attribute.
        data-add-widget-target={typeof parentId === 'number' ? parentId : undefined}
        className="relative flex w-full items-center justify-center text-warm-stone opacity-0 transition-opacity duration-quick ease-standard hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none motion-reduce:transition-none"
      >
        <span
          aria-hidden="true"
          className="absolute inset-x-12 top-1/2 h-px -translate-y-1/2 bg-copper-400/50"
        />
        <span className="relative inline-flex items-center gap-1.5 rounded-full bg-copper-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cream-50 shadow-[0_6px_14px_-6px_rgba(160,90,40,0.6)]">
          <Plus size={11} strokeWidth={2.4} />
          Add block here
        </span>
      </button>

      {open && (
        <InsertWidgetPopover
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          pageId={pageId}
          afterBlockId={afterBlockId}
          beforeBlockId={beforeBlockId}
          parentId={parentId}
        />
      )}
    </div>
  )
}

// Exported so the empty-column slot (EditableColumn) opens the SAME
// premium floating panel as the between-blocks "Add block here" pill —
// column inserts no longer fall back to the old in-flow list picker.
export function InsertWidgetPopover({
  triggerRef,
  onClose,
  pageId,
  afterBlockId,
  beforeBlockId,
  parentId,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  pageId: number
  afterBlockId?: number | null
  beforeBlockId?: number | null
  parentId?: number | null
}) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = useState(false)
  // Which viewport edge to pin to. Same fixed top-28 / max-h-[calc(100vh-9rem)]
  // footprint as the WidgetPicker rail — we only choose the horizontal side:
  // pin to the edge FARTHER from the insert point (so the panel never sits
  // on top of / crowds the spot the new block will land). Insert point in the
  // left half → pin right; right half → pin left.
  const [side, setSide] = useState<'left' | 'right'>('left')

  useEffect(() => {
    setMounted(true)
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) {
      const centerX = (r.left + r.right) / 2
      setSide(centerX < window.innerWidth / 2 ? 'right' : 'left')
    }
  }, [triggerRef])

  // Escape + outside-click close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose, triggerRef])

  if (!mounted) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Insert a block"
      // Mirror the WidgetPicker rail exactly: fixed, top-28, capped to
      // max-h-[calc(100vh-9rem)] so it always fits the viewport with the
      // option list scrolling inside. Only the horizontal edge flips.
      className={
        'fixed top-28 z-[60] flex max-h-[calc(100vh-9rem)] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl bg-obsidian/95 text-ivory shadow-[0_24px_60px_-24px_rgba(0,0,0,0.7)] ring-1 ring-champagne/30 backdrop-blur-sm animate-cavecms-fade-in lg:w-80 motion-reduce:animate-none ' +
        (side === 'right' ? 'right-4' : 'left-4')
      }
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-champagne/15 px-4 py-3">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-champagne/15 text-champagne ring-1 ring-champagne/30"
          >
            <LayoutGrid size={13} strokeWidth={2} />
          </span>
          <span className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-champagne">
              Insert a block
            </span>
            <span className="text-[11px] font-medium text-ivory/60">
              Search or pick a widget
            </span>
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close insert menu"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ivory/60 transition-colors hover:bg-ivory/10 hover:text-ivory focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-champagne/50"
        >
          <X size={15} strokeWidth={2.2} />
        </button>
      </header>
      {/* min-h-0 lets this flex child shrink so overflow-y-auto engages
          within the height-capped panel instead of pushing it taller. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <WidgetPickerBody
          pageId={pageId}
          afterBlockId={afterBlockId}
          beforeBlockId={beforeBlockId}
          parentId={parentId}
          onInserted={onClose}
          autoFocusSearch
        />
      </div>
    </div>,
    document.body,
  )
}
