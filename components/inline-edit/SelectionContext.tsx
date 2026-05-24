'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

// Per-page "selected block" cursor.
//
// Why this exists
// ───────────────
// Hover-only chrome (toolbars, type pills, drag handles) is unreachable
// on touch devices and ephemeral on hover-capable devices — a single
// pointer wobble dismisses the toolbar before the operator can hit a
// button. The selection cursor fixes both:
//
//   - Click on a block → block is selected → its chrome stays visible
//     until selection moves elsewhere or the operator clicks bare canvas.
//   - First tap on touch selects + reveals the toolbar; second tap on
//     a toolbar button acts. Matches Wix / Webflow / Squarespace
//     behaviour.
//
// Why per-page sessionStorage persistence
// ───────────────────────────────────────
// router.refresh() is the post-save reconciliation path used everywhere
// in the editor (drawer save, toolbar verbs, DnD). Without persistence,
// the operator's selection vanishes after every save — the toolbar
// collapses and they have to click the block again to keep editing.
// sessionStorage keyed `bwc-selected:${pageId}` preserves the cursor
// across the refresh boundary AND scopes it per-page so cross-page
// navigation (Home → About) doesn't drag a stale id over.

export interface SelectionApi {
  selectedId: number | null
  select: (id: number | null) => void
  isSelected: (id: number) => boolean
}

const Ctx = createContext<SelectionApi | null>(null)

function storageKey(pageId: number): string {
  return `bwc-selected:${pageId}`
}

function readPersisted(pageId: number): number | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(storageKey(pageId))
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null
  } catch {
    // Safari Private Mode + locked-down enterprise browsers throw on
    // sessionStorage access. Selection just becomes session-only —
    // not a hard failure.
    return null
  }
}

function writePersisted(pageId: number, id: number | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id === null) {
      window.sessionStorage.removeItem(storageKey(pageId))
    } else {
      window.sessionStorage.setItem(storageKey(pageId), String(id))
    }
  } catch {
    // Same Safari/enterprise path as readPersisted — no observable
    // effect, the in-memory state is still authoritative for the
    // current render.
  }
}

interface ProviderProps {
  pageId: number
  children: ReactNode
}

export function SelectionProvider({ pageId, children }: ProviderProps) {
  // SSR-safe init — sessionStorage doesn't exist on the server, so the
  // initial state HAS to be null to match the server-rendered HTML
  // (otherwise React throws a hydration mismatch when a previously-
  // selected row's class flips from "default" to "selected" between
  // SSR and client first paint). The persisted id loads in the post-
  // mount effect below.
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Hydration-safe persisted-id load. Runs ONCE after first mount, and
  // again when pageId changes (Home → About SPA navigation reuses this
  // provider but the storage key is page-scoped).
  const lastPageIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (lastPageIdRef.current === pageId) return
    lastPageIdRef.current = pageId
    setSelectedId(readPersisted(pageId))
  }, [pageId])

  const select = useCallback(
    (id: number | null) => {
      setSelectedId((prev) => {
        if (prev === id) return prev
        writePersisted(pageId, id)
        return id
      })
    },
    [pageId],
  )

  // Bare-canvas click clears selection. We listen at the document level
  // (capture phase off — the wrapper handlers run e.stopPropagation
  // when the click landed on a block, so a click that reaches document
  // is by definition NOT on a block). Skip clicks inside the admin
  // chrome (sticky save bar, drawer, outline panel, toast layer) so
  // those don't double as "deselect".
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // If the click bubbled past every block wrapper, the wrappers
      // didn't claim it via stopPropagation — that means the operator
      // clicked the canvas frame. Treat this as a deselect.
      //
      // Exclude clicks inside admin chrome that lives outside the
      // canvas (drawer, toolbars, dialogs, toast) — those are admin
      // affordances acting ON the current selection, not deselects.
      if (
        target.closest(
          '[data-edit-toolbar],[data-bwc-admin-chrome],[role="dialog"],[role="menu"],[role="alertdialog"]',
        )
      ) {
        return
      }
      // Defence in depth: if the click landed inside ANY editable
      // wrapper, the wrapper's onClick already handled selection and
      // called stopPropagation. We won't see the bubble here. But if a
      // third-party portal (Radix popovers, etc.) blocks propagation
      // before we see it, we just no-op — safer than misfiring a
      // deselect.
      if (
        target.closest(
          '[data-edit-block-id],[data-edit-section-id],[data-edit-column-id]',
        )
      ) {
        return
      }
      setSelectedId((prev) => {
        if (prev === null) return prev
        writePersisted(pageId, null)
        return null
      })
    }
    window.document.addEventListener('click', onDocClick)
    return () => window.document.removeEventListener('click', onDocClick)
  }, [pageId])

  const isSelected = useCallback(
    (id: number) => selectedId === id,
    [selectedId],
  )

  const value = useMemo<SelectionApi>(
    () => ({ selectedId, select, isSelected }),
    [selectedId, select, isSelected],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

const NOOP: SelectionApi = {
  selectedId: null,
  select: () => undefined,
  isSelected: () => false,
}

/** Returns the selection API. When called outside SelectionProvider
 *  (e.g., a unit test or a misconfigured mount), returns a no-op so the
 *  Editable wrappers don't crash — they just lose persistent-selection
 *  behaviour and fall back to hover-only chrome. */
export function useSelection(): SelectionApi {
  return useContext(Ctx) ?? NOOP
}
