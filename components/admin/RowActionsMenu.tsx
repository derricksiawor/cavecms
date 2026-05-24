'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'

// Horizontal-ellipsis (kebab-but-horizontal) menu for per-row admin
// actions. Keeps the Actions column compact: a single 28px button
// expands into a floating panel anchored to the trigger. Built on
// createPortal so the panel can escape a table cell's overflow-hidden
// or border-radius clip without surprises.
//
// Each item gets an icon, a label, an optional destructive flag, and
// an onSelect callback. Disabled items render dimmed and are skipped
// on click. Keyboard:
//   - Enter / Space on trigger → opens
//   - Escape → closes
//   - Click outside → closes
//   - Focus restores to the trigger on close

export interface RowActionItem {
  id: string
  label: string
  icon?: LucideIcon
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
  /** Optional sub-label rendered in the menu, e.g. "remove access". */
  description?: string
}

export function RowActionsMenu({
  items,
  ariaLabel = 'Row actions',
  trigger,
}: {
  items: RowActionItem[]
  ariaLabel?: string
  /** Optional override for the trigger label (visually hidden). */
  trigger?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<
    | { top: number; left: number; maxHeight: number; placedAbove: boolean }
    | null
  >(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const id = useId()

  const close = useCallback(() => {
    setOpen(false)
    // Hand focus back to the trigger so keyboard users keep their place
    // in the table. Best-effort — the trigger may have unmounted if the
    // row vanished from the dataset.
    requestAnimationFrame(() => {
      triggerRef.current?.focus()
    })
  }, [])

  // Edge-aware positioning. The panel ALWAYS anchors `GAP` pixels from
  // the trigger (never floats far away), and picks the direction with
  // the most available room. If even the bigger side can't fit the
  // panel's natural height, we cap `maxHeight` so the panel's own
  // overflow-y-auto handles the remainder — beats sliding the panel
  // off-anchor to the viewport edge (which makes the menu look
  // disconnected from its trigger).
  //
  // Two-pass via two `useLayoutEffect`s:
  //   Pass 1: place using a height ESTIMATE so first paint is close
  //     to final.
  //   Pass 2: re-measure with the real panel height + re-decide
  //     direction if pass 1's estimate misclassified the fit.
  const GUTTER = 8
  const GAP = 6
  const PANEL_W_ESTIMATE = 224
  const PANEL_H_ESTIMATE = 280
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const roomBelow = vh - rect.bottom - GAP - GUTTER
    const roomAbove = rect.top - GAP - GUTTER
    // Prefer below; flip above only when below is materially smaller
    // AND above can hold the full estimate (avoid flipping just because
    // below is one row short).
    const placedAbove =
      roomBelow < PANEL_H_ESTIMATE && roomAbove > roomBelow
    const maxHeight = Math.max(120, placedAbove ? roomAbove : roomBelow)
    // Right-aligned to trigger.right; viewport-clamped both sides.
    let left = rect.right + window.scrollX - PANEL_W_ESTIMATE
    if (left < window.scrollX + GUTTER) left = window.scrollX + GUTTER
    if (left + PANEL_W_ESTIMATE > window.scrollX + vw - GUTTER) {
      left = window.scrollX + vw - PANEL_W_ESTIMATE - GUTTER
    }
    const top = placedAbove
      ? rect.top + window.scrollY - GAP - Math.min(maxHeight, PANEL_H_ESTIMATE)
      : rect.bottom + window.scrollY + GAP
    setCoords({ top, left, maxHeight, placedAbove })
  }, [open])

  // Pass 2: real panel rect refines placement. Adjustments stay
  // anchored to the trigger (we never slide the panel away from it);
  // we only flip direction or recompute left within the clamp.
  useLayoutEffect(() => {
    if (!open || !coords || !panelRef.current || !triggerRef.current) return
    const panelRect = panelRef.current.getBoundingClientRect()
    const trigRect = triggerRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const realH = panelRect.height
    const realW = panelRect.width
    let nextLeft = coords.left
    let nextTop = coords.top
    let nextMaxH = coords.maxHeight
    let nextAbove = coords.placedAbove

    // Re-decide vertical direction with the REAL height.
    const roomBelow = vh - trigRect.bottom - GAP - GUTTER
    const roomAbove = trigRect.top - GAP - GUTTER
    const fitsBelow = realH <= roomBelow
    const fitsAbove = realH <= roomAbove
    if (nextAbove && !fitsAbove && fitsBelow) nextAbove = false
    else if (!nextAbove && !fitsBelow && fitsAbove) nextAbove = true
    else if (!fitsBelow && !fitsAbove) {
      // Neither side fits — pick the side with more room and cap height.
      nextAbove = roomAbove > roomBelow
    }
    nextMaxH = Math.max(120, nextAbove ? roomAbove : roomBelow)
    nextTop = nextAbove
      ? trigRect.top + window.scrollY - GAP - Math.min(realH, nextMaxH)
      : trigRect.bottom + window.scrollY + GAP

    // Horizontal: clamp using REAL width.
    if (panelRect.right > vw - GUTTER) {
      nextLeft -= panelRect.right - (vw - GUTTER)
    }
    if (panelRect.left < GUTTER) {
      nextLeft += GUTTER - panelRect.left
    }
    if (nextLeft < window.scrollX + GUTTER) nextLeft = window.scrollX + GUTTER
    if (nextLeft + realW > window.scrollX + vw - GUTTER) {
      nextLeft = window.scrollX + vw - realW - GUTTER
    }

    if (
      Math.abs(nextLeft - coords.left) > 0.5 ||
      Math.abs(nextTop - coords.top) > 0.5 ||
      Math.abs(nextMaxH - coords.maxHeight) > 0.5 ||
      nextAbove !== coords.placedAbove
    ) {
      setCoords({
        top: nextTop,
        left: nextLeft,
        maxHeight: nextMaxH,
        placedAbove: nextAbove,
      })
    }
  }, [open, coords])

  // Outside click closes. Stop propagation guards against table-row
  // click handlers that might re-open the panel via React's bubbling.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node
      if (
        panelRef.current?.contains(t) ||
        triggerRef.current?.contains(t)
      ) {
        return
      }
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  // Close on scroll / resize — repositioning the floating panel during
  // a scroll feels cheap. Closing is the standard pattern (matches
  // Notion / Linear).
  useEffect(() => {
    if (!open) return
    const onScroll = () => setOpen(false)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const onSelect = (item: RowActionItem) => {
    if (item.disabled) return
    setOpen(false)
    // Microtask-defer so the parent state update from `setOpen` commits
    // BEFORE the item's onSelect potentially opens a modal — otherwise
    // the modal's scroll-lock effect runs against the still-open menu's
    // outside-click listener.
    queueMicrotask(() => item.onSelect())
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-warm-stone transition-colors hover:bg-warm-stone/10 hover:text-near-black focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/40"
      >
        {trigger ?? <MoreHorizontal size={16} strokeWidth={2} />}
      </button>
      {open &&
        coords !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            role="menu"
            aria-orientation="vertical"
            style={{
              position: 'absolute',
              top: coords.top,
              left: coords.left,
              maxHeight: coords.maxHeight,
            }}
            className="z-50 w-56 overflow-y-auto rounded-2xl border border-warm-stone/20 bg-cream-50 py-1.5 shadow-[0_20px_50px_-20px_rgba(5,5,5,0.4)] animate-bwc-fade-in"
          >
            {items.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => onSelect(item)}
                  className={clsx(
                    'flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                    item.destructive
                      ? 'text-copper-700 hover:bg-copper-50'
                      : 'text-near-black hover:bg-warm-stone/10',
                  )}
                >
                  {Icon && (
                    <Icon
                      size={15}
                      strokeWidth={1.8}
                      className="mt-0.5 shrink-0"
                    />
                  )}
                  <span className="flex-1">
                    <span className="block font-medium leading-tight">
                      {item.label}
                    </span>
                    {item.description && (
                      <span className="mt-0.5 block text-[11px] text-warm-stone">
                        {item.description}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
