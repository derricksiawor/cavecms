'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { RotateCcw, X, Link2 } from 'lucide-react'
import clsx from 'clsx'
import type { SpacingMeta, SpacingValue } from '@/lib/cms/spacingClasses'
import { SpacingStepper } from './SpacingStepper'

// Per-side padding + margin editor anchored under the SpacingToolbar
// trigger. Two 4-up stepper rows (T / R / B / L for padding, same for
// margin), plus an "Apply to all sides" link per axis and a global
// Reset to default button. Auto-save is owned by the parent toolbar —
// this popover just emits onChange events with the next full
// SpacingMeta blob.
//
// Focus management:
//   - First stepper's tier-label span (always tabIndex={0}, never
//     disabled) receives focus on mount so the operator can immediately
//     step via ArrowUp/Down and tab through the grid. Focusing a
//     disabled stepper button would silently no-op.
//   - Esc dispatches onClose; SpacingToolbar's closePopover flushes
//     any pending debounced save before unmount.

export interface SpacingPopoverProps {
  value: SpacingMeta
  onChange: (next: SpacingMeta) => void
  onClose: () => void
  /** When the auto-save fails (409 / network) the toolbar surfaces a
   *  one-line hint inside the popover so the operator knows their
   *  click didn't land. Null when no error. */
  errorMessage: string | null
  /** Identifier for the affected element kind — drives the popover
   *  heading copy. */
  kindLabel: 'Section' | 'Column' | 'Widget'
  /** F7 — id of the block whose SpacingToolbar opened this popover.
   *  Used to scope the trigger lookup to the OWNER toolbar. Without
   *  this, a global `[data-spacing-toolbar-trigger][aria-expanded="true"]`
   *  query can match the WRONG toolbar in nested-toolbar UX races
   *  (section + child widget both transiently aria-expanded during a
   *  fast click). Optional so callers that don't pass it fall through
   *  to the legacy global selector — the trigger lookup only drives
   *  the vertical-flip calculation, so a near-miss is benign (popover
   *  stays below the trigger as default). */
  blockId?: number
}

const SIDES: Array<{
  key: 'Top' | 'Right' | 'Bottom' | 'Left'
  pad: keyof SpacingMeta
  mar: keyof SpacingMeta
}> = [
  { key: 'Top', pad: 'paddingTop', mar: 'marginTop' },
  { key: 'Right', pad: 'paddingRight', mar: 'marginRight' },
  { key: 'Bottom', pad: 'paddingBottom', mar: 'marginBottom' },
  { key: 'Left', pad: 'paddingLeft', mar: 'marginLeft' },
]

