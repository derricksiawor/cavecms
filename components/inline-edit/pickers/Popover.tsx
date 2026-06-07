'use client'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

// Absolute-positioned popover anchored to a trigger element. The
// popover renders via a portal at document.body so it escapes the
// drawer's scroll/overflow boundary — necessary because the EditDrawer
// is `overflow-auto` and a popover positioned inside would clip at
// the drawer edge. Portal + viewport-aware placement keeps the
// popover visible no matter where the trigger sits in the drawer's
// scrollable column.
//
// Closes on:
//  - Escape key
//  - click outside the popover surface (capture-phase so it fires
//    before any in-popover button onClick)
//  - parent unmount (effect cleanup releases listeners)
//
// Focus management: when opened, focus moves into the popover surface
// (first focusable child, falls back to the surface itself). On close,
// focus returns to the trigger. Tab cycling is loose — we don't trap
// (which would prevent escape via Shift+Tab to the previous field).
//
// Placement: prefers below the trigger; flips above if the popover
// would overflow the viewport bottom. Horizontal offset clamped to
// keep the popover fully on-screen with an 8px gutter.

interface PopoverProps {
  open: boolean
  onClose: () => void
  triggerRef: React.RefObject<HTMLElement | null>
  children: ReactNode
  // Optional className applied to the floating surface (border, bg,
  // shadow live here). Default = dark luxury card surface.
  surfaceClassName?: string
  // Width in px. The popover sizes to content height; width is
  // declarative so colour swatch grids etc. lay out predictably.
  width?: number
  // Label for the dialog — read by assistive tech. Required.
  ariaLabel: string
}

