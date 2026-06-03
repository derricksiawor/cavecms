'use client'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  flattenTree,
  descendantIds,
  getProjection,
  canBeChildOf,
  type OutlineItem,
  type Projection,
} from './outlineTree'
import clsx from 'clsx'
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Layers,
  Lock,
  X,
  Component as ComponentIcon,
  Columns3,
  Copy,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { safeStorage } from '@/lib/client/safeStorage'
import { MAX_SECTION_COLUMNS, type BlockKind } from '@/lib/cms/blockMeta'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import { useToast } from './Toast'
import { useSelection } from './SelectionContext'
import { useInlineEditDispatch, useInlineEditState } from './InlineEditContext'

// Tree-aware page outline (Phase-1 #5+#6 fix). Replaces the prior flat
// list that POSTed every reorder as a Mode-1 reorder (parentId
// inferred from the first block, homogeneity required). The flat
// model invited two invariant-violating moves:
//   - dragging a column to the top of the list → column with NO
//     section parent → API rejects "column_parent_must_be_section"
//   - swapping siblings under different parents → API rejects
//     "cross_parent_reorder_not_allowed"
//
// Tree model: ONE flat depth-ordered dnd-kit SortableContext (flattenTree in
// ./outlineTree). Dragging computes a grammar-constrained projection
// (getProjection) and commits either a same-parent reorder (Mode 2) or a
// cross-parent nest/reparent (Mode 3, per-block newParentId). The server
// independently re-validates the 3-level grammar + drift-completeness; the
// client projection is a live preview, never trusted.

// The outline's row shape — structurally identical to the pure module's
// OutlineItem, aliased so the projection helpers consume `items` without a cast.
type BlockSummary = OutlineItem

function iconFor(kind: BlockKind): LucideIcon {
  if (kind === 'section') return Layers
  if (kind === 'column') return Columns3
  // Widgets share one neutral glyph today (no per-type curation).
  return ComponentIcon
}

function readableBlockLabel(blockType: string, kind: BlockKind): string {
  if (kind === 'section') return 'Section'
  if (kind === 'column') return 'Column'
  return blockType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Tree construction + cycle-guard + orphan surfacing now live in ./outlineTree
// (flattenTree), which produces the single flat list this panel renders. The
// recursive buildTree this file used to host was removed with the per-parent
// SortableContext model it served.

// Indentation step (px) per depth level: each level adds INDENT_WIDTH to the
// row's base paddingLeft (0.625rem). Single source of truth — also the
// horizontal drag-to-nest projection threshold (getProjection).
const INDENT_WIDTH = 14

// Reparent a block within the flat items array, preserving every other row's
// order. buildTree/flattenTree bucket by parentId then read each bucket in
// array order, so the moved row only needs to sit at `targetIndex` AMONG the
// target parent's children — its absolute array position vs other parents is
// irrelevant. Source-parent order closes up; target-parent order opens to fit.
function applyMove(
  items: BlockSummary[],
  blockId: number,
  targetParentId: number | null,
  targetIndex: number,
): BlockSummary[] {
  const moving = items.find((b) => b.id === blockId)
  if (!moving) return items
  const movedRow: BlockSummary = { ...moving, parentId: targetParentId }
  const without = items.filter((b) => b.id !== blockId)
  const targetChildren = without.filter((b) => b.parentId === targetParentId)
  const newOrder = [...targetChildren]
  newOrder.splice(
    Math.max(0, Math.min(targetIndex, newOrder.length)),
    0,
    movedRow,
  )
  const result: BlockSummary[] = []
  let emitted = false
  for (const b of without) {
    if (b.parentId === targetParentId) {
      if (!emitted) {
        for (const t of newOrder) result.push(t)
        emitted = true
      }
      // subsequent target-parent rows already emitted in newOrder — skip
    } else {
      result.push(b)
    }
  }
  if (!emitted) result.push(movedRow) // target had no existing children
  return result
}

// Map the reorder API's error enums to user-facing copy (never leak the raw
// enum). Grammar rejections shouldn't happen — the projection blocks invalid
// drops client-side — but a concurrent edit could shift the tree under us.
function reparentErrorCopy(code?: string): string {
  switch (code) {
    case 'column_count_exceeded':
      return `That section is at the ${MAX_SECTION_COLUMNS}-column maximum.`
    case 'widget_parent_must_be_column':
    case 'column_parent_must_be_section':
    case 'section_cannot_have_parent':
    case 'column_parent_required':
    case 'cross_parent_reorder_not_allowed':
      return "That block can't go there."
    default:
      return "We couldn't save the move. Refresh the page and try again."
  }
}

interface OutlineApi {
  postReorder: (
    parentId: number | null,
    siblingsInNewOrder: BlockSummary[],
  ) => Promise<void>
}

// Viewport-class detection for the open/close persistence per-viewport
// fix (F5 — Tablet collapse-persist leak). The previous implementation
// persisted a single `cavecms:outline-open` value, so a tablet visit
// writing `false` leaked into the next desktop visit. Splitting the
// key per viewport-class fixes the leak without giving up the saved
// preference within each class.
//
// Class breakpoints mirror the Tailwind `lg:` token (1024px) used
// elsewhere in OutlinePanel's width media query, so the "class" the
// hook reports lines up with the layout class the operator is on.
// Mobile uses a narrower threshold (768px) so a phone-sized viewport
// is meaningfully distinct from a tablet — the panel barely fits on a
// phone, while iPad tolerates it.
type ViewportClass = 'mobile' | 'tablet' | 'desktop'

function classifyViewport(width: number): ViewportClass {
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

function useViewportClass(): ViewportClass {
  // SSR-stable default. The first render on the client matches the
  // server's render (desktop), then the post-mount effect reads the
  // real measure + reconciles. The hydration mismatch is impossible
  // for this hook because the value is consumed by useEffect-only
  // side effects (no DOM output) — the panel's open state is driven
  // by separate state that reacts to viewport changes.
  const [vc, setVc] = useState<ViewportClass>('desktop')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const update = () => setVc(classifyViewport(window.innerWidth))
    update()
    // matchMedia listeners avoid the resize-event spam — three queries,
    // one for each transition. window.matchMedia(...).addEventListener
    // works on every shipping browser (Safari 14+).
    const mqlMobile = window.matchMedia('(max-width: 767.98px)')
    const mqlTablet = window.matchMedia(
      '(min-width: 768px) and (max-width: 1023.98px)',
    )
    const mqlDesktop = window.matchMedia('(min-width: 1024px)')
    mqlMobile.addEventListener('change', update)
    mqlTablet.addEventListener('change', update)
    mqlDesktop.addEventListener('change', update)
    return () => {
      mqlMobile.removeEventListener('change', update)
      mqlTablet.removeEventListener('change', update)
      mqlDesktop.removeEventListener('change', update)
    }
  }, [])
  return vc
}

// Per-viewport persistence key for the outline open/close preference.
// Saved values live in three buckets so a tablet collapse no longer
// leaks into the next desktop visit. F5.
function outlineOpenStorageKey(vc: ViewportClass): string {
  return `cavecms:outline-open:${vc}`
}

// `inert` fallback for older Safari (≤16 has partial support, <14 has
// none). When `disabled` is true and a real `inert` reflow hasn't
// stripped focusability from the subtree, walk every natively-
// focusable descendant and stamp tabIndex=-1 / data-prev-tabindex.
// Restored to the previous value when disabled flips back to false.
// F7.
//
// Pairs with the existing `inert` boolean attribute on the same
// element — modern Safari + Chrome + Firefox honour inert directly,
// old Safari falls through to this fallback.
function useInertFallback(
  ref: React.RefObject<HTMLElement | null>,
  disabled: boolean,
): void {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    // Selector mirrors the WHATWG focusable-elements list — same
    // shape every a11y library (focus-trap, react-aria) uses.
    const focusables = root.querySelectorAll<HTMLElement>(
      [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable="true"]',
      ].join(','),
    )
    if (!disabled) {
      // Restore phase — anything we stamped with a saved value
      // resets to that value; anything we marked "no prior" loses
      // its tabIndex attribute entirely so the natural keyboard
      // order resumes.
      focusables.forEach((el) => {
        const prior = el.getAttribute('data-cavecms-prev-tabindex')
        if (prior !== null) {
          if (prior === 'NONE') el.removeAttribute('tabindex')
          else el.setAttribute('tabindex', prior)
          el.removeAttribute('data-cavecms-prev-tabindex')
        }
      })
      return
    }
    focusables.forEach((el) => {
      // Already-stamped descendants stay as-is on re-runs (parent
      // re-render with disabled=true). The stamp is idempotent.
      if (el.hasAttribute('data-cavecms-prev-tabindex')) return
      const prior = el.getAttribute('tabindex')
      el.setAttribute('data-cavecms-prev-tabindex', prior ?? 'NONE')
      el.setAttribute('tabindex', '-1')
    })
  }, [ref, disabled])
}