export function SpacingPopover({
  value,
  onChange,
  onClose,
  errorMessage,
  kindLabel,
  blockId,
}: SpacingPopoverProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const firstLabelRef = useRef<HTMLSpanElement | null>(null)
  const headingId = useId()

  // Edge-aware positioning. The popover is anchored under the
  // SpacingToolbar trigger via `left-1/2 -translate-x-1/2`, which
  // centres it on the trigger. With a 620-wide popover, a trigger
  // near the viewport edge would push it off-screen. We measure the
  // wrapper's bounding rect on mount + on every resize/scroll, and
  // add a corrective px shift (`edgeShift`) so the popover sits at
  // least `EDGE_PAD` from either viewport edge. The shift is composed
  // into the existing transform via inline style — Tailwind's
  // -translate-x-1/2 utility class still applies and the inline
  // transform overrides cleanly without fighting the JIT class.
  //
  // Vertical: when the popover would clip below the viewport (trigger
  // near the bottom edge), flip to render ABOVE the trigger. Same
  // measurement pattern as horizontal — measure the wrapper's own
  // bottom against the viewport and toggle `placeAbove` accordingly.
  const [edgeShift, setEdgeShift] = useState(0)
  const [placeAbove, setPlaceAbove] = useState(false)
  const EDGE_PAD = 8
  useLayoutEffect(() => {
    const measure = () => {
      const wrap = wrapperRef.current
      if (!wrap) return
      const r = wrap.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      let shift = 0
      if (r.left < EDGE_PAD) shift = EDGE_PAD - r.left
      else if (r.right > vw - EDGE_PAD) shift = vw - EDGE_PAD - r.right
      setEdgeShift((prev) => (Math.abs(prev - shift) < 0.5 ? prev : shift))
      // Vertical flip: read the trigger button directly via its
      // stable selector (the SpacingToolbar tags it with
      // data-spacing-toolbar-trigger={blockId}). The popover is
      // rendered as a sibling of the trigger inside a React fragment,
      // so the trigger is reliably present in the DOM while the
      // popover is mounted.
      //
      // F7 — scope the lookup to THIS block's trigger when blockId is
      // provided. The previous global selector could match the WRONG
      // toolbar during nested-toolbar UX races (e.g. a section's
      // SpacingPopover briefly mounted while the child widget's
      // toolbar is still aria-expanded). Falls back to the
      // first-aria-expanded match if blockId is omitted by a legacy
      // caller.
      const triggerEl =
        blockId !== undefined
          ? document.querySelector<HTMLElement>(
              `[data-spacing-toolbar-trigger="${blockId}"]`,
            )
          : document.querySelector<HTMLElement>(
              '[data-spacing-toolbar-trigger][aria-expanded="true"]',
            )
      if (!triggerEl) return
      const tr = triggerEl.getBoundingClientRect()
      const h = r.height
      const spaceBelow = vh - tr.bottom
      const spaceAbove = tr.top
      // Flip ABOVE when below doesn't fit AND above has more room.
      // Stay BELOW when both fit (default), or both clip (let it
      // clip below — at least the operator can scroll the page to
      // reach the popover).
      const shouldPlaceAbove =
        spaceBelow < h + EDGE_PAD && spaceAbove > spaceBelow
      setPlaceAbove((prev) => (prev === shouldPlaceAbove ? prev : shouldPlaceAbove))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [blockId])

  // Focus the first stepper's tier-label span on mount. The label is
  // always tabIndex={0} (never disabled), accepts ArrowUp/Down to step
  // the tier, and is fully keyboard-reachable — avoids the focus-into-
  // disabled-button no-op when the popover opens mid-save.
  useEffect(() => {
    firstLabelRef.current?.focus()
  }, [])

  // Esc closes the popover. The listener is lifecycle-scoped (added
  // on mount, removed on unmount) so it only exists while the popover
  // is visible. We do NOT gate on `document.activeElement` being
  // inside the wrapper — an operator who clicks the canvas after
  // opening the popover moves focus to body; Esc should still close
  // the popover (matching Wix/Webflow precedent). Stacked surfaces
  // (e.g. EditDrawer) attach their own document-level Esc handlers;
  // each fires independently and is idempotent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Outside-click dismiss. Listening on pointerdown (capture phase) so
  // the popover closes on the FIRST down-press even if the target
  // stops the click from bubbling — without this an operator who
  // clicks back into the canvas to inspect what they're editing has
  // to find the X button to dismiss. Clicks INSIDE the wrapper are
  // shielded by the contains() check. The SpacingToolbar's toggle
  // button (data-spacing-toolbar-trigger) is also excluded — that
  // button has its own toggle-on-click semantics; closing via this
  // handler would race with the toggle's onClick and re-open the
  // popover in the same gesture.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const wrap = wrapperRef.current
      if (!wrap) return
      const target = e.target as Element | null
      if (!target) return
      if (wrap.contains(target)) return
      if (target.closest('[data-spacing-toolbar-trigger]')) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  const setTier = (key: keyof SpacingMeta, next: SpacingValue | undefined) => {
    // 'none' is a real tier — the operator's "explicit 0" — so we
    // keep it in the meta blob (not strip). Stripping would resurrect
    // the wrapper's natural padding, which is NOT what the operator
    // asked for when they clicked the lowest step. A numeric `next`
    // takes the px branch in spacingClass/spacingStyle downstream.
    //
    // `next === undefined` is the operator's "untouch" signal from
    // the SpacingStepper (px input cleared). We DELETE the key from
    // the merged blob rather than setting it to undefined — assigning
    // `[key]: undefined` would leave the key present on the object
    // (an own-property whose value is undefined), which the parent
    // toolbar's set-preview merge would treat as "clear this axis"
    // correctly, but `extractSpacing`/`pickSpacing` operates on the
    // axis list directly so the result is the same. Deleting is the
    // cleaner contract.
    const merged: SpacingMeta = { ...value }
    if (next === undefined) {
      delete merged[key]
    } else {
      merged[key] = next
    }
    onChange(merged)
  }

  const applyToAll = (axis: 'padding' | 'margin') => {
    // Use the Top side as the reference for the "apply to all"
    // gesture — matches Webflow's UX. Default to 'none' if Top is
    // currently undefined.
    const refKey: keyof SpacingMeta =
      axis === 'padding' ? 'paddingTop' : 'marginTop'
    const ref = value[refKey] ?? 'none'
    const merged: SpacingMeta = { ...value }
    if (axis === 'padding') {
      merged.paddingTop = ref
      merged.paddingRight = ref
      merged.paddingBottom = ref
      merged.paddingLeft = ref
    } else {
      merged.marginTop = ref
      merged.marginRight = ref
      merged.marginBottom = ref
      merged.marginLeft = ref
    }
    onChange(merged)
  }

  const reset = () => {
    // Clear ALL 8 axes so the wrapper's natural padding takes over.
    onChange({})
  }

  return (
    <div
      ref={wrapperRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      className={clsx(
        // Horizontal two-column layout: Padding | Margin side-by-side
        // so the popover stays SHORT and the operator can still see
        // the block they're editing. Width tuned for two 4-up stepper
        // grids + a divider; max-w-[95vw] keeps it usable on narrow
        // viewports without clipping past the screen edge.
        'pointer-events-auto absolute left-1/2 z-30 w-[620px] max-w-[95vw] -translate-x-1/2',
        // Vertical placement: default below the trigger; flip above
        // when the layoutEffect detects the popover would clip past
        // the viewport bottom.
        placeAbove ? 'bottom-full mb-2' : 'top-full mt-2',
        'rounded-2xl bg-near-black/98 p-4 text-cream-50 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)] backdrop-blur-sm',
        'animate-bwc-fade-in',
      )}
      style={
        edgeShift !== 0
          ? // Compose the corrective shift WITH the Tailwind
            // -translate-x-1/2 (centre anchor). Inline style wins over
            // the JIT class, so we re-emit both halves of the transform.
            { transform: `translateX(calc(-50% + ${edgeShift}px))` }
          : undefined
      }
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between">
        <p
          id={headingId}
          className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cream-50/70"
        >
          {kindLabel} spacing
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close spacing editor"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-cream-50/70 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>

      {/* Two-column grid: Padding | Margin. The middle vertical
          divider is a 1px column-gap painted via the right border on
          the Padding panel so the layout collapses cleanly when the
          popover is squeezed below ~520px on small viewports. */}
      <div className="grid grid-cols-2 gap-4">
        <div className="border-r border-cream-50/10 pr-4">
          <PopoverAxis
            title="Padding"
            sideKey="pad"
            value={value}
            onChange={setTier}
            onApplyAll={() => applyToAll('padding')}
            firstLabelRef={firstLabelRef}
          />
        </div>
        <div className="pl-0">
          <PopoverAxis
            title="Margin"
            sideKey="mar"
            value={value}
            onChange={setTier}
            onApplyAll={() => applyToAll('margin')}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-cream-50/10 pt-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-full bg-cream-50/8 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50/85 transition-colors hover:bg-cream-50/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
        >
          <RotateCcw size={11} strokeWidth={2.4} aria-hidden="true" />
          Reset
        </button>
        {errorMessage && (
          <p
            role="alert"
            className="text-[10px] font-medium text-red-300 max-w-[220px] text-right"
          >
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  )
}

interface AxisProps {
  title: 'Padding' | 'Margin'
  sideKey: 'pad' | 'mar'
  value: SpacingMeta
  onChange: (key: keyof SpacingMeta, next: SpacingValue | undefined) => void
  onApplyAll: () => void
  firstLabelRef?: React.RefObject<HTMLSpanElement | null>
}

function PopoverAxis({
  title,
  sideKey,
  value,
  onChange,
  onApplyAll,
  firstLabelRef,
}: AxisProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50/55">
          {title}
        </p>
        <button
          type="button"
          onClick={onApplyAll}
          className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.14em] text-copper-300 transition-colors hover:text-copper-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 rounded"
        >
          <Link2 size={10} strokeWidth={2.4} aria-hidden="true" />
          All sides
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {SIDES.map((s, i) => {
          const k = (sideKey === 'pad' ? s.pad : s.mar) as keyof SpacingMeta
          return (
            <SpacingStepper
              key={s.key}
              sideLabel={s.key.charAt(0)}
              value={value[k]}
              onChange={(next) => onChange(k, next)}
              axis={sideKey === 'pad' ? 'padding' : 'margin'}
              labelRef={i === 0 && title === 'Padding' ? firstLabelRef : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}
