'use client'

import { useEffect, useState } from 'react'
import type { SpacingMeta } from '@/lib/cms/spacingClasses'

// Translucent copper paint on the affected edges of the targeted
// container. Mounted by SpacingToolbar while the popover is open;
// fades in on mount, fades out on unmount via animate-bwc-fade-in
// (Chunk D motion tokens).
//
// The overlay is positioned ABSOLUTELY relative to the toolbar's
// nearest positioned ancestor (the Editable* wrapper that already
// has `relative` set per Chunks B–D). It measures the wrapper's
// bounding rect via getBoundingClientRect once on mount and on every
// meta change, and paints colored strips along each side that has an
// override set. Pure visual feedback — no pointer events, no a11y
// implications (aria-hidden).

export interface SpacingOverlayProps {
  /** The element the toolbar is editing — measured for size. The
   *  overlay paints flush to its edges. */
  targetRef: React.RefObject<HTMLElement | null>
  /** Current spacing meta (the in-flight blob from the popover).
   *  Only sides with a non-undefined value are painted. */
  meta: SpacingMeta
}

interface Rect {
  width: number
  height: number
}

const STRIP_PX = 6

export function SpacingOverlay({ targetRef, meta }: SpacingOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(null)

  // Track the target's dimensions. ResizeObserver fires whenever the
  // wrapper grows / shrinks (operator just bumped paddingTop, the
  // section grew taller, the overlay must follow). The observer ALSO
  // fires on ancestor-driven layout shifts (sibling section expanding,
  // viewport resize cascading down) — so no separate viewport listener
  // is needed. Falls back to a mount-only read in environments without
  // ResizeObserver.
  //
  // setRect uses an updater that short-circuits when width + height
  // haven't changed — otherwise every layout pass would allocate a
  // fresh object and re-render the strips even when the visible
  // result is identical.
  useEffect(() => {
    const el = targetRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      setRect((prev) =>
        prev && prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height },
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [targetRef])

  if (!rect) return null

  // `!== undefined` (not `!!v`) — numeric 0 is a real operator value
  // (explicit zero padding via the px input). Truthy-check would
  // silently skip painting the strip when the operator explicitly
  // zeroed a side, giving misleading visual feedback that the side
  // isn't overridden. Mirrors the isAxisSet predicate in
  // SpacingToolbar + the isSet check in hasSpacingOverride.
  const hasTop = meta.paddingTop !== undefined || meta.marginTop !== undefined
  const hasRight = meta.paddingRight !== undefined || meta.marginRight !== undefined
  const hasBottom = meta.paddingBottom !== undefined || meta.marginBottom !== undefined
  const hasLeft = meta.paddingLeft !== undefined || meta.marginLeft !== undefined

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 animate-bwc-fade-in"
    >
      {hasTop && (
        <div
          className="absolute left-0 right-0 top-0 bg-copper-400/40"
          style={{ height: STRIP_PX }}
        />
      )}
      {hasBottom && (
        <div
          className="absolute left-0 right-0 bottom-0 bg-copper-400/40"
          style={{ height: STRIP_PX }}
        />
      )}
      {hasLeft && (
        <div
          className="absolute top-0 bottom-0 left-0 bg-copper-400/40"
          style={{ width: STRIP_PX }}
        />
      )}
      {hasRight && (
        <div
          className="absolute top-0 bottom-0 right-0 bg-copper-400/40"
          style={{ width: STRIP_PX }}
        />
      )}
    </div>
  )
}
