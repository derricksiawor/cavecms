'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'
import { safeStorage } from '@/lib/client/safeStorage'

// Side drawer with overlay. Mobile (<sm) takes the full width;
// desktop renders a 480px panel. Two tones supported via the
// optional `tone` prop:
//   - 'light' (default): cream-50 background + warm-stone hairline.
//     Used by MediaPickerModal + admin LeadsTable (light-on-light).
//   - 'dark': near-black background + cream-50/15 hairline. Used by
//     EditDrawer where the operator wants the form chrome to feel
//     purposeful rather than "blank white page".
// Escape and overlay click both close.
//
// `resizable` (opt-in): renders a thin drag handle on the drawer's
// inner edge so the operator can pull the panel narrower than its
// max (the `width` prop becomes the upper bound, MIN_DRAWER_WIDTH
// the lower). Preference persists in localStorage under
// `resizeStorageKey` (defaults to a width-bucket key). Only takes
// effect at sm:+ — at <sm the drawer is still full-width.
export function Drawer({
  open,
  onClose,
  children,
  side = 'right',
  width = 'md',
  tone = 'light',
  resizable = false,
  resizeStorageKey,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  side?: 'left' | 'right'
  width?: 'md' | 'lg' | 'xl'
  tone?: 'light' | 'dark'
  resizable?: boolean
  resizeStorageKey?: string
}) {
  // Mirror onClose in a ref so the open-bound effect doesn't re-run
  // (and churn the scroll-lock counter + keydown listener) every time
  // a parent re-renders with a freshly-allocated callback. Post-Chunk-B
  // the EditableBlock / EditableSection / EditableColumn parents
  // re-render on every InlineEditContext dispatch — onClose=()=>setOpen
  // (false) is a new function identity on each of those renders.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    // Lock body scroll behind the drawer — counter-based so stacked
    // modals (e.g. Confirm inside the drawer) all release correctly.
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseScrollLock()
    }
  }, [open])

  const maxWidth = width === 'xl' ? 640 : width === 'lg' ? 560 : 480
  const storageKey = resizeStorageKey ?? `bwc:drawer-width:${width}`

  // Saved width is clamped on read so a stale entry from a wider
  // bucket (operator switched a drawer's `width` prop in code) can't
  // exceed the new max. SSR returns the MIN for resizable drawers
  // (the narrowest comfortable state — operator pulls wider when
  // they need the room) and the MAX for non-resizable ones (the
  // pre-resize default). The post-mount effect below hydrates the
  // operator's saved preference without a hydration-mismatch flash.
  // `currentWidth` holds the OPERATOR'S intended width — bounded only
  // by [MIN, maxWidth]. The viewport-narrow clamp is applied at the
  // render site (not stored in state) so the operator's preference
  // survives a temporary viewport shrink: narrow chrome → drawer
  // renders smaller; re-widen → drawer expands back to the preferred
  // width. Post-agent-review R2 (Chunk K).
  const [currentWidth, setCurrentWidth] = useState<number>(
    resizable ? MIN_DRAWER_WIDTH : maxWidth,
  )
  useEffect(() => {
    if (!resizable) return
    const saved = safeStorage.get(storageKey)
    if (saved === null) return
    const n = Number(saved)
    if (!Number.isFinite(n)) return
    const clamped = Math.min(maxWidth, Math.max(MIN_DRAWER_WIDTH, n))
    setCurrentWidth(clamped)
  }, [maxWidth, resizable, storageKey])

  // Track viewport ≥ sm so we know when to apply the inline px width
  // vs. let Tailwind's w-full class own the <sm full-bleed layout.
  // Init function reads matchMedia synchronously on the client — so
  // the first client render matches actual viewport, no flicker
  // (desktop layout → re-paint as mobile bottom-sheet) and no React
  // hydration-mismatch warning if a future caller ever initialises
  // open=true at mount. SSR returns `true` because matchMedia is
  // window-only; the drawer only renders when open=true, which is
  // operator-triggered post-hydration in every known call site.
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia('(min-width: 640px)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const m = window.matchMedia('(min-width: 640px)')
    const apply = () => setIsDesktop(m.matches)
    apply()
    m.addEventListener('change', apply)
    return () => m.removeEventListener('change', apply)
  }, [])

  // Viewport cap — the maximum width the drawer can RENDER at given
  // the current viewport (leaving a 40px gutter so the overlay
  // outside is still tappable). Tracked as state so re-renders fire
  // on browser resize; the render site composes Math.min(currentWidth,
  // viewportCap, maxWidth) so the operator's preferred currentWidth
  // is preserved across temporary viewport narrowing. Post-agent-
  // review R2 (Chunk K).
  const [viewportCap, setViewportCap] = useState<number>(() => {
    if (typeof window === 'undefined') return maxWidth
    return Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 40)
  })
  useEffect(() => {
    if (!resizable || typeof window === 'undefined') return
    const onResize = () => {
      setViewportCap(Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 40))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resizable])

  // Drag state — kept in a ref so the pointermove closure reads the
  // start anchor without re-binding on every width change.
  const dragStartRef = useRef<{ clientX: number; startWidth: number } | null>(
    null,
  )
  // Latest width mirror for the pointerup persistence step — reading
  // currentWidth directly would race the trailing setState.
  const latestWidthRef = useRef(currentWidth)
  useEffect(() => {
    latestWidthRef.current = currentWidth
  }, [currentWidth])

  // Listener handles for unmount cleanup. Without this, a drawer
  // dismissed mid-drag (Esc, overlay click, parent unmount) leaks
  // pointermove/up/cancel listeners on window AND leaves the body
  // with `cursor: col-resize` + `user-select: none` — the next
  // mouse action on the page picks up the resize cursor with no
  // active drawer to drag. Self-review LOW (Chunk K post-pass).
  const dragListenersRef = useRef<{
    move: ((ev: PointerEvent) => void) | null
    up: (() => void) | null
    cancel: (() => void) | null
  }>({ move: null, up: null, cancel: null })

  // Memoised on [resizable, storageKey] so the effect deps below can
  // include teardownDrag without churning on every render — the
  // refs/latestWidthRef it reads are stable across re-renders, and
  // the resizable/storageKey deps only change when the consumer
  // remounts with a different bucket (rare).
  const teardownDrag = useCallback(() => {
    const l = dragListenersRef.current
    const wasActive = !!l.move
    if (l.move) window.removeEventListener('pointermove', l.move)
    if (l.up) window.removeEventListener('pointerup', l.up)
    if (l.cancel) window.removeEventListener('pointercancel', l.cancel)
    dragListenersRef.current = { move: null, up: null, cancel: null }
    dragStartRef.current = null
    if (typeof document !== 'undefined') {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    // Persist the in-progress drag width on EVERY teardown path —
    // not just pointerup. Without this, a drag-in-progress that's
    // interrupted by Esc / overlay click / programmatic close /
    // pointercancel / parent unmount loses the operator's pull-to-
    // resize work for the rest of their session. Post-round-2
    // review NEW-1 / Scenario 2. `wasActive` gate prevents an
    // idle teardown (e.g. unmount with no drag) from clobbering
    // localStorage with the un-mutated `latestWidthRef.current`
    // — already correct, but skip the write to avoid noise.
    if (wasActive && resizable) {
      safeStorage.set(storageKey, String(latestWidthRef.current))
    }
  }, [resizable, storageKey])

  useEffect(() => {
    // Catch-all unmount cleanup. Cheap — if no drag is active the
    // teardown is a few null-guards + style clears.
    return () => teardownDrag()
  }, [teardownDrag])

  // Open=false teardown: the parent's `if (!open) return null` below
  // does NOT unmount the Drawer component instance — React reuses it
  // and skips render. So an open→close transition while a drag is
  // in flight (Esc / overlay click / programmatic close) would leak
  // the pointermove/up listeners + body cursor unless we explicitly
  // tear down here. The unmount effect above only fires on actual
  // unmount, not on this conditional-render close. Post-agent-
  // review R4 (Chunk K).
  useEffect(() => {
    if (open) return
    if (dragListenersRef.current.move) teardownDrag()
  }, [open, teardownDrag])

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizable || !isDesktop) return
    e.preventDefault()
    dragStartRef.current = { clientX: e.clientX, startWidth: currentWidth }
    // While dragging, kill text selection on the rest of the page —
    // otherwise the body picks up a "selecting" cursor that fights
    // the col-resize cursor on the handle.
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    const onMove = (ev: PointerEvent) => {
      const s = dragStartRef.current
      if (!s) return
      // For a right-anchored drawer, pulling the handle LEFT widens;
      // for left-anchored, pulling RIGHT widens. The right-side case
      // is what EditDrawer uses; left-side is included for symmetry.
      const rawDelta =
        side === 'right'
          ? s.clientX - ev.clientX
          : ev.clientX - s.clientX
      const proposed = s.startWidth + rawDelta
      // Clamp ONLY to [MIN, maxWidth] (the operator's allowed range),
      // NOT to viewportCap. The render site applies the viewport cap
      // on top so dragging past the viewport edge captures the
      // intent without rendering past the edge — and the saved
      // preference survives a temporary viewport shrink. R2 (Chunk K).
      const next = Math.min(maxWidth, Math.max(MIN_DRAWER_WIDTH, proposed))
      setCurrentWidth(next)
    }
    const onUp = () => {
      // teardownDrag now handles the safeStorage.set itself (NEW-1)
      // so the persist is consistent across pointerup / pointercancel
      // / open=false teardown / unmount paths.
      teardownDrag()
    }
    // pointercancel fires when the OS / browser preempts the drag
    // (e.g., user opens a context menu, alt-tabs, or the touch is
    // interrupted). Without this handler the listeners + body
    // cursor stay attached as if the drag is still active.
    const onCancel = () => {
      teardownDrag()
    }
    dragListenersRef.current = { move: onMove, up: onUp, cancel: onCancel }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  if (!open) return null

  // When resizable + desktop, use inline px style so the operator's
  // pull-to-narrow takes effect. Otherwise fall back to the original
  // Tailwind width bucket (w-full sm:w-[…px]) — same shipping
  // behaviour for callers that don't opt in.
  const useInlineWidth = resizable && isDesktop
  const widthClass = useInlineWidth
    ? 'w-full'
    : width === 'xl'
      ? 'w-full sm:w-[640px]'
      : width === 'lg'
        ? 'w-full sm:w-[560px]'
        : 'w-full sm:w-[480px]'
  // Apply the viewport cap at render time so the operator's
  // preferred width (state) survives temporary viewport shrinks —
  // re-widening the viewport restores the drawer to the preferred
  // width. R2 (Chunk K).
  const renderWidth = useInlineWidth
    ? Math.min(currentWidth, viewportCap, maxWidth)
    : currentWidth

  // Mobile (< sm) renders as a bottom-sheet — slides up from the
  // viewport bottom, takes 85vh, anchored at the bottom with a soft
  // top-corner radius and a drag-grip glyph at the top. Desktop keeps
  // the original side-drawer layout. The branch reads from the same
  // `isDesktop` state already tracking the matchMedia listener, so a
  // window-resize across the breakpoint reflows the chrome in one
  // render pass.
  const asideStyle = useInlineWidth ? { width: `${renderWidth}px` } : undefined

  // Read the latest onClose via the ref so per-keystroke parent
  // re-renders (post-Chunk-B InlineEditContext dispatch cascade)
  // don't rebind the overlay's onClick to a new function identity
  // every paint. Symmetric with the keydown handler above.
  const overlayClick = () => {
    onCloseRef.current()
  }
  // Handle anchor: for right-anchored drawers the grip sits on the
  // LEFT edge (the inner edge that touches the canvas); for left-
  // anchored, on the RIGHT edge. The handle is rendered inside the
  // aside as absolutely-positioned so it doesn't compete with the
  // sticky header/footer's z-index inside the scroll region.
  const handleSideClass =
    side === 'right' ? '-left-px top-0' : '-right-px top-0'
  return (
    <>
      {/* Scrim has NO backdrop-blur — the operator needs to see the
          canvas they're editing. Light alpha-dim only, just enough to
          mark the drawer as the active focus surface without obscuring
          the block being edited. */}
      <div
        className="fixed inset-0 z-40 bg-near-black/20 animate-bwc-fade-in"
        onClick={overlayClick}
      />
      <aside
        // Entry animation + positioning are responsive:
        //   - Desktop: 480/560/640 px side-anchored panel, slides from
        //     the right (or left) using bwc-drawer-in.
        //   - Mobile: 85vh bottom-sheet — slides up from the bottom
        //     with rounded top corners + a drag-grip pill at the
        //     top. Uses bwc-slide-up so the entrance reads as a
        //     phone-native sheet, not a horizontal drawer.
        // `data-drawer-tone` lets globals.css cascade form-control
        // colour overrides for dark drawers without forcing every
        // ZodForm input to take a `tone` prop.
        data-drawer-tone={tone}
        style={asideStyle}
        className={
          isDesktop
            ? `fixed top-0 z-50 h-full ${widthClass} ${side === 'right' ? 'right-0 border-l' : 'left-0 border-r'} ${tone === 'dark' ? 'border-cream-50/15 bg-near-black text-cream-50' : 'border-warm-stone/20 bg-cream-50'} shadow-[0_24px_60px_-12px_rgba(5,5,5,0.45)] overflow-auto animate-bwc-drawer-in motion-reduce:animate-none`
            : `fixed inset-x-0 bottom-0 z-50 h-[85vh] max-h-[85vh] w-full rounded-t-3xl border-t ${tone === 'dark' ? 'border-cream-50/15 bg-near-black text-cream-50' : 'border-warm-stone/20 bg-cream-50'} shadow-[0_-24px_60px_-12px_rgba(5,5,5,0.45)] overflow-auto animate-bwc-slide-up motion-reduce:animate-none`
        }
        role="dialog"
        aria-modal="true"
      >
        {!isDesktop && (
          /* Drag-grip pill at the top of the mobile sheet — phone-
             native affordance signalling "this can be dismissed by
             swiping down" (even though we don't currently wire the
             swipe — the visual contract still reads correctly). */
          <div
            aria-hidden="true"
            className="sticky top-0 z-10 flex w-full items-center justify-center pt-2 pb-1"
          >
            <span
              className={`block h-1 w-10 rounded-full ${tone === 'dark' ? 'bg-cream-50/25' : 'bg-warm-stone/35'}`}
            />
          </div>
        )}
        {resizable && isDesktop && (
          <div
            // Hit area is 8px wide for comfortable mouse targeting;
            // the visible affordance is a 2px copper hairline that
            // appears on hover/active so the resting state stays
            // quiet. Hidden from <sm via the parent-level guard
            // (this whole node only renders when isDesktop).
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${tone === 'dark' ? 'editor' : 'drawer'} width`}
            // aria-valuenow reflects the RENDERED width (what the
            // operator perceives), not the un-capped preference, so
            // assistive tech reports the actual visible size.
            aria-valuenow={renderWidth}
            aria-valuemin={MIN_DRAWER_WIDTH}
            aria-valuemax={Math.min(maxWidth, viewportCap)}
            onPointerDown={onHandlePointerDown}
            className={`group absolute z-50 h-full w-2 cursor-col-resize select-none ${handleSideClass} hover:bg-copper-400/15 active:bg-copper-400/25 motion-reduce:transition-none`}
            // Inline a 1px copper hairline as a ::before-style child so
            // the visual stays centred even as the 8px hit area expands.
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 h-full w-px ${side === 'right' ? 'left-1/2 -translate-x-1/2' : 'right-1/2 translate-x-1/2'} bg-copper-400/0 transition-colors group-hover:bg-copper-400/80 group-active:bg-copper-400`}
            />
          </div>
        )}
        {children}
      </aside>
    </>
  )
}

// Smallest comfortable drawer width — keeps the EditDrawer's two-
// column form chrome (label + input) readable. Tested against the
// ZodForm's longest field-label tokens at this width without wrap.
const MIN_DRAWER_WIDTH = 360
