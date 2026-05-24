'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { SectionTemplateGallery } from './SectionTemplateGallery'

// Chunk J — gallery host. Owns open/close state for the section-
// template gallery modal so the three entry points (slash palette
// "Templates" item, OutlinePanel AddBlockMenu button, EditModeEmptyState
// secondary CTA) share the same modal instance instead of each rendering
// their own copy.
//
// Why a separate host instead of mounting <SectionTemplateGallery> at
// EditableMain directly: the gallery's open state needs to be
// reachable from anywhere in the editor surface (the three entry
// points live at different DOM depths). A context-backed host with a
// single mount keeps the gallery's keyboard focus trap and Esc
// handling in one place.

/** open() now accepts an optional returnFocus target so callers can
 *  specify where focus should land when the gallery closes. Critical
 *  for the slash-palette → gallery handoff: the palette unmounts as
 *  the gallery mounts, document.activeElement falls to body BEFORE
 *  the palette's rAF restores focus, and the gallery's mount-effect
 *  snapshot captures `body` instead of the original canvas element.
 *  Post-agent-review D1 (Chunk K). Defaults to the previous
 *  `document.activeElement`-snapshot behavior when omitted. */
interface OpenOpts {
  afterBlockId?: number
  returnFocus?: HTMLElement | null
}

interface CtxValue {
  open: (opts?: OpenOpts | number) => void
  close: () => void
  /** True while the gallery is rendered. Entry-point components read
   *  this to suppress concurrent opens / disable themselves while busy. */
  isOpen: boolean
}

const Ctx = createContext<CtxValue | null>(null)

export function SectionTemplateGalleryHost({
  pageId,
  children,
}: {
  pageId: number
  children: ReactNode
}) {
  const [openState, setOpenState] = useState<
    { afterBlockId?: number; returnFocus?: HTMLElement | null } | null
  >(null)
  const open = useCallback((opts?: OpenOpts | number) => {
    // Backward-compatible signature: callers that used open(123) or
    // open() keep working alongside the new open({ afterBlockId, returnFocus }).
    if (typeof opts === 'number') {
      setOpenState({ afterBlockId: opts })
    } else if (opts) {
      setOpenState({ afterBlockId: opts.afterBlockId, returnFocus: opts.returnFocus ?? null })
    } else {
      setOpenState({})
    }
  }, [])
  const close = useCallback(() => setOpenState(null), [])

  const value = useMemo<CtxValue>(
    () => ({ open, close, isOpen: openState !== null }),
    [open, close, openState],
  )

  // The Provider MUST wrap the editor subtree (slash palette, outline
  // panel, empty state are all consumers via useSectionTemplateGallery).
  // Earlier draft rendered { openState && <Gallery /> } as the sole
  // child — the architect-review caught that the entry-point components
  // sit OUTSIDE the Host in the EditableMain tree, so their hook reads
  // returned the placeholder (or threw in dev). The Host now wraps the
  // editor surface; the gallery modal renders alongside the children
  // when open.
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* AnimatePresence lives HERE so the gallery's exit animation
          plays AFTER conditional unmount. Earlier draft had
          AnimatePresence inside the gallery itself, but the host's
          {openState && ...} conditional unmounted the whole subtree
          before AnimatePresence could play exit. Agent-review LOW
          finding — fixed by hoisting AnimatePresence one level. */}
      <AnimatePresence>
        {openState && (
          <SectionTemplateGallery
            key="section-template-gallery"
            pageId={pageId}
            afterBlockId={openState.afterBlockId}
            returnFocus={openState.returnFocus ?? null}
            onClose={close}
          />
        )}
      </AnimatePresence>
    </Ctx.Provider>
  )
}

/** Entry points (slash palette, OutlinePanel, EmptyState) consume
 *  this hook to open the gallery. Returns a stable function bound to
 *  the host's current mount; safe in dep arrays. */
export function useSectionTemplateGallery(): CtxValue {
  const v = useContext(Ctx)
  if (!v) {
    // Non-editor mount path — never reached because every consumer is
    // inside EditableMain's editor branch. Silent no-op in production
    // to avoid crashing a public render.
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        'useSectionTemplateGallery called outside SectionTemplateGalleryHost — wrap the consumer in EditableMain’s provider chain.',
      )
    }
    return {
      open: () => undefined,
      close: () => undefined,
      isOpen: false,
    }
  }
  return v
}

// Re-export the children prop type so a future Phase-2 multi-page
// embedding can mount the host at a different scope.
export type SectionTemplateGalleryHostChildren = ReactNode
