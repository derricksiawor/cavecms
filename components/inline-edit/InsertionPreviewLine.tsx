'use client'

// Drop-target insertion preview line. Renders a 2px copper line at the
// active drag's insertion edge — horizontal above/below the rect for
// vertical stacks (top-level + column widgets), vertical alongside
// the rect for horizontal stacks (column rows inside a section grid).
//
// MOUNT REQUIREMENT
// ─────────────────
// MUST be mounted inside a @dnd-kit DndContext — the component reads
// the active drag's `over` rect via useDndMonitor. Mounting outside
// the DndContext is a runtime error (useDndMonitor throws).
//
// Mount ONCE per page-wide DndContext (i.e. inside EditModeDndShell
// alongside the DragOverlay). Multiple instances would draw multiple
// lines on top of each other.
//
// Empty-column drops are skipped here — the EmptyColumnDroppable
// already rings itself when an active item hovers, so a redundant
// copper line on the column edge would just be visual noise.
//
// Animation: fade-in via the global animate-bwc-fade-in keyframe
// (100ms ease-standard). motion-reduce:animate-none honours the
// reduced-motion preference for vestibular sensitivity.

import { useState } from 'react'
import { useDndMonitor } from '@dnd-kit/core'

interface IndicatorPos {
  top: number
  left: number
  width: number
  height: number
}

function samePos(a: IndicatorPos | null, b: IndicatorPos | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  // Round to integer pixel: getBoundingClientRect returns floats and
  // sub-pixel drift during the operator's drag animation causes
  // strict-equal comparisons to mismatch on near-identical positions
  // → re-render every frame. Half-pixel precision is more than enough
  // for the 2px copper line.
  return (
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  )
}

export function InsertionPreviewLine() {
  const [pos, setPos] = useState<IndicatorPos | null>(null)

  // Dedup setState: dnd-kit's onDragMove fires on every pointermove (no
  // internal throttle). Without comparing against the previous indicator
  // rect each fresh `{top,left,width,height}` allocation triggers a
  // re-render even when the position hasn't actually changed (e.g. the
  // operator hovers within the same droppable for several frames). The
  // setPos(prev => ...) callback form bails out via React's Object.is
  // bailout when we return `prev` itself.
  const updatePos = (next: IndicatorPos | null) => {
    setPos((prev) => (samePos(prev, next) ? prev : next))
  }

  useDndMonitor({
    onDragMove(event) {
      const { over, active } = event
      if (!over || !active) {
        updatePos(null)
        return
      }
      const overData = over.data?.current as
        | { containerId?: number | null; kind?: string }
        | undefined
      if (overData?.kind === 'empty-column') {
        updatePos(null)
        return
      }
      const overRect = over.rect
      const activeRect = active.rect.current.translated
      if (!activeRect) {
        updatePos(null)
        return
      }
      const horizontalList = overData?.kind === 'column'
      if (horizontalList) {
        const overMidX = overRect.left + overRect.width / 2
        const activeMidX = activeRect.left + activeRect.width / 2
        const before = activeMidX < overMidX
        updatePos({
          top: overRect.top,
          left: before
            ? overRect.left - 1
            : overRect.left + overRect.width - 1,
          width: 2,
          height: overRect.height,
        })
      } else {
        const overMidY = overRect.top + overRect.height / 2
        const activeMidY = activeRect.top + activeRect.height / 2
        const above = activeMidY < overMidY
        updatePos({
          top: above
            ? overRect.top - 1
            : overRect.top + overRect.height - 1,
          left: overRect.left,
          width: overRect.width,
          height: 2,
        })
      }
    },
    onDragEnd() {
      updatePos(null)
    },
    onDragCancel() {
      updatePos(null)
    },
  })

  if (!pos) return null
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-[60] rounded-full bg-copper-500 shadow-[0_0_12px_-2px_rgba(160,90,40,0.6)] animate-bwc-fade-in motion-reduce:animate-none"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        height: pos.height,
      }}
    />
  )
}