export function OutlinePanel({
  pageId,
  initial,
}: {
  pageId: number
  initial: BlockSummary[]
}) {
  const recordCommand = useRecordCommand()
  const router = useRouter()
  // F11 — outline-level reorders need to propagate the bumped
  // pageVersion into the global optimistic context so siblings on the
  // canvas inherit the new cursor.
  const dispatch = useInlineEditDispatch()
  // SSR-stable id for the inner DndContext. React's useId produces
  // tokens that match across server render + client hydration, so
  // @dnd-kit's `aria-describedby="<id>-N"` attributes line up on
  // both sides and React 19 stops marking the OutlinePanel subtree
  // as un-patchable. Audit finding E2 (Chunk K).
  const dndContextId = useId()
  // PointerSensor activation requires a 5px move before drag starts.
  // Without this constraint, a plain click on the grip handle fires
  // pointerdown → dnd-kit immediately enters drag mode → the trigger
  // never gets a click event. With distance:5 a no-move pointer
  // interaction is a click (handled by TreeRow.onScrollTo), and any
  // real drag still activates after 5px of movement.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )
  const [items, setItems] = useState(initial)

  // Dismissable: the operator can close the outline panel entirely
  // (X button in the header). Persisted to localStorage
  // `cavecms:outline-dismissed` so the choice survives reload. To bring
  // the outline back, click the "Outline" pill in the admin bar
  // (only shown in edit mode — see AdminBarInteractive).
  //
  // The admin-bar toggle writes the same localStorage key + dispatches
  // a `cavecms:outline-visibility` custom event. localStorage's native
  // `storage` event only fires CROSS-tab, so the custom event handles
  // same-tab coordination (admin-bar click → outline re-mounts).
  //
  // SSR-safe default: visible (false). On client mount the saved
  // value is read; flipping mid-session via the admin-bar toggle
  // re-renders the panel.
  const [dismissed, setDismissed] = useState(false)
  // `hasMounted` powers the entrance animation. SSR renders the panel
  // off-screen + opacity 0 (matching the dismissed-state styling); the
  // useEffect below flips it true after first paint, which kicks off
  // the CSS transition into the visible state. This gives every
  // session-open a slide-in-from-right entrance without coupling to
  // routing or to dismiss flips.
  const [hasMounted, setHasMounted] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    setDismissed(safeStorage.get('cavecms:outline-dismissed') === 'true')
    setHasMounted(true)
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ dismissed?: boolean }>).detail
      if (detail && typeof detail.dismissed === 'boolean') {
        setDismissed(detail.dismissed)
      } else {
        setDismissed(safeStorage.get('cavecms:outline-dismissed') === 'true')
      }
    }
    window.addEventListener('cavecms:outline-visibility', onChange)
    return () => window.removeEventListener('cavecms:outline-visibility', onChange)
  }, [])

  // Open/collapsed preference is persisted PER VIEWPORT CLASS across
  // sessions so the operator's last choice survives reload + page
  // navigation. A tablet visit's collapse no longer leaks into the
  // next desktop visit (F5). localStorage keys:
  //   - cavecms:outline-open:mobile
  //   - cavecms:outline-open:tablet
  //   - cavecms:outline-open:desktop
  // SSR returns the "blocks-present default" so the markup matches
  // the un-customised render; the post-mount effect re-reads the
  // matching key for the current viewport class.
  const viewportClass = useViewportClass()
  const [open, setOpen] = useState(initial.length > 0)
  // Skip the FIRST persist run per viewport-class so the read effect
  // can apply its saved/MQ-default value without being overwritten by
  // the SSR-default `open` that React commits before the read effect
  // schedules its setOpen. Re-armed on viewport changes so a tablet→
  // desktop transition correctly re-reads the desktop key without
  // letting the prior tablet-class persist clobber it.
  const skipFirstPersistRef = useRef(true)
  // Track the viewport class the last persisted-read used; when the
  // operator transitions classes (rotate iPad, dock to monitor) we
  // re-read the matching key rather than persisting the cross-class
  // value. Without this, a rotate would overwrite the desktop key
  // with the just-loaded tablet value.
  const lastReadVcRef = useRef<ViewportClass | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    // First time we see this viewport class — read the saved value
    // and apply it. We DO arm the skip-first-persist gate so the
    // upcoming setOpen doesn't immediately get persisted (which
    // would no-op on first-time-no-save, but would also defeat the
    // MQ-default fallback for first-time-tablet-no-save).
    if (lastReadVcRef.current !== viewportClass) {
      lastReadVcRef.current = viewportClass
      skipFirstPersistRef.current = true
      const saved = safeStorage.get(outlineOpenStorageKey(viewportClass))
      if (saved === 'true') setOpen(true)
      else if (saved === 'false') setOpen(false)
      else if (viewportClass !== 'desktop') {
        // Tablet/mobile default: collapsed. The panel is a fixed-
        // position overlay; an open panel on iPad obscures ~40% of
        // the canvas. The saved preference still wins when present.
        setOpen(false)
      }
    }
  }, [viewportClass])
  // Persist on every `open` toggle, scoped to the active viewport
  // class. Skip the first run per the rationale above.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (skipFirstPersistRef.current) {
      skipFirstPersistRef.current = false
      return
    }
    safeStorage.set(outlineOpenStorageKey(viewportClass), String(open))
  }, [open, viewportClass])
  const [err, setErr] = useState<string | null>(null)
  // `busy` is state (not ref) so every TreeRow's useSortable can
  // `disabled: busy` and the operator visually sees handles greyed
  // out while a prior reorder is in flight — prior ref-only guard
  // silently swallowed a second drag with no feedback.
  const [busy, setBusy] = useState(false)
  const inFlightRef = useRef(false)
  // Tracks the last `initial` arrival that landed during an
  // in-flight reorder. Applied in the postReorder finally so we
  // catch up even if `initial` doesn't change again post-flight.
  const pendingInitialRef = useRef<BlockSummary[] | null>(null)

  // Sync incoming `initial` after a router.refresh() — without this,
  // a successful add-block call leaves the outline showing the stale
  // pre-add row set until the next remount. Skip the sync when a
  // reorder is in flight so a concurrent refresh (e.g. operator
  // adds a block from elsewhere mid-drag) doesn't clobber the
  // optimistic state before our POST settles.
  //
  // Equivalence guard: the parent passes `p.blocks.map(...)` which
  // produces a NEW array reference on every parent render. Without
  // the content comparison below, a parent re-render (any state
  // change in InlineEditProvider / EditDrawer / etc.) would reset
  // `items` to the parent's last-server snapshot — wiping the
  // optimistic post-reorder version bumps and locking the next drag
  // into a 409. Skip the setItems call when initial is structurally
  // equivalent (same ids + versions + parentIds + order) to what we
  // already hold.
  useEffect(() => {
    if (inFlightRef.current) {
      pendingInitialRef.current = initial
      return
    }
    setItems((curr) => {
      if (curr === initial) return curr
      if (curr.length === initial.length) {
        let equivalent = true
        for (let i = 0; i < curr.length; i++) {
          const a = curr[i]
          const b = initial[i]
          if (!a || !b) {
            equivalent = false
            break
          }
          if (
            a.id !== b.id ||
            a.version !== b.version ||
            a.parentId !== b.parentId ||
            a.blockKey !== b.blockKey
          ) {
            equivalent = false
            break
          }
        }
        if (equivalent) return curr
      }
      return initial
    })
    pendingInitialRef.current = null
  }, [initial])

  // ── Collapse state (lifted to the panel so flattenTree can hide a
  // collapsed container's subtree from the single flat list). ──
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())
  const toggleCollapse = useCallback((id: number) => {
    setCollapsed((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])

  // ── Drag state for the flat tree DnD (nest + reparent). ──
  const [activeId, setActiveId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)
  const [offsetLeft, setOffsetLeft] = useState(0)

  const itemsById = useMemo(() => {
    const m = new Map<number, OutlineItem>()
    for (const b of items) m.set(b.id, b)
    return m
  }, [items])

  // While dragging, hide the dragged container's own subtree so the operator
  // isn't dragging an expanded subtree around (canonical dnd-kit tree behaviour).
  const effectiveCollapsed = useMemo(() => {
    if (activeId == null) return collapsed
    const n = new Set(collapsed)
    n.add(activeId)
    return n
  }, [collapsed, activeId])
  const flat = useMemo(
    () => flattenTree(items, effectiveCollapsed),
    [items, effectiveCollapsed],
  )
  const flatIds = useMemo(() => flat.map((n) => n.item.id), [flat])
  // 1-based position among same-parent siblings, for the row's index badge.
  const siblingIndexById = useMemo(() => {
    const counts = new Map<number | null, number>()
    const m = new Map<number, number>()
    for (const n of flat) {
      const c = (counts.get(n.item.parentId) ?? 0) + 1
      counts.set(n.item.parentId, c)
      m.set(n.item.id, c)
    }
    return m
  }, [flat])

  // Live drop projection — grammar-constrained {parentId, index, depth, valid}.
  const projection: Projection | null = useMemo(() => {
    if (activeId == null || overId == null) return null
    return getProjection(flat, activeId, overId, offsetLeft, INDENT_WIDTH)
  }, [activeId, overId, offsetLeft, flat])

  const activeNode = useMemo(
    () => (activeId == null ? null : (itemsById.get(activeId) ?? null)),
    [activeId, itemsById],
  )

  const postReorder = useCallback<OutlineApi['postReorder']>(
    async (parentId, siblingsInNewOrder) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    const prev = items
    // Apply optimistically — swap the affected sibling ids in the
    // global list, preserving the order of every other block.
    const siblingIds = new Set(siblingsInNewOrder.map((s) => s.id))
    const newSiblingOrder = siblingsInNewOrder.map((s) => s.id)
    let cursor = 0
    const next = items.map((b) => {
      if (siblingIds.has(b.id)) {
        const replacementId = newSiblingOrder[cursor++]
        const replacement = items.find((x) => x.id === replacementId)
        return replacement ?? b
      }
      return b
    })
    setItems(next)
    setErr(null)
    try {
      const res = await csrfFetch('/api/cms/blocks/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId,
          // Mode 2 — explicit parentId so the server's homogeneity
          // check is trivially satisfied. We submit ONLY the siblings
          // that share this parent; the API drift-check now matches
          // because the parent's living-children set equals the
          // submitted set.
          parentId,
          blocks: siblingsInNewOrder.map((b) => ({
            id: b.id,
            version: b.version,
          })),
        }),
      })
      if (res.status === 409) {
        setItems(prev)
        setErr(
          'Someone else changed this page while you were here. Refresh and try again.',
        )
        return
      }
      if (!res.ok) {
        setItems(prev)
        // Generic copy — same-parent reorders are grammar-trivial, so any
        // non-409 rejection here is unexpected (the projection already blocked
        // invalid drops client-side). Never surface the raw server enum
        // (column_parent_must_be_section etc.) — that's debugger language.
        setErr("We couldn't save the new order. Refresh the page and try again.")
        return
      }
      // F11 — reorder now returns pageVersion alongside the per-row
      // versions. Propagate it through context so any in-flight PATCH
      // against a stale pageVersion 409s instead of silently
      // committing against shifted siblings.
      const j = (await res.json()) as {
        blocks: Array<{ id: number; version: number }>
        pageVersion?: number
      }
      const byId = new Map(j.blocks.map((x) => [x.id, x.version]))
      setItems((curr) =>
        curr.map((b) => ({ ...b, version: byId.get(b.id) ?? b.version })),
      )
      if (typeof j.pageVersion === 'number') {
        const nextPv = j.pageVersion
        for (const [id, version] of byId.entries()) {
          dispatch({
            type: 'set-versions',
            blockId: id,
            blockVersion: version,
            pageVersion: nextPv,
          })
        }
      }
      // ── Chunk J — record REORDER on the undo stack ──
      // Inverse: POST /reorder with the PRIOR sibling order + the
      // FRESH versions returned by this forward (the next round trip
      // needs to satisfy the optimistic-lock against the just-bumped
      // versions). The captured priorSiblingsInOrder is the operator's
      // pre-drag arrangement, derived from `prev` filtered to this
      // parent. The forward body is the new order with the OLD
      // versions; deriveRebind in UndoRedoController updates the
      // forward's expectedVersion list after the inverse runs.
      const priorSiblingsInOrder = prev
        .filter((b) => b.parentId === parentId)
        .map((b) => b.id)
      // Filter rows whose fresh version we don't have (concurrent
      // delete between optimistic update + response would leave the
      // id absent from j.blocks). The earlier `?? 0` fallback would
      // 409 server-side; omitting the row lets the inverse reorder
      // surviving siblings cleanly. Agent review LOW finding.
      const inverseBlocks = priorSiblingsInOrder
        .filter((id) => byId.has(id))
        .map((id) => ({
          id,
          version: byId.get(id)!,
        }))
      const forwardBody = {
        pageId,
        parentId,
        blocks: siblingsInNewOrder.map((b) => ({
          id: b.id,
          version: b.version,
        })),
      }
      const inverseBody = {
        pageId,
        parentId,
        blocks: inverseBlocks,
      }
      recordCommand({
        kind: 'reorder',
        label: 'Reordered blocks',
        timestamp: Date.now(),
        forward: {
          method: 'POST',
          path: '/api/cms/blocks/reorder',
          body: forwardBody,
          expects: 200,
        },
        inverse: {
          method: 'POST',
          path: '/api/cms/blocks/reorder',
          body: inverseBody,
          expects: 200,
        },
        captures: { parentId, blockCount: priorSiblingsInOrder.length },
      })
      // EXACT MIRROR: re-fetch so the canvas, the inline-edit context, AND this
      // outline all re-render from the committed server state. The optimistic
      // setItems above is just instant feedback; without this refresh the move
      // never propagates to the page, and the `initial` sync effect can revert
      // the outline from stale data — desyncing the outline from the page (the
      // "element goes missing / outline isn't a mirror" bug). Also clears any
      // mid-flight snapshot so `finally` can't re-apply a stale one.
      pendingInitialRef.current = null
      router.refresh()
    } catch (e) {
      setItems(prev)
      setErr(
        e instanceof Error && e.name === 'AbortError'
          ? 'That took too long. Try again.'
          : "We can't reach the server right now. Try again in a moment.",
      )
    } finally {
      inFlightRef.current = false
      setBusy(false)
      // Catch up on any `initial` change that arrived during the
      // in-flight POST — the useEffect skipped it then; we apply it
      // now that the optimistic state is no longer load-bearing.
      if (pendingInitialRef.current) {
        setItems(pendingInitialRef.current)
        pendingInitialRef.current = null
      }
    }
    },
    [items, pageId, dispatch, recordCommand, router],
  )

  // ── Cross-parent move (reparent / nest) — reorder API Mode 3. ──
  // Submits BOTH affected parents' children: the source parent's remaining
  // children (so its drift-completeness check passes) AND the target parent's
  // children in the new order, with the moved block carrying newParentId. The
  // server assigns position by submission order within each resolved bucket.
  const postReparent = useCallback(
    async (
      blockId: number,
      sourceParentId: number | null,
      targetParentId: number | null,
      targetIndex: number,
    ) => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      setBusy(true)
      setErr(null)
      const prev = items
      const moving = prev.find((b) => b.id === blockId)
      if (!moving) {
        inFlightRef.current = false
        setBusy(false)
        return
      }
      const sourceSiblings = prev.filter((b) => b.parentId === sourceParentId)
      const originalIndex = sourceSiblings.findIndex((b) => b.id === blockId)

      const next = applyMove(prev, blockId, targetParentId, targetIndex)
      setItems(next)

      // `next` already reparented the block, so `sourceRemaining` correctly
      // EXCLUDES it and `targetNewOrder` INCLUDES it (carrying newParentId).
      // INVARIANT: the moved block must appear ONCE (in targetNewOrder, not
      // sourceRemaining). The server's drift check buckets `submittedHere` by
      // each row's CURRENT db parent_id — the moved block still reads as a child
      // of the source there, so it counts toward the source parent's
      // completeness automatically. Adding it to sourceRemaining too would
      // submit it twice → duplicate_block_id / drift 409. Do not "fix" that.
      const sourceRemaining = next.filter((b) => b.parentId === sourceParentId)
      const targetNewOrder = next.filter((b) => b.parentId === targetParentId)
      const payloadBlocks = [
        ...sourceRemaining.map((b) => ({ id: b.id, version: b.version })),
        ...targetNewOrder.map((b) => ({
          id: b.id,
          version: b.version,
          ...(b.id === blockId ? { newParentId: targetParentId } : {}),
        })),
      ]
      try {
        const res = await csrfFetch('/api/cms/blocks/reorder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId, blocks: payloadBlocks }),
        })
        if (res.status === 409) {
          setItems(prev)
          setErr(
            'Someone else changed this page while you were here. Refresh and try again.',
          )
          return
        }
        if (!res.ok) {
          setItems(prev)
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          setErr(reparentErrorCopy(j.error))
          return
        }
        const j = (await res.json()) as {
          blocks: Array<{ id: number; version: number }>
          pageVersion?: number
        }
        const byId = new Map(j.blocks.map((x) => [x.id, x.version]))
        setItems((curr) =>
          curr.map((b) => ({ ...b, version: byId.get(b.id) ?? b.version })),
        )
        if (typeof j.pageVersion === 'number') {
          const pv = j.pageVersion
          for (const [id, version] of byId.entries()) {
            dispatch({
              type: 'set-versions',
              blockId: id,
              blockVersion: version,
              pageVersion: pv,
            })
          }
        }
        // Undo: move the block back to its source parent + original index, with
        // the FRESH post-move versions so the inverse satisfies the lock. The
        // forward (redo) is exactly the move we just sent (pre-move versions);
        // UndoRedoController's deriveRebind refreshes its versions post-inverse.
        const freshVersion = (id: number) =>
          byId.get(id) ?? prev.find((b) => b.id === id)?.version ?? 0
        const restored = applyMove(
          next,
          blockId,
          sourceParentId,
          originalIndex >= 0 ? originalIndex : sourceRemaining.length,
        )
        const inverseBlocks = [
          ...restored
            .filter((b) => b.parentId === targetParentId)
            .map((b) => ({ id: b.id, version: freshVersion(b.id) })),
          ...restored
            .filter((b) => b.parentId === sourceParentId)
            .map((b) => ({
              id: b.id,
              version: freshVersion(b.id),
              ...(b.id === blockId ? { newParentId: sourceParentId } : {}),
            })),
        ]
        recordCommand({
          kind: 'reorder',
          label: 'Moved block',
          timestamp: Date.now(),
          forward: {
            method: 'POST',
            path: '/api/cms/blocks/reorder',
            body: { pageId, blocks: payloadBlocks },
            expects: 200,
          },
          inverse: {
            method: 'POST',
            path: '/api/cms/blocks/reorder',
            body: { pageId, blocks: inverseBlocks },
            expects: 200,
          },
          captures: { parentId: sourceParentId, blockCount: payloadBlocks.length },
        })
        // EXACT MIRROR (see postReorder): re-fetch so the canvas + context +
        // outline all re-render from the committed server state. A reparent is
        // the most visible move — without this the page wouldn't reflect it.
        pendingInitialRef.current = null
        router.refresh()
      } catch (e) {
        setItems(prev)
        setErr(
          e instanceof Error && e.name === 'AbortError'
            ? 'That took too long. Try again.'
            : "We can't reach the server right now. Try again in a moment.",
        )
      } finally {
        inFlightRef.current = false
        setBusy(false)
        if (pendingInitialRef.current) {
          setItems(pendingInitialRef.current)
          pendingInitialRef.current = null
        }
      }
    },
    [items, pageId, dispatch, recordCommand, router],
  )

  // Decide same-parent reorder (Mode 2) vs cross-parent move (Mode 3) from the
  // grammar-constrained projection. Defense-in-depth grammar + cycle guards.
  const commitMove = useCallback(
    async (blockId: number, proj: Projection) => {
      const moving = items.find((b) => b.id === blockId)
      if (!moving) return
      const sourceParentId = moving.parentId
      const targetParentId = proj.parentId
      const targetKind =
        targetParentId == null
          ? null
          : (itemsById.get(targetParentId)?.kind ?? null)
      if (!canBeChildOf(moving.kind, targetKind)) {
        setErr("That block can't go there.")
        return
      }
      if (
        targetParentId != null &&
        descendantIds(items, blockId).has(targetParentId)
      ) {
        setErr("You can't move a block into one of its own children.")
        return
      }
      if (sourceParentId === targetParentId) {
        const sibs = items.filter((b) => b.parentId === sourceParentId)
        const from = sibs.findIndex((s) => s.id === blockId)
        if (from < 0) return
        const to = Math.max(0, Math.min(proj.index, sibs.length - 1))
        if (from === to) return
        await postReorder(sourceParentId, arrayMove(sibs, from, to))
        return
      }
      await postReparent(blockId, sourceParentId, targetParentId, proj.index)
    },
    [items, itemsById, postReorder, postReparent],
  )

  // ── dnd-kit drag lifecycle ──
  const onDragStart = useCallback((e: DragStartEvent) => {
    const id = Number(e.active.id)
    if (!Number.isInteger(id)) return
    setActiveId(id)
    setOverId(id)
    setOffsetLeft(0)
    setErr(null)
  }, [])
  const onDragMove = useCallback((e: DragMoveEvent) => {
    setOffsetLeft(e.delta.x)
  }, [])
  const onDragOver = useCallback((e: DragOverEvent) => {
    const id = e.over ? Number(e.over.id) : null
    setOverId(id != null && Number.isInteger(id) ? id : null)
  }, [])
  const resetDrag = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    setOffsetLeft(0)
  }, [])
  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      const aId = activeId
      const dx = e.delta.x
      // Recompute the projection from the final event against the drag-time
      // flat list (active still set → its subtree hidden) so a late state
      // flush can't make the commit use a stale projection.
      const flatNow = flat
      resetDrag()
      // Released over no droppable → cancel. Don't fall back to the last-hovered
      // `overId` and commit a move the operator dragged away from / abandoned.
      if (!e.over) return
      const oId = Number(e.over.id)
      if (aId == null || !Number.isInteger(oId)) return
      // Dropped on its own row with no horizontal intent → a click/no-move, not
      // a move. Without this, a tiny leftward nudge (dx < 0) on a widget would
      // project to loose-root (≠ its source column) and fire a spurious
      // cross-parent POST for a non-move.
      if (oId === aId && Math.abs(dx) < INDENT_WIDTH) return
      const proj = getProjection(flatNow, aId, oId, dx, INDENT_WIDTH)
      if (!proj.valid) {
        setErr("That block can't go there.")
        return
      }
      await commitMove(aId, proj)
    },
    [activeId, flat, resetDrag, commitMove],
  )
  const onDragCancel = useCallback(() => resetDrag(), [resetDrag])

  // Visibility composite — the panel renders OFF-SCREEN (slide-right
  // + opacity 0) until both conditions are met. The transition kicks
  // in automatically when either flips. We KEEP the panel mounted in
  // the dismissed state so the slide-OUT animation has a frame to
  // play; pointer-events-none + inert make it inert for AT + mouse.
  const visible = hasMounted && !dismissed

  // F7 — `inert` fallback for older Safari (<17 partial / <14 none).
  // The native `inert` attribute on <aside> + #outline-panel-body
  // handles modern browsers; the fallback walks focusable descendants
  // and stamps tabIndex=-1 so the subtree is keyboard-unreachable in
  // every browser. aria-hidden + pointer-events: none are already in
  // place from the existing className composition.
  const asideRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useInertFallback(asideRef, !visible)
  useInertFallback(bodyRef, !open)

  const dismiss = () => {
    if (typeof window === 'undefined') return
    safeStorage.set('cavecms:outline-dismissed', 'true')
    window.dispatchEvent(
      new CustomEvent('cavecms:outline-visibility', {
        detail: { dismissed: true },
      }),
    )
    setDismissed(true)
  }

  return (
    <aside
      ref={asideRef}
      aria-label="Page outline"
      aria-hidden={!visible}
      // React 19 supports `inert` as a boolean prop. inert blocks
      // focus + keyboard + mouse on the entire subtree, so the
      // dismissed panel doesn't trap tab order or accept clicks
      // through its 0-opacity surface.
      inert={!visible}
      className={clsx(
        // Width: narrower on <lg (288px) so the panel doesn't claim
        // half the canvas on iPad; full 320px on lg+ where there's
        // room. max-w guard keeps it from overflowing very narrow
        // viewports.
        'fixed right-4 top-28 z-30 w-72 lg:w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/95 text-near-black shadow-[0_24px_60px_-30px_rgba(5,5,5,0.4)] backdrop-blur-sm',
        // Slide-in-from-right + fade entrance; mirror exit on
        // dismiss. duration-drawer (400ms) on the luxury ease curve
        // gives a smooth purposeful settle. max-h transitions in
        // parallel so collapse/expand land on the same beat.
        'transition-all duration-drawer ease-luxury motion-reduce:transition-none',
        open ? 'max-h-[calc(100vh-9rem)]' : 'max-h-14',
        visible
          ? 'translate-x-0 opacity-100'
          : 'translate-x-[calc(100%+1.5rem)] opacity-0 pointer-events-none',
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="outline-panel-body"
          className="flex flex-1 items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-warm-stone/5"
        >
          <span className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-copper-500/15 text-copper-500 ring-1 ring-copper-400/30"
            >
              <Layers size={13} strokeWidth={2} />
            </span>
            <span className="flex flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-copper-700">
                Outline
              </span>
              <span className="text-[11px] font-medium text-warm-stone">
                {items.length === 0
                  ? 'No sections yet'
                  : `${items.length} block${items.length === 1 ? '' : 's'}`}
              </span>
            </span>
          </span>
          <ChevronRight
            size={14}
            strokeWidth={2.2}
            className={clsx(
              'text-warm-stone transition-transform motion-reduce:transition-none',
              open ? 'rotate-90' : 'rotate-0',
            )}
          />
        </button>
        {/* Dismiss — closes the panel entirely. Operator brings it back
           via the admin-bar Outline pill. Stops propagation so a click
           on the X never toggles the collapse header. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            dismiss()
          }}
          aria-label="Close outline"
          title="Close outline (open via the admin bar)"
          className="mr-2 inline-flex h-8 w-8 items-center justify-center rounded-full text-warm-stone transition-colors hover:bg-warm-stone/10 hover:text-near-black focus-visible:bg-warm-stone/10 focus-visible:text-near-black focus-visible:outline-none"
        >
          <X size={14} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>

      {/* Body kept ALWAYS rendered so the collapse/expand animation
         can fade + slide its content in tandem with the outer aside's
         max-h transition. With the prior `{open && (…)}` guard, the
         body popped in/out abruptly while the outer height animated
         smoothly — the mismatch read as broken motion. inert + aria-
         hidden block focus + AT when collapsed; opacity + translate
         carry the visual fade. duration-standard (300ms) matches the
         outer max-h beat. */}
      <div
        ref={bodyRef}
        id="outline-panel-body"
        aria-hidden={!open}
        inert={!open}
        className={clsx(
          'max-h-[calc(100vh-13rem)] overflow-y-auto border-t border-warm-stone/15 px-3 py-3 transition-all duration-standard ease-luxury motion-reduce:transition-none',
          open
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 -translate-y-1 pointer-events-none',
        )}
      >
        {err && (
          <p
            role="alert"
            className="mb-2 rounded-xl border border-red-200 bg-red-50/60 px-3 py-2 text-[11px] font-medium text-red-700"
          >
            {err}
          </p>
        )}

          {items.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-warm-stone">
              Empty page. Pick a starting block from the page body.
            </p>
          ) : (
            // ONE DndContext + ONE flat SortableContext over the whole tree.
            // onDragMove tracks the horizontal offset, onDragOver the over-row;
            // onDragEnd recomputes the grammar-constrained projection from the
            // final event and commits a reorder (Mode 2) or reparent (Mode 3).
            //
            // `id` MUST be supplied explicitly. @dnd-kit's internal
            // auto-counter generates a different ID on the server vs
            // the client (it's not RSC-aware), producing the
            // hydration mismatch on `aria-describedby="DndDescribedBy-N"`
            // — React 19 then marks the OutlinePanel subtree as
            // un-patchable, which can cascade into stale handlers on
            // the very rows the operator is dragging. Audit finding
            // E2 (Chunk K). useId returns a stable token that
            // matches across the SSR + hydration boundary.
            <DndContext
              id={dndContextId}
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
              onDragCancel={onDragCancel}
            >
              {/* ONE flat SortableContext over the whole tree. Rows displace to
                 preview the drop (verticalListSortingStrategy); the dragged row
                 renders at its PROJECTED depth so the operator sees exactly how
                 deep it will nest (Elementor/Gutenberg "drag right to nest").
                 getProjection enforces the grammar + no-cycle. */}
              <SortableContext
                items={flatIds}
                strategy={verticalListSortingStrategy}
              >
                <ol className="space-y-1">
                  {flat.map((fn) => (
                    <TreeRow
                      key={fn.item.id}
                      item={fn.item}
                      orphan={fn.orphan}
                      childCount={fn.childCount}
                      index={siblingIndexById.get(fn.item.id) ?? 1}
                      depth={
                        activeId === fn.item.id && projection
                          ? projection.depth
                          : fn.depth
                      }
                      busy={busy}
                      pageId={pageId}
                      isCollapsed={collapsed.has(fn.item.id)}
                      onToggleCollapse={toggleCollapse}
                      invalid={
                        activeId === fn.item.id && projection
                          ? !projection.valid
                          : false
                      }
                    />
                  ))}
                </ol>
              </SortableContext>
              {/* Drag preview clone following the cursor, rendered at the
                 projected depth + tinted red when the drop is blocked. */}
              <DragOverlay dropAnimation={null}>
                {activeNode ? (
                  <DragOverlayRow
                    item={activeNode}
                    depth={projection ? projection.depth : 0}
                    invalid={projection ? !projection.valid : false}
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
          {/* Widget picker extracted to a separate left-pinned floating
             panel (components/inline-edit/WidgetPicker.tsx). Operators
             dismiss the outline without losing access to widget
             creation; the picker stays mounted independently. */}
      </div>
    </aside>
  )
}

// Lightweight drag-preview clone shown in the DragOverlay (full opacity,
// follows the cursor). Mirrors the row's icon + label at the projected
// indentation; tints red when the drop is blocked.
function DragOverlayRow({
  item,
  depth,
  invalid,
}: {
  item: OutlineItem
  depth: number
  invalid: boolean
}) {
  const Icon = iconFor(item.kind)
  return (
    <div
      className={clsx(
        'pointer-events-none flex items-center gap-2 rounded-xl border bg-cream px-2.5 py-2 text-near-black shadow-[0_12px_30px_-12px_rgba(5,5,5,0.45)]',
        invalid
          ? 'border-red-400/70 ring-2 ring-red-400/60'
          : 'border-copper-400/60 ring-1 ring-copper-300/50',
      )}
      style={{ paddingLeft: `calc(0.625rem + ${depth * INDENT_WIDTH}px)` }}
    >
      <GripVertical size={13} strokeWidth={2} className="text-warm-stone/60" />
      <Icon size={13} strokeWidth={1.8} className="shrink-0 text-warm-stone" />
      <span className="truncate text-[12px] font-medium">
        {readableBlockLabel(item.blockType, item.kind)}
      </span>
    </div>
  )
}

// Memoised: during a drag, `onDragMove` updates offsetLeft on every pointermove,
// re-rendering OutlinePanel + re-running the flat.map. memo() + stable primitive
// props (item is a stable reference from `items` while dragging; only the dragged
// row's depth/invalid change) means only the ONE dragged row re-renders per frame
// instead of all N rows — O(1) drag cost, not O(N). Audit pillar-4 HIGH fix.
const TreeRow = memo(function TreeRow({
  item,
  orphan,
  index,
  depth,
  busy,
  pageId,
  childCount,
  isCollapsed,
  onToggleCollapse,
  invalid,
}: {
  item: OutlineItem
  /** parent not present in the block set — surfaced at root, drag-disabled */
  orphan: boolean
  index: number
  /** rendered indentation depth — the PROJECTED depth while this row is the
   *  one being dragged, else its natural depth. */
  depth: number
  busy: boolean
  pageId: number
  childCount: number
  isCollapsed: boolean
  onToggleCollapse: (id: number) => void
  /** true while this row is the active drag and the projected drop is invalid */
  invalid: boolean
}) {
  // `data` MUST be a stable reference between renders. dnd-kit caches
  // it on the sortable item and the outer onDragEnd reads it back via
  // `e.active.data.current`. Without memoization, every parent render
  // produces a new object literal — dnd-kit's internal item.data
  // diverges from the stale ref captured during pointerdown, and the
  // second drag's onDragEnd can read undefined parentId (manifesting
  // as "drag stops working after one cycle"). Memo gate is just the
  // primitive parentId so the ref is identity-stable across renders
  // unless the row actually moves to a different parent.
  const sortableData = useMemo(
    () => ({ parentId: item.parentId, kind: item.kind }),
    [item.parentId, item.kind],
  )
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    data: sortableData,
    // Orphans are surfaced at the top level but their parentId
    // doesn't reference a live block — a drag would 404 at the
    // server (parent_not_found). Disable the handle so the operator
    // gets visual feedback "not draggable" instead of a snap-back.
    disabled: !!item.blockKey || busy || !!orphan,
  })
  // Combine dnd-kit's node ref with our own so the page→outline sync can scroll
  // this row into view when the block is selected on the canvas.
  const liRef = useRef<HTMLLIElement | null>(null)
  const setRefs = useCallback(
    (el: HTMLLIElement | null) => {
      setNodeRef(el)
      liRef.current = el
    },
    [setNodeRef],
  )
  // Expand/collapse is lifted to the panel (so flattenTree can hide a
  // collapsed subtree from the single flat list). `expanded` derives from it.
  const expanded = !isCollapsed
  const Icon = iconFor(item.kind)
  const hasChildren = childCount > 0
  const isContainer = item.kind !== 'widget'

  // Outline-handle click jumps the canvas to the corresponding block
  // and pulses a copper ring around it for 1.5s. Selector picks the
  // right data attribute for the kind (section / column / widget all
  // carry distinct edit ids). Respects prefers-reduced-motion: skips
  // smooth scroll AND the pulse keyframe (CSS in globals handles the
  // motion-reduce branch via the class).
  //
  // `pingTimerRef` tracks the latest setTimeout handle so:
  //   - A rapid second click clears the previous pending removal
  //     before queuing a new one (no two-timer overlap).
  //   - Unmounting the TreeRow cancels any pending removal so the
  //     callback doesn't fire on a detached element after the
  //     OutlinePanel closes / hot-reloads / route-changes. R3 (K).
  const pingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (pingTimerRef.current !== null) {
        clearTimeout(pingTimerRef.current)
        pingTimerRef.current = null
      }
    }
  }, [])
  const onScrollToBlock = useCallback(() => {
    if (typeof document === 'undefined') return
    const selector =
      item.kind === 'section'
        ? `[data-edit-section-id="${item.id}"]`
        : item.kind === 'column'
          ? `[data-edit-column-id="${item.id}"]`
          : `[data-edit-block-id="${item.id}"]`
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return
    const reduce = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    el.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth',
      block: 'center',
    })
    // Cleanup any prior pulse from a quick re-click before re-adding,
    // otherwise the animation doesn't restart.
    if (pingTimerRef.current !== null) {
      clearTimeout(pingTimerRef.current)
      pingTimerRef.current = null
    }
    el.classList.remove('cavecms-outline-ping')
    // Force reflow so the next class add restarts the animation.
    void el.offsetWidth
    el.classList.add('cavecms-outline-ping')
    pingTimerRef.current = setTimeout(() => {
      el.classList.remove('cavecms-outline-ping')
      pingTimerRef.current = null
    }, 1600)
  }, [item.id, item.kind])

  // ── F2 — Selection sync ──
  // Single-click on the row "selects" the block (persistent ring) AND
  // scrolls the canvas (existing affordance). The selection state
  // lives in SelectionContext (parallel agent's slice); calling
  // select(id) drives both the outline row highlight AND any other
  // surface that subscribes to the same selection state. Persistent
  // — replaces the prior 1.6s ping-and-die.
  const selection = useSelection()
  const isRowSelected = selection.isSelected(item.id)
  // Page→outline sync: when this block becomes selected (operator clicked it /
  // its drag handle on the canvas), scroll this outline row into view. Only on
  // the false→true transition so it doesn't fight the operator's own scrolling.
  // The row already highlights via isRowSelected.
  const wasSelectedRef = useRef(false)
  useEffect(() => {
    if (isRowSelected && !wasSelectedRef.current) {
      liRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    wasSelectedRef.current = isRowSelected
  }, [isRowSelected])
  const selectAndScroll = useCallback(() => {
    selection.select(item.id)
    onScrollToBlock()
  }, [selection, item.id, onScrollToBlock])

  // ── F6 — Spacing preview indicator ──
  // The SpacingToolbar (+ EditDrawer for meta fields) dispatch
  // set-preview into InlineEditContext as the operator drags the
  // stepper. We subscribe to state.previews here and surface a small
  // copper dot on the row when this block has a pending overlay that
  // hasn't been persisted yet. Cleared automatically when the reducer
  // wipes the preview slot on save (block-saved / block-meta-saved).
  //
  // The hook reads ALL previews but the equality check is by-id so a
  // dispatch on a different block doesn't re-render this row beyond
  // React's standard batching. Cheap.
  const editState = useInlineEditState()
  const hasPendingPreview = editState.previews.has(item.id)

  // ── F3 — Operator-set label ──
  // SectionMeta / ColumnMeta / WidgetMeta carry an optional `label`
  // field (Agent A6's schema slice). When set, the outline renders
  // that label instead of the generic "Section" / "Column" / type
  // name. The double-click + blur path lets the operator rename
  // inline.
  //
  // Defensive read: the schema field may or may not be merged at
  // typecheck time. Cast through `unknown` + a property check so we
  // don't depend on the SectionMeta type carrying `label`. The PATCH
  // body sends `meta: { ...existing, label }` which goes through the
  // server's SectionMetaSchema / ColumnMetaSchema parser — if the
  // schema doesn't include label yet, the parser strips it (zod
  // `.strict()` would 400; the schemas use `.passthrough()` by audit
  // so unknown fields ride through harmlessly until the schema
  // catches up).
  const liveMeta = useMemo(() => {
    const live = editState.blocks.find((b) => b.id === item.id)
    if (!live) return null
    return (live.meta as { label?: unknown } | null) ?? null
  }, [editState.blocks, item.id])
  const liveMetaForPatch = useMemo<Record<string, unknown>>(() => {
    if (liveMeta && typeof liveMeta === 'object') {
      return { ...(liveMeta as Record<string, unknown>) }
    }
    return {}
  }, [liveMeta])
  const customLabel =
    liveMeta && typeof liveMeta.label === 'string' && liveMeta.label.trim() !== ''
      ? (liveMeta.label as string)
      : null

  const router = useRouter()
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const dispatch = useInlineEditDispatch()
  const [actionBusy, setActionBusy] = useState(false)
  // Inline label-edit state. `editingLabel === true` swaps the
  // text label for an <input>; blur or Enter commits, Escape
  // cancels.
  const [editingLabel, setEditingLabel] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const labelInputRef = useRef<HTMLInputElement | null>(null)

  // Helper — POST to /api/cms/blocks/[id]/duplicate. Same endpoint
  // as the canvas toolbar's Duplicate verb so behaviour matches
  // exactly (preserves meta, enforces column-count cap, audits as
  // kind='duplicate'). Toast + refresh on success.
  const duplicate = useCallback(async () => {
    if (actionBusy) return
    setActionBusy(true)
    try {
      const res = await csrfFetch(
        `/api/cms/blocks/${item.id}/duplicate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId }),
        },
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? 'Duplicate failed.')
        if (res.status === 404) router.refresh()
        return
      }
      toast.success('Duplicated.')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Network error.')
    } finally {
      setActionBusy(false)
    }
  }, [actionBusy, item.id, pageId, router, toast])

  // Helper — DELETE /api/cms/blocks/[id]. Records an undo command
  // matching the canvas toolbar's delete path so ⌘Z resurrects via
  // POST /restore (with cascade:true for containers). Surfaces an
  // inline Undo button on the success toast.
  //
  // F1 / F2 — capture the deleted row's full restore context BEFORE
  // the DELETE fires so the undo stack can resurrect via the primary
  // /restore route AND has the fallback metadata (priorData, priorMeta,
  // blockType, pageId, parentId, position) needed by
  // UndoStackProvider's cron-purge re-create path. Reads come from
  // the live optimistic state (useInlineEditState) so a sibling save
  // that bumped the row's data/meta is reflected. Also applies the
  // DELETE response's per-row versions via `set-versions` so a
  // concurrent edit on a surviving sibling block doesn't 409 against
  // the now-bumped pageVersion. Mirrors EditableBlock.deleteBlock's
  // shape exactly so the outline + canvas surfaces never drift.
  const deleteBlock = useCallback(async () => {
    if (actionBusy) return
    const blockId = item.id
    const isContainer = item.kind !== 'widget'
    // Snapshot live row + sibling slice for the restore context.
    // Reading at click time (before the network round-trip) preserves
    // the operator's mental "this was here" position even if a
    // concurrent change reshuffles siblings post-delete.
    const liveRow = editState.blocks.find((b) => b.id === blockId) ?? null
    const liveSiblings = editState.blocks
      .filter((b) => b.parentId === item.parentId)
      .slice()
      .sort((a, b) => a.position - b.position)
    const position = liveSiblings.findIndex((s) => s.id === blockId)
    const priorData = liveRow?.data ?? null
    const priorMeta = liveRow?.meta ?? null
    setActionBusy(true)
    try {
      const res = await csrfFetch(`/api/cms/blocks/${blockId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? 'Delete failed.')
        return
      }
      // F2 — apply per-row versions from the DELETE response so
      // subsequent edits don't 409 against the bumped pageVersion.
      // Tolerates the legacy 204 (empty body) gracefully.
      const body = (await res.json().catch(() => ({}))) as {
        pageVersion?: number
        blocks?: Array<{ id: number; version: number; deletedAt?: string }>
      }
      if (Array.isArray(body.blocks)) {
        const pv =
          typeof body.pageVersion === 'number'
            ? body.pageVersion
            : editState.pageVersion
        for (const row of body.blocks) {
          if (typeof row.id === 'number' && typeof row.version === 'number') {
            dispatch({
              type: 'set-versions',
              blockId: row.id,
              blockVersion: row.version,
              pageVersion: pv,
            })
          }
        }
      }
      // F1 — full capture shape mirrors EditableBlock.deleteBlock so
      // the cron-purge fallback path in UndoStackProvider can re-create
      // the deleted row from captured data when /restore 404s.
      recordCommand({
        kind: isContainer ? 'delete-container' : 'delete-widget',
        label: isContainer
          ? item.kind === 'section'
            ? 'Removed section'
            : 'Removed column'
          : 'Removed block',
        timestamp: Date.now(),
        forward: {
          method: 'DELETE',
          path: `/api/cms/blocks/${blockId}`,
          expects: 200,
        },
        inverse: {
          method: 'POST',
          path: `/api/cms/blocks/${blockId}/restore`,
          body: {
            ...(isContainer ? { cascade: true } : {}),
            position: position >= 0 ? position : liveSiblings.length,
            parentId: item.parentId,
          },
          expects: 200,
        },
        captures: {
          blockId,
          containerKind: item.kind,
          parentId: item.parentId,
          position: position >= 0 ? position : liveSiblings.length,
          priorData,
          priorMeta,
          blockType: item.blockType,
          pageId,
        },
      })
      // Cascade warning for containers — the toast copy makes the
      // scope visible so the operator can hit Undo before the next
      // command pushes this one out of the stack.
      const successCopy = isContainer
        ? item.kind === 'section'
          ? 'Section removed (with all its columns).'
          : 'Column removed (with all its widgets).'
        : 'Removed.'
      toast.success(successCopy, {
        label: 'Undo',
        // Same runUndo path as ⌘Z so the inverse goes through the
        // global undo cursor — matching the canvas toolbar's delete
        // flow exactly.
        onClick: () => void runUndo(),
      })
      // Clear selection if we just deleted the selected row.
      if (selection.isSelected(blockId)) selection.select(null)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Network error.')
    } finally {
      setActionBusy(false)
    }
  }, [
    actionBusy,
    dispatch,
    editState.blocks,
    editState.pageVersion,
    item.blockType,
    item.id,
    item.kind,
    item.parentId,
    pageId,
    recordCommand,
    router,
    runUndo,
    selection,
    toast,
  ])

  // Helper — add a child / sibling. Routed via POST /api/cms/blocks.
  // The body shape mirrors EditableSection.addColumn / EditableBlock's
  // insert paths so semantics match exactly.
  const addChildBlock = useCallback(
    async (
      params:
        | { kind: 'column'; parentId: number }
        | {
            kind: 'section'
            afterBlockId: number
          }
        | {
            kind: 'widget'
            parentId: number
            blockType: string
          },
    ) => {
      if (actionBusy) return
      setActionBusy(true)
      try {
        const body: Record<string, unknown> = { pageId }
        if (params.kind === 'column') {
          body.kind = 'column'
          body.parentId = params.parentId
          body.meta = {}
        } else if (params.kind === 'section') {
          body.kind = 'section'
          body.afterBlockId = params.afterBlockId
          body.meta = {}
        } else {
          body.blockType = params.blockType
          body.parentId = params.parentId
        }
        const res = await csrfFetch('/api/cms/blocks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          if (j.error === 'column_count_exceeded') {
            toast.error(
              `This section is at the ${MAX_SECTION_COLUMNS}-column maximum.`,
            )
          } else {
            toast.error(j.error ?? "We couldn't add the block.")
          }
          return
        }
        toast.success(
          params.kind === 'column'
            ? 'Column added.'
            : params.kind === 'section'
              ? 'Section added.'
              : 'Block added.',
        )
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Network error.')
      } finally {
        setActionBusy(false)
      }
    },
    [actionBusy, pageId, router, toast],
  )

  // Helper — PATCH a section/column meta to set the operator label.
  // F3. We send the freshest version + meta from useInlineEditState
  // (NOT the BlockSummary cached in the outline's initial prop) so
  // a sibling save that bumped the version doesn't 409 us. The
  // server re-validates meta through SectionMetaSchema /
  // ColumnMetaSchema; an unknown `label` field rides through
  // .passthrough() until the schema lands the field explicitly.
  const commitLabel = useCallback(
    async (newLabel: string) => {
      const trimmed = newLabel.trim()
      const previous = customLabel ?? ''
      // No-op when nothing changed (operator double-clicked, blurred
      // without typing). Avoids a stale-version 409 that would
      // surface a confusing error toast for a no-op gesture.
      if (trimmed === previous) {
        setEditingLabel(false)
        return
      }
      setActionBusy(true)
      try {
        const nextMeta: Record<string, unknown> = { ...liveMetaForPatch }
        if (trimmed === '') {
          // Clearing the label — drop the field so the renderer's
          // fallback ("Section · {blockKey}" / "Section #{id}") takes
          // over.
          delete nextMeta.label
        } else {
          nextMeta.label = trimmed
        }
        const res = await csrfFetch(`/api/cms/blocks/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pageId,
            blockVersion: item.version,
            pageVersion: editState.pageVersion,
            meta: nextMeta,
          }),
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          toast.error(j.error ?? "We couldn't save the label.")
          return
        }
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Network error.')
      } finally {
        setActionBusy(false)
        setEditingLabel(false)
      }
    },
    [
      customLabel,
      editState.pageVersion,
      liveMetaForPatch,
      item.id,
      item.version,
      pageId,
      router,
      toast,
    ],
  )

  // System-block gate — fixed-slot blocks (block_key non-null) refuse
  // delete + duplicate at the server, and we shouldn't show those
  // verbs in the row cluster either. Mirrors the EditableBlock
  // toolbar's gate.
  const isFixed = !!item.blockKey
  // Delete enablement: allowed when (a) the row is not fixed-slot,
  // OR (b) the row is an orphan. F4 — the orphan IS the problem the
  // operator needs to clear, so the per-row Delete must work even
  // though the row carries no live parent.
  const canDelete = !isFixed || !!orphan
  // Duplicate enablement: same fixed-slot gate, but orphans CAN'T
  // duplicate (the API would 404 on the orphan's missing parent
  // chain). Operator's only option for an orphan is delete.
  const canDuplicate = !isFixed && !orphan

  return (
    <li
      ref={setRefs}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={clsx(
        'group rounded-xl border transition-colors',
        // F2 — persistent selection state. A copper ring + warmer
        // background tints the row whenever isSelected returns true.
        // This stays put across re-renders (replaces the 1.6s ping)
        // until the operator clicks a different row or somewhere
        // clears the selection.
        isRowSelected
          ? 'border-copper-400/60 bg-copper-100/40 ring-1 ring-copper-300/50'
          : item.blockKey
            ? 'border-transparent bg-warm-stone/5 text-warm-stone'
            : 'border-transparent bg-cream text-near-black hover:border-warm-stone/15 hover:bg-warm-stone/5',
        // F6 — orphan rows get a quiet red tint so they're visually
        // distinct in the tree even when the operator hasn't
        // selected them.
        orphan && 'border-red-200/60 bg-red-50/40',
        // Drag — the dragged row dims to a placeholder while its full-
        // opacity clone follows the cursor in the DragOverlay; a blocked
        // (grammar-invalid) projection rings it red.
        isDragging && 'opacity-40',
        isDragging && invalid && 'ring-2 ring-red-400/70',
      )}
    >
      <div
        className="flex items-center gap-2 px-2.5 py-2 text-left"
        style={{
          paddingLeft: `calc(0.625rem + ${depth * INDENT_WIDTH}px)`,
        }}
      >
        {/* Expand toggle for containers with children. Widgets stay
           leaves — no chevron, no toggle. */}
        {isContainer && hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleCollapse(item.id)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-warm-stone/70 transition-colors hover:bg-warm-stone/10 hover:text-near-black"
          >
            <ChevronDown
              size={12}
              strokeWidth={2.2}
              className={clsx(
                'transition-transform motion-reduce:transition-none',
                expanded ? 'rotate-0' : '-rotate-90',
              )}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="inline-block h-5 w-5" />
        )}

        <button
          type="button"
          {...(item.blockKey ? {} : attributes)}
          {...(item.blockKey ? {} : listeners)}
          // Click = select the block (persistent F2 ring) + scroll the
          // canvas to it + pulse copper. The dnd-kit PointerSensor
          // activation constraint (distance:5 on the parent DndContext)
          // means a no-move pointer up fires this click, while real
          // drags still activate after 5px of movement.
          onClick={item.blockKey ? undefined : selectAndScroll}
          disabled={!!item.blockKey}
          aria-label={
            item.blockKey
              ? `${item.blockType} ${item.id} — system block, locked`
              : `Select ${item.blockType} ${item.id} (drag to reorder)`
          }
          className={clsx(
            'inline-flex h-6 w-6 items-center justify-center rounded text-warm-stone/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-300/60',
            item.blockKey
              ? 'cursor-not-allowed'
              : 'cursor-grab active:cursor-grabbing group-hover:text-near-black hover:bg-warm-stone/10 hover:text-near-black',
          )}
        >
          {item.blockKey ? (
            <Lock size={11} strokeWidth={2} />
          ) : (
            <GripVertical size={13} strokeWidth={2} />
          )}
        </button>

        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-warm-stone/10 text-[10px] font-semibold text-near-black">
          {index}
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Icon
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-warm-stone"
            aria-hidden="true"
          />
          {/* F3 — Operator-set label. Double-click swaps the label for
              an <input>; blur or Enter commits, Escape cancels. We
              limit the inline-edit affordance to sections + columns
              (containers) — widgets don't benefit from a custom label
              (their type is already the label, and the EditDrawer
              owns widget-level identity). Fixed-slot blocks also
              opt out: their block_key IS the operator-visible
              identity. */}
          {editingLabel ? (
            <input
              ref={labelInputRef}
              type="text"
              defaultValue={labelDraft}
              autoFocus
              onFocus={(e) => {
                // Select the existing text so the operator can
                // overtype or extend cleanly.
                e.currentTarget.select()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitLabel(e.currentTarget.value)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingLabel(false)
                } else {
                  // Don't let Backspace / Delete bubble to the
                  // keyboard-shortcuts hook (it would delete the
                  // block while the operator is renaming it).
                  e.stopPropagation()
                }
              }}
              onBlur={(e) => void commitLabel(e.currentTarget.value)}
              maxLength={80}
              aria-label="Block label"
              className="min-w-0 flex-1 rounded border border-copper-300/60 bg-white/80 px-1.5 py-0.5 text-[12px] font-medium text-near-black outline-none ring-1 ring-copper-300/50 focus:border-copper-500"
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-[12px] font-medium"
              onDoubleClick={
                // Renameable when (a) container kind AND (b) not a
                // fixed-slot block. Widget labels would need a wider
                // schema change to feel native — out of scope for F3.
                isContainer && !isFixed
                  ? (e) => {
                      e.stopPropagation()
                      setLabelDraft(customLabel ?? '')
                      setEditingLabel(true)
                      // Microtask defer so the focus + select fire
                      // after the input mounts.
                      setTimeout(() => labelInputRef.current?.focus(), 0)
                    }
                  : undefined
              }
              title={
                isContainer && !isFixed
                  ? 'Double-click to rename'
                  : undefined
              }
            >
              {customLabel ??
                readableBlockLabel(item.blockType, item.kind)}
              {item.blockKey && (
                <span className="ml-1.5 text-[10px] font-normal text-warm-stone">
                  · {item.blockKey}
                </span>
              )}
              {orphan && (
                <span className="ml-1.5 text-[10px] font-normal text-red-600">
                  · orphan
                </span>
              )}
            </span>
          )}
          {/* F6 — preview-dot indicator. A small copper dot when the
              block has a pending SpacingToolbar / EditDrawer preview
              that hasn't been persisted yet. Clears automatically
              when the reducer wipes the preview on save. */}
          {hasPendingPreview && (
            <span
              aria-label="Unsaved spacing change"
              title="Unsaved spacing change"
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-copper-500 motion-safe:animate-pulse"
            />
          )}
        </span>

        {/* F1 — per-row action cluster. Hover-revealed at the right
            edge. Each verb routes through the same endpoints +
            recordCommand pattern the canvas toolbar uses, so the
            outline + toolbar can't drift. */}
        <span
          className={clsx(
            'ml-auto inline-flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-quick',
            // Always-visible when the row is selected (operator's
            // primary verb target) or busy (action in flight — the
            // disabled buttons show progress).
            (isRowSelected || actionBusy) && 'opacity-100',
            // Hover-reveal on the row group; focus-within keeps it
            // visible for keyboard operators tabbing into the
            // cluster.
            'group-hover:opacity-100 group-focus-within:opacity-100',
          )}
          aria-label="Row actions"
          // Action cluster is mouse-only chrome; the click target
          // mustn't bubble into the row's select-and-scroll handler.
          onClick={(e) => e.stopPropagation()}
        >
          {/* Section-only verbs */}
          {item.kind === 'section' && !isFixed && !orphan && (
            <>
              <OutlineRowButton
                icon={Columns3}
                label="Add column"
                disabled={actionBusy}
                onClick={() =>
                  void addChildBlock({
                    kind: 'column',
                    parentId: item.id,
                  })
                }
              />
              <OutlineRowButton
                icon={Plus}
                label="Add section after"
                disabled={actionBusy}
                onClick={() =>
                  void addChildBlock({
                    kind: 'section',
                    afterBlockId: item.id,
                  })
                }
              />
            </>
          )}
          {/* Column-only verb — add a widget into this column.
              Defaults to an lx_text widget (the most common starting
              shape). Operator can then use the slash palette / drawer
              to switch type if they want a different starter. */}
          {item.kind === 'column' && !isFixed && !orphan && (
            <OutlineRowButton
              icon={Plus}
              label="Add text widget"
              disabled={actionBusy}
              onClick={() =>
                void addChildBlock({
                  kind: 'widget',
                  parentId: item.id,
                  blockType: 'lx_text',
                })
              }
            />
          )}
          {/* Duplicate — sections / columns / widgets. Same gate as
              the canvas toolbar's duplicate verb. */}
          {canDuplicate && (
            <OutlineRowButton
              icon={Copy}
              label="Duplicate"
              disabled={actionBusy}
              onClick={() => void duplicate()}
            />
          )}
          {/* Delete — enabled for non-fixed rows AND for orphans
              (F4). Cascade for sections + columns is communicated in
              the success toast copy. */}
          {canDelete && (
            <OutlineRowButton
              icon={Trash2}
              label={
                item.kind === 'section'
                  ? 'Delete section (and its columns)'
                  : item.kind === 'column'
                    ? 'Delete column (and its widgets)'
                    : 'Delete'
              }
              destructive
              disabled={actionBusy}
              onClick={() => void deleteBlock()}
            />
          )}
        </span>
      </div>

    </li>
  )
})

// AddBlockMenu was extracted to its own left-pinned WidgetPicker
// component (components/inline-edit/WidgetPicker.tsx). The outline
// now does ONE thing: render + reorder the tree. Operators can
// dismiss the outline without losing access to widget creation.

// Per-row action button. Compact icon-only button with a label
// tooltip + sr-only accessible name. Destructive variant tints
// the icon red on hover for delete verbs. F1.
function OutlineRowButton({
  icon: IconCmp,
  label,
  destructive = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon
  label: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex h-6 w-6 items-center justify-center rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-300/60',
        disabled
          ? 'cursor-not-allowed opacity-40'
          : destructive
            ? 'text-warm-stone/70 hover:bg-red-500/10 hover:text-red-600'
            : 'text-warm-stone/70 hover:bg-warm-stone/10 hover:text-near-black',
      )}
    >
      <IconCmp size={12} strokeWidth={2} aria-hidden="true" />
    </button>
  )
}