export function Popover({
  open,
  onClose,
  triggerRef,
  children,
  surfaceClassName,
  width = 320,
  ariaLabel,
}: PopoverProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [mounted, setMounted] = useState(false)

  // Mark mounted only on the client so the portal target (document.body)
  // is defined. Avoids the SSR hydration mismatch we'd hit by reading
  // `document` during the first render.
  useEffect(() => {
    setMounted(true)
  }, [])

  // Recompute position whenever opened, or on resize/scroll while open.
  const place = useCallback(() => {
    const trigger = triggerRef.current
    const surface = surfaceRef.current
    if (!trigger || !surface) return
    const rect = trigger.getBoundingClientRect()
    const surfaceH = surface.offsetHeight
    const surfaceW = surface.offsetWidth || width
    const margin = 8
    const vh = window.innerHeight
    const vw = window.innerWidth

    // Prefer below; flip above if not enough room below AND there is
    // room above. Otherwise pin to top edge.
    const spaceBelow = vh - rect.bottom
    const spaceAbove = rect.top
    const placeAbove =
      spaceBelow < surfaceH + margin && spaceAbove > spaceBelow
    const top = placeAbove
      ? Math.max(margin, rect.top - surfaceH - margin)
      : Math.min(vh - surfaceH - margin, rect.bottom + margin)

    // Horizontal: align left edge to trigger left, clamp to viewport.
    let left = rect.left
    if (left + surfaceW > vw - margin) left = vw - surfaceW - margin
    if (left < margin) left = margin

    setPos({ top, left })
  }, [triggerRef, width])

  // useLayoutEffect so the position is measured + applied BEFORE paint
  // — eliminates the one-frame "popover renders at (0,0) then jumps"
  // flash that useEffect would produce.
  useLayoutEffect(() => {
    if (!open) return
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    // RAF-coalesced reposition handler. Capture-phase scroll listeners
    // fire from any nested scroll container (e.g. the EditDrawer's
    // overflow-auto, the icon picker's grid). Without coalescing, each
    // tick triggered a forced layout + setState; RAF batches into one
    // per frame. `passive: true` skips the cancellable-event tax for
    // these read-only handlers.
    let raf: number | null = null
    const schedule = () => {
      if (raf != null) return
      raf = requestAnimationFrame(() => {
        raf = null
        place()
      })
    }
    window.addEventListener('resize', schedule, { passive: true })
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    return () => {
      if (raf != null) cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, { capture: true })
    }
  }, [open, place])

  // Reset pos when popover closes so the next open doesn't flash the
  // previous position before useLayoutEffect re-measures. Without this,
  // a parent layout shift between opens would show a one-frame ghost
  // at the previous trigger's coordinates.
  useEffect(() => {
    if (!open) setPos(null)
  }, [open])

  // Escape + outside-click. Capture-phase so it fires before any
  // in-popover onClick — otherwise a click on the popover's own
  // button would close the popover AND fire the button click in
  // unpredictable order across browsers. Uses pointerdown rather
  // than mousedown so touch/stylus interactions on iOS Safari don't
  // hit the 300ms synthetic-click delay (which sometimes lands on
  // an unintended descendant node).
  //
  // `suppressOutside` is a body-level data attribute that consumers
  // can set to temporarily suppress outside-click closure — used
  // by ColorPicker during the async EyeDropper invocation, where
  // a stray click on the OS overlay can otherwise reach document
  // and close the popover mid-pick.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // CAPTURE phase + stopImmediatePropagation so Esc closes ONLY this
        // popover, not the EditDrawer behind it. The drawer ALSO has a
        // window-level Esc→close listener; both are window listeners, and
        // plain stopPropagation does NOT stop a sibling listener on the
        // same target — so the old code closed the whole drawer when the
        // operator only meant to dismiss the colour/font/token popover.
        // Capture fires before the drawer's bubble-phase listener;
        // stopImmediatePropagation then prevents it from running at all.
        e.stopImmediatePropagation()
        e.preventDefault()
        onClose()
      }
    }
    const onDoc = (e: PointerEvent) => {
      if (document.body.dataset.cavecmsPopoverSuppressOutside === '1') return
      const target = e.target as Node | null
      if (!target) return
      if (surfaceRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDoc, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDoc, true)
    }
  }, [open, onClose, triggerRef])

  // Focus the first focusable child on open. On close, return focus
  // to the trigger only if (a) we still own the focus AND (b) the
  // trigger we want to restore to is still in the DOM (isConnected).
  // Without isConnected, a parent unmount mid-popover-close would
  // focus a detached node (silent but odd).
  //
  // We also stash "did the popover own focus before close?" in a ref
  // because by the time the [open=false] effect runs, the surface has
  // already unmounted (the bottom return-null guard fires first), so
  // `surfaceRef.current.contains(active)` would always be false. The
  // ref captures the verdict pre-unmount via a layout effect.
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const ownedFocusRef = useRef(false)
  useLayoutEffect(() => {
    if (!open) return
    // Snapshot the focused element BEFORE the popover steals focus.
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null
    ownedFocusRef.current = true
    const first = surfaceRef.current?.querySelector<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"]), select, textarea',
    )
    ;(first ?? surfaceRef.current)?.focus({ preventScroll: true })
    return () => {
      // Cleanup runs when `open` flips to false (or unmount). At this
      // point the surface is about to unmount; restore focus to the
      // previously-focused element if it still exists.
      if (
        ownedFocusRef.current &&
        restoreFocusRef.current &&
        restoreFocusRef.current.isConnected
      ) {
        restoreFocusRef.current.focus({ preventScroll: true })
      }
      ownedFocusRef.current = false
    }
  }, [open])

  if (!open || !mounted) return null

  const surface = (
    <div
      ref={surfaceRef}
      role="dialog"
      aria-label={ariaLabel}
      aria-modal="false"
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        // Hide pre-measurement to avoid the (0,0) flash on first paint.
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={
        // z-[90] keeps drawer-launched popovers (colour/tone picker, the
        // Globe token binder, font pickers) ABOVE the EditDrawer, which
        // portals to <body> at z-[85]. At the old z-[60] the popover
        // painted BEHIND the opaque drawer panel and read as "nothing
        // happens when I click the swatch". Stays below toasts (z-[100]).
        surfaceClassName ??
        'z-[90] rounded-2xl border border-cream-50/15 bg-near-black/95 backdrop-blur-md p-4 shadow-[0_24px_60px_-12px_rgba(5,5,5,0.65)] text-cream-50 animate-cavecms-fade-in motion-reduce:animate-none'
      }
    >
      {children}
    </div>
  )

  return createPortal(surface, document.body)
}
