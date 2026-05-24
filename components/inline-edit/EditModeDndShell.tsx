'use client'

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  pointerWithin,
  rectIntersection,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection,
} from '@dnd-kit/core'
import { InsertionPreviewLine } from './InsertionPreviewLine'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { csrfFetch } from '@/lib/client/csrf'
import { groupByParent } from '@/lib/cms/blockTree'
import { MAX_SECTION_COLUMNS, type BlockKind } from '@/lib/cms/blockMeta'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import { useToast } from './Toast'
import { useRecordCommand } from './UndoStackProvider'
import {
  useInlineEditDispatch,
  useInlineEditState,
  useInsertBlock,
  type InsertableBlockType,
} from './InlineEditContext'

// Page-wide DnD shell (Chunks B+D). One DndContext for the WHOLE page
// so cross-container collisions resolve in one engine. Nested
// SortableContexts (top-level sections + loose widgets; per-section
// columns; per-column widgets) live inside the children and share
// this DndContext's sensors / collision detection.
//
// Chunk B optimistic rewire: blocks state comes from InlineEditContext
// instead of an initialBlocks prop + dragSnapshotRef pair. The drop
// handler dispatches `apply-move` BEFORE the POST so the operator
// sees the new arrangement instantly; the server response feeds
// `set-versions` to advance per-block optimistic-lock cursors without
// a router.refresh round-trip. Network / 409 failures dispatch the
// pre-move snapshot to roll the tree back.
//
// Drag affordances:
//   - DragOverlay renders a cloneNode(true) of the source DOM at 60%
//     opacity so the operator sees the actual block riding the
//     cursor (vs. the prior copper-pill stub which gave no shape
//     fidelity).
//   - DropIndicator renders a 2px copper line at the insertion gap
//     between siblings — horizontal for vertically-stacked containers
//     (top-level + column widgets), vertical for column rows that sit
//     side-by-side inside a section grid.

// Re-exported (was Chunk D's BlockSnap) for any external consumer
// still typing against the snapshot shape. The DnD shell no longer
// needs the explicit interface — it reads HydratedBlock directly via
// context — but type-only callers (e.g. tests / future tooling) get
// a tidy struct to import.
export interface BlockSnap {
  id: number
  kind: BlockKind
  parentId: number | null
  position: number
  version: number
}

// Empty-container droppable id scheme. Numeric block ids are unique
// across content_blocks (PK) so they collide with nothing; string
// prefixes for synthetic drop zones distinguish them safely. Decoders
// below own the parse — never inline.
const EMPTY_COL_PREFIX = 'empty-col:'

export function encodeEmptyColumnDropId(columnId: number): string {
  return `${EMPTY_COL_PREFIX}${columnId}`
}

function decodeOverId(
  raw: string | number,
):
  | { kind: 'block'; id: number }
  | { kind: 'empty-col'; columnId: number }
  | null {
  if (typeof raw === 'number') return { kind: 'block', id: raw }
  if (raw.startsWith(EMPTY_COL_PREFIX)) {
    const n = Number(raw.slice(EMPTY_COL_PREFIX.length))
    if (!Number.isFinite(n) || n <= 0) return null
    return { kind: 'empty-col', columnId: n }
  }
  const n = Number(raw)
  if (Number.isInteger(n) && n > 0) return { kind: 'block', id: n }
  return null
}

interface Props {
  pageId: number
  children: ReactNode
}

export function EditModeDndShell({ pageId, children }: Props) {
  const router = useRouter()
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const dispatch = useInlineEditDispatch()
  const state = useInlineEditState()
  const insertBlock = useInsertBlock()
  // SSR-stable DndContext id (paired with the DndContext below) so
  // @dnd-kit's `aria-describedby` annotations match across the
  // hydration boundary. Audit finding E2 (Chunk K).
  const dndContextId = useId()
  const [busy, setBusy] = useState(false)
  const [activeId, setActiveId] = useState<number | null>(null)
  // Parallel state for palette drags (WidgetPicker → canvas). Stays
  // separate from `activeId` (block id, numeric) because palette ids
  // are strings (`palette:<label>`) and `activeBlock` lookups would
  // otherwise short-circuit. When set, DragOverlay renders a labelled
  // PaletteDragGhost in place of the block-clone DragGhost.
  const [activePaletteLabel, setActivePaletteLabel] = useState<string | null>(
    null,
  )
  const [, startTransition] = useTransition()
  // Mounted-guard ref so a slow PATCH that resolves after an edit-
  // mode toggle / route change doesn't call setState on a torn-down
  // shell.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Mirror state in a ref so the drag-end useCallback doesn't have to
  // list state.blocks in deps (which would re-create the handler —
  // and detach + re-attach it on the DndContext — on every keystroke
  // that changes a preview overlay). The handler reads stateRef at
  // the moment of the drop.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 6px activation distance — same as the rest of the editor —
      // so a tap on a toolbar button (Edit / Up / Delete) doesn't
      // accidentally start a drag. Operators reach for the dedicated
      // drag handle.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  // Custom collision detection: prefer pointerWithin (cursor inside
  // a droppable) → fall back to rectIntersection → fall back to
  // closestCenter. The pointerWithin step ensures empty-column drop
  // zones (which have a min-height + dashed border) accept drops as
  // soon as the cursor is INSIDE them, even before the active item's
  // rect overlaps. closestCenter alone misses empty zones when the
  // active item is small and far from the zone's center.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointer = pointerWithin(args)
    if (pointer.length > 0) return pointer
    const intersections = rectIntersection(args)
    if (intersections.length > 0) return intersections
    return closestCenter(args)
  }, [])

  const onDragStart = useCallback((event: DragStartEvent) => {
    if (busy) return
    const rawId = event.active.id
    // Palette branch — `palette:<label>` ids come from WidgetPicker
    // pills. They aren't block ids; we surface a labelled overlay
    // instead of cloning a source-DOM block (which doesn't exist).
    if (typeof rawId === 'string' && rawId.startsWith('palette:')) {
      const data = event.active.data.current as
        | { kind?: string; label?: string }
        | undefined
      if (data?.kind === 'palette') {
        setActivePaletteLabel(
          typeof data.label === 'string' && data.label.length > 0
            ? data.label
            : rawId.slice('palette:'.length),
        )
      }
      return
    }
    const id = typeof rawId === 'number' ? rawId : Number(rawId)
    if (Number.isInteger(id) && id > 0) {
      setActiveId(id)
    }
  }, [busy])

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setActivePaletteLabel(null)
      if (!over || busy) return

      // ── Palette → canvas insert path ─────────────────────────────
      // When the operator drags a pill out of WidgetPicker, `active.id`
      // is `palette:<label>` and `active.data.current.kind === 'palette'`.
      // We resolve the drop target (block id or `empty-col:N` synthetic)
      // into the `{parentId, beforeBlockId}` triple `useInsertBlock`
      // already accepts (same pipeline used by every click-to-insert
      // surface), then POST. The router refresh inside `useInsertBlock`
      // pulls the new block into the tree on success.
      //
      // Ancestor-cycle guard: not needed here — palette items have no
      // descendants in the tree. Column-cap: not needed either —
      // palette has no `section` pills today (only widgets), so we
      // never try to add a column to a section here. Both invariants
      // are server-enforced anyway; the 4xx response is mapped via
      // `mapInsertBlockError` and toasted.
      if (typeof active.id === 'string' && active.id.startsWith('palette:')) {
        const paletteData = active.data.current as
          | {
              kind?: string
              blockType?: InsertableBlockType
              seedData?: Record<string, unknown>
            }
          | undefined
        if (
          !paletteData ||
          paletteData.kind !== 'palette' ||
          typeof paletteData.blockType !== 'string'
        ) {
          return
        }

        const overDecoded = decodeOverId(over.id as string | number)
        if (!overDecoded) return

        // Resolve drop target into {parentId, beforeBlockId|afterBlockId}
        // the server accepts. The mapping depends on the OVER row's
        // kind because the server enforces per-kind parent rules:
        //   widget → parent must be column (or null for loose top-level)
        //   column → parent must be section
        //   section → parent must be null
        //
        //   over = widget   → insert AS SIBLING of the widget (same
        //                     column or top-level). beforeBlockId vs
        //                     afterBlockId is decided by the cursor's
        //                     vertical position relative to the over
        //                     rect's midpoint — drop on the upper half
        //                     → before, lower half → after. (Without
        //                     this the inserted block always landed
        //                     ABOVE the target regardless of where the
        //                     operator released, which contradicts the
        //                     Webflow/Elementor mental model and the
        //                     copper InsertionPreviewLine that already
        //                     animates above-vs-below during the drag.)
        //   over = column   → insert AS CHILD of the column at its
        //                     tail. parentId = column.id, no
        //                     before/after. (Using widget.parentId
        //                     here would resolve to the SECTION, which
        //                     the server rejects with
        //                     widget_parent_must_be_column.)
        //   over = section  → insert AT TOP LEVEL, before or after the
        //                     section by the same mid-Y test. parentId
        //                     = null (loose top-level widget, accepted
        //                     by the server's pre-Chunk-B legacy path).
        //   over = empty-col → insert AS CHILD of the empty column
        //                     (handled by the empty-col branch above).
        //
        // Cursor-position test. dnd-kit's `active.rect.current.translated`
        // is the source element's rect shifted by the pointer delta.
        // For palette drags using DragOverlay the source pill stays
        // put visually, but the translated rect still tracks the
        // pointer — so its mid-Y is effectively the cursor's Y. We
        // compare against the over rect's mid-Y to decide direction.
        // Defaults to `insertBefore = true` when the rect is missing
        // (race with a torn-down active node) — same conservative
        // default the prior single-direction logic shipped.
        let parentId: number | null = null
        let beforeBlockId: number | null = null
        let afterBlockId: number | null = null
        if (overDecoded.kind === 'empty-col') {
          parentId = overDecoded.columnId
        } else {
          const overBlock = stateRef.current.blocks.find(
            (b) => b.id === overDecoded.id,
          )
          if (!overBlock) return
          const activeRect = active.rect.current.translated
          const overRect = over.rect
          const insertBefore =
            activeRect === null
              ? true
              : activeRect.top + activeRect.height / 2 <
                overRect.top + overRect.height / 2
          if (overBlock.kind === 'column') {
            parentId = overBlock.id
            // Upper half of the column rect → prepend by anchoring
            // before the column's first child widget. Lower half →
            // append (no anchor; server's append-to-tail path runs).
            // Same operator mental model as widget/section drops, so
            // a drop near the top of a column doesn't surprise-land
            // at the bottom.
            if (insertBefore) {
              const firstChild = stateRef.current.blocks
                .filter((b) => b.parentId === overBlock.id)
                .sort((a, b) => a.position - b.position)[0]
              if (firstChild) beforeBlockId = firstChild.id
              // If the column has no children at the moment of drop
              // (race with a sibling delete), fall through to append
              // — server-side INSERT picks the next free position.
            }
          } else if (overBlock.kind === 'section') {
            parentId = null
            if (insertBefore) beforeBlockId = overBlock.id
            else afterBlockId = overBlock.id
          } else {
            parentId = overBlock.parentId
            if (insertBefore) beforeBlockId = overBlock.id
            else afterBlockId = overBlock.id
          }
        }

        setBusy(true)
        try {
          const res = await insertBlock(paletteData.blockType, {
            pageId,
            parentId: parentId ?? undefined,
            beforeBlockId: beforeBlockId ?? undefined,
            afterBlockId: afterBlockId ?? undefined,
            data: paletteData.seedData,
          })
          if (!mountedRef.current) return
          if (!res.ok) {
            toast.error(mapInsertBlockError(res.error).copy)
          }
        } catch (e) {
          if (!mountedRef.current) return
          toast.error(
            e instanceof Error ? e.message : 'Network error — try again.',
          )
        } finally {
          if (mountedRef.current) setBusy(false)
        }
        return
      }

      // Pre-move snapshot — captures position+parent tuples per block
      // AT THE MOMENT OF THE DROP. Critically, we do NOT snapshot the
      // whole blocks array because rollback must NOT clobber any
      // concurrent block-saved that lands during the in-flight POST
      // (e.g. operator types in an inline editor mid-drag → block-saved
      // bumps state.blocks[i].data — restoring preMove.blocks would
      // visually revert their just-typed text). On rollback we apply
      // ONLY the position/parent restore against the live state.
      const preMovePositions = new Map<
        number,
        { parentId: number | null; position: number }
      >()
      for (const b of stateRef.current.blocks) {
        preMovePositions.set(b.id, {
          parentId: b.parentId,
          position: b.position,
        })
      }
      // Effective per-block version: prefer the versionOverride if it
      // exists (= fresher than state.blocks[i].version, because the
      // override is set from server's post-save response). Required
      // for the second-consecutive-drag case: after a successful
      // reorder, state.blocks[i].version is stale (apply-move doesn't
      // bump versions); the override carries the truth. Submitting
      // state.blocks[i].version would 409 every time.
      const blockSnaps = stateRef.current.blocks.map((b) => {
        const ov = stateRef.current.versionOverrides.get(b.id)
        return {
          id: b.id,
          kind: b.kind,
          parentId: b.parentId,
          position: b.position,
          version: ov && ov.blockVersion > b.version ? ov.blockVersion : b.version,
        }
      })
      const byId = new Map<number, (typeof blockSnaps)[number]>()
      for (const b of blockSnaps) byId.set(b.id, b)

      const activeIdNum =
        typeof active.id === 'number' ? active.id : Number(active.id)
      if (!Number.isInteger(activeIdNum) || activeIdNum <= 0) return

      const activeBlock = byId.get(activeIdNum)
      if (!activeBlock) return

      const overDecoded = decodeOverId(over.id as string | number)
      if (!overDecoded) return

      const sourceParent = activeBlock.parentId
      let destParent: number | null
      let destBeforeId: number | null = null
      // Cursor-position-aware direction. Same heuristic as the
      // InsertionPreviewLine that already animates above-vs-below the
      // anchor during the drag: compare the active rect's midpoint
      // against the over rect's midpoint. Vertical comparison (Y) for
      // top-level sections + column widgets (vertical stack);
      // horizontal (X) for column-on-column (horizontal grid). Without
      // this flag the reorder always landed BEFORE the anchor, which
      // made top→bottom drags read as a no-op.
      let dropAfterAnchor = false

      if (overDecoded.kind === 'empty-col') {
        destParent = overDecoded.columnId
      } else {
        const overBlock = byId.get(overDecoded.id)
        if (!overBlock) return
        if (overBlock.id === activeBlock.id) return

        const activeRect = active.rect.current.translated
        const overRect = over.rect

        // ── Cross-kind drop handling ─────────────────────────────
        // dnd-kit's collision sometimes resolves to a CONTAINER row
        // (section or column) instead of a leaf widget when the
        // cursor is in a gutter between siblings. The naive
        // `destParent = overBlock.parentId` then proposes a parent
        // whose kind is wrong for the active row, and the reorder
        // POST 400s with widget_parent_must_be_column /
        // column_parent_must_be_section. Branch on kind so widget
        // drops INTO containers (matching the palette branch
        // semantics), and same-kind drops sit AS SIBLINGS of the
        // anchor with cursor-Y deciding before vs after.
        if (
          activeBlock.kind === 'widget' &&
          overBlock.kind === 'column'
        ) {
          destParent = overBlock.id
          // Upper half = prepend (anchor = column's first child);
          // lower half = append (no anchor → server appends to tail).
          const upperHalf =
            !!activeRect &&
            activeRect.top + activeRect.height / 2 <
              overRect.top + overRect.height / 2
          if (upperHalf) {
            const firstChild = blockSnaps
              .filter((b) => b.parentId === overBlock.id)
              .sort((a, b) => a.position - b.position)[0]
            if (firstChild) destBeforeId = firstChild.id
          }
        } else if (
          activeBlock.kind === 'widget' &&
          overBlock.kind === 'section'
        ) {
          // Widget on section row → loose top-level widget, above
          // or below the section by cursor-Y.
          destParent = null
          destBeforeId = overBlock.id
          if (activeRect) {
            dropAfterAnchor =
              activeRect.top + activeRect.height / 2 >
              overRect.top + overRect.height / 2
          }
        } else {
          // Same-kind sibling positioning: anchor stays the over row,
          // direction by cursor mid-Y (or mid-X for column rows).
          destParent = overBlock.parentId
          destBeforeId = overBlock.id
          if (activeRect) {
            if (overBlock.kind === 'column') {
              dropAfterAnchor =
                activeRect.left + activeRect.width / 2 >
                overRect.left + overRect.width / 2
            } else {
              dropAfterAnchor =
                activeRect.top + activeRect.height / 2 >
                overRect.top + overRect.height / 2
            }
          }
        }
      }

      // Ancestor-cycle guard. Without this, a drop whose destination
      // parent is the active item OR one of the active item's
      // descendants produces an invalid reorder where a block becomes
      // its own ancestor — the server rightly returns 400 (e.g. body
      // `{"id":101,"newParentId":101}`) but the operator sees no
      // change and no clear feedback. Real-user trigger: drag overlay
      // obscures the actual drop target on a same-axis move, the
      // operator releases over a child of the dragged section, dnd-
      // kit's collision detection picks that child's column. Walk
      // up from destParent and refuse if we hit activeIdNum. Self-
      // walk safety: a malformed parent chain that loops (shouldn't
      // happen in the DB but defence in depth) is bounded by the
      // `visited` Set.
      if (destParent !== null) {
        const visited = new Set<number>()
        let cursor: number | null = destParent
        while (cursor !== null && !visited.has(cursor)) {
          if (cursor === activeIdNum) {
            toast.error(`Can't drop a ${activeBlock.kind} into itself.`)
            return
          }
          visited.add(cursor)
          const parent: number | null = byId.get(cursor)?.parentId ?? null
          cursor = parent
        }
      }

      // Resolve sibling lists using the shared partition primitive so
      // server + client agree on tie-break semantics under equal
      // positions.
      const byParent = groupByParent(blockSnaps)
      const sourceSiblings = (byParent.get(sourceParent) ?? []).map(
        (b) => b.id,
      )
      const destSiblings =
        sourceParent === destParent
          ? sourceSiblings
          : (byParent.get(destParent) ?? []).map((b) => b.id)

      let newSourceOrder: number[]
      let newDestOrder: number[]
      if (sourceParent === destParent) {
        const filtered = sourceSiblings.filter((id) => id !== activeIdNum)
        let insertAt: number
        if (destBeforeId === null) {
          insertAt = filtered.length
        } else {
          const idx = filtered.indexOf(destBeforeId)
          if (idx < 0) {
            insertAt = filtered.length
          } else {
            insertAt = dropAfterAnchor ? idx + 1 : idx
          }
        }
        filtered.splice(insertAt, 0, activeIdNum)
        // No-op? Compare with original sibling order.
        const sameOrder =
          filtered.length === sourceSiblings.length &&
          filtered.every((id, i) => id === sourceSiblings[i])
        if (sameOrder) return
        newSourceOrder = filtered
        newDestOrder = filtered
      } else {
        newSourceOrder = sourceSiblings.filter((id) => id !== activeIdNum)
        const destCopy = destSiblings.slice()
        let insertAt: number
        if (destBeforeId === null) {
          insertAt = destCopy.length
        } else {
          const idx = destCopy.indexOf(destBeforeId)
          if (idx < 0) {
            insertAt = destCopy.length
          } else {
            insertAt = dropAfterAnchor ? idx + 1 : idx
          }
        }
        destCopy.splice(insertAt, 0, activeIdNum)
        newDestOrder = destCopy
      }

      const blockUpdates: Array<{
        id: number
        version: number
        newParentId: number | null
      }> = []
      const seen = new Set<number>()
      const pushUpdate = (id: number, newParentId: number | null) => {
        if (seen.has(id)) return
        seen.add(id)
        const b = byId.get(id)
        if (!b) return
        blockUpdates.push({ id, version: b.version, newParentId })
      }
      for (const id of newSourceOrder) pushUpdate(id, sourceParent)
      if (sourceParent !== destParent) {
        for (const id of newDestOrder) pushUpdate(id, destParent)
      }

      // Rollback closure — restores ONLY (parentId, position) per
      // block, against the CURRENT state.blocks (read at rollback
      // time, not at drag-start time). This preserves any concurrent
      // block-saved that landed during the in-flight POST. Without
      // this, a rollback would visually revert any inline-edit /
      // drawer save the operator made on a different widget while
      // the drag's POST was flying.
      const rollback = () => {
        const live = stateRef.current.blocks
        let changed = false
        const restored = live.map((b) => {
          const orig = preMovePositions.get(b.id)
          if (!orig) return b
          if (b.parentId === orig.parentId && b.position === orig.position) {
            return b
          }
          changed = true
          return { ...b, parentId: orig.parentId, position: orig.position }
        })
        if (!changed) return
        dispatch({
          type: 'snapshot',
          blocks: restored,
          pageVersion: stateRef.current.pageVersion,
        })
      }

      // OPTIMISTIC UPDATE — flush to context before the network call.
      dispatch({
        type: 'apply-move',
        sourceParent,
        sourceOrder: newSourceOrder,
        destParent,
        destOrder: newDestOrder,
      })

      setBusy(true)
      try {
        const res = await csrfFetch('/api/cms/blocks/reorder', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId, blocks: blockUpdates }),
        })
        if (!mountedRef.current) return
        if (!res.ok) {
          rollback()
          const j = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          if (!mountedRef.current) return
          if (res.status === 409 && j.error === 'column_count_exceeded') {
            toast.error(
              `That section is at the ${MAX_SECTION_COLUMNS}-column maximum — pick a different section.`,
            )
            // Server-side state may have shifted (someone else added
            // a column). Refresh to pull the authoritative tree —
            // reconciliation effect will skip if other previews are
            // pending, but the refresh's props ARE the truth, so we
            // need to force-reconcile when they arrive.
            startTransition(() => router.refresh())
          } else if (res.status === 409) {
            toast.error(
              'Something changed on the page — refreshing to pull the latest.',
            )
            startTransition(() => router.refresh())
          } else if (res.status === 400) {
            toast.error(
              j.error
                ? `Move rejected: ${j.error.replace(/_/g, ' ')}.`
                : "That move isn't allowed.",
            )
          } else if (res.status === 404) {
            toast.error(
              'The target container is gone — refreshing the page.',
            )
            startTransition(() => router.refresh())
          } else {
            toast.error(j.error ?? "We couldn't move that block.")
          }
          return
        }
        // SUCCESS — body shape: { blocks: [{ id, version, position,
        // parentId }, ...] }. Server bumps each block.version by 1
        // but does NOT bump pages.version (reorders are page-version
        // neutral). Apply per-block version overrides so the next
        // edit on any of these blocks uses the freshest cursor and
        // doesn't 409.
        const json = (await res.json().catch(() => null)) as {
          blocks?: Array<{
            id: number
            version: number
            position: number
            parentId: number | null
          }>
          pageVersion?: number
        } | null
        if (!mountedRef.current) return
        if (json?.blocks) {
          // pageVersion source: prefer the server-truth value returned
          // in the reorder response — /api/cms/blocks/reorder now bumps
          // pages.version in the same TX and surfaces the new cursor as
          // `pageVersion`. Falling back to stateRef would broadcast a
          // STALE cursor across every block's versionOverrides, and the
          // operator's next save would 409 with stale_page_version on
          // every drag. (Pre-fix this path used liveStatePageVersion
          // unconditionally and produced a 409 storm after every drop.)
          const nextPageVersion =
            typeof json.pageVersion === 'number'
              ? json.pageVersion
              : stateRef.current.pageVersion
          // Validate the FULL response shape before dispatching ANY
          // set-versions. A single malformed entry (proxy stripped a
          // field, server response corruption) would otherwise leave the
          // unbumped rows perpetually 409-ing on the operator's next
          // save. If anything is off, refresh from server truth so the
          // optimistic state never holds a partial bump.
          const allValid = json.blocks.every(
            (b) => typeof b.id === 'number' && typeof b.version === 'number',
          )
          if (!allValid) {
            startTransition(() => router.refresh())
            return
          }
          for (const b of json.blocks) {
            dispatch({
              type: 'set-versions',
              blockId: b.id,
              blockVersion: b.version,
              pageVersion: nextPageVersion,
            })
          }
          // ── Chunk J — record REORDER (cross-parent DnD path) on the
          // undo stack. Inverse uses each block's PRIOR parentId from
          // preMovePositions + the FRESH versions returned by this
          // forward (the next round trip must satisfy the optimistic
          // lock against the just-bumped versions). deriveRebind in
          // UndoStackProvider keeps both sides' versions in sync.
          const newVersionById = new Map<number, number>()
          for (const b of json.blocks) {
            if (typeof b.id === 'number' && typeof b.version === 'number') {
              newVersionById.set(b.id, b.version)
            }
          }
          const inverseBlocks = blockUpdates.map((u) => ({
            id: u.id,
            version: newVersionById.get(u.id) ?? u.version,
            newParentId: preMovePositions.get(u.id)?.parentId ?? null,
          }))
          const forwardBlocks = blockUpdates.map((u) => ({
            id: u.id,
            version: newVersionById.get(u.id) ?? u.version,
            newParentId: u.newParentId,
          }))
          recordCommand({
            kind: 'reorder',
            label: 'Moved blocks',
            timestamp: Date.now(),
            forward: {
              method: 'POST',
              path: '/api/cms/blocks/reorder',
              body: { pageId, blocks: forwardBlocks },
              expects: 200,
            },
            inverse: {
              method: 'POST',
              path: '/api/cms/blocks/reorder',
              body: { pageId, blocks: inverseBlocks },
              expects: 200,
            },
            captures: { pageId, blockCount: blockUpdates.length },
          })
        } else {
          // Body parse failed but the reorder COMMITTED server-side.
          // The optimistic positions are correct; the versions are
          // one behind. Surface a quiet refresh so the next save
          // doesn't 409.
          startTransition(() => router.refresh())
        }
      } catch (e) {
        if (!mountedRef.current) return
        rollback()
        toast.error(
          e instanceof Error ? e.message : 'Network error — try again.',
        )
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [busy, dispatch, insertBlock, pageId, recordCommand, router, toast],
  )

  const onDragCancel = useCallback(() => {
    setActiveId(null)
    setActivePaletteLabel(null)
  }, [])

  const activeBlock = useMemo(
    () =>
      activeId === null
        ? null
        : state.blocks.find((b) => b.id === activeId) ?? null,
    [activeId, state.blocks],
  )

  return (
    <DndContext
      // Stable id across SSR + hydration. Without this, @dnd-kit's
      // internal counter generates "DndDescribedBy-N" with a
      // different N on the server vs the client, fires a React 19
      // hydration mismatch warning, and marks the whole editor
      // tree as un-patchable. Audit finding E2 (Chunk K) — sister
      // fix to the OutlinePanel DndContext.
      id={dndContextId}
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
      <InsertionPreviewLine />
      <DragOverlay dropAnimation={null}>
        {activePaletteLabel ? (
          <PaletteDragGhost label={activePaletteLabel} />
        ) : activeBlock ? (
          <DragGhost
            id={activeBlock.id}
            kind={activeBlock.kind}
            fallbackLabel={fallbackLabelFor(activeBlock.kind, activeBlock.id)}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// Labelled ghost for palette drags. WidgetPicker pills have no
// equivalent "source DOM" to clone (the pill itself isn't a preview
// of the block that will land), so we render a champagne pill that
// reads the same as the source pill in the picker — operator sees
// what they grabbed riding the cursor.
function PaletteDragGhost({ label }: { label: string }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none inline-flex items-center gap-1.5 rounded-full bg-champagne px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-obsidian shadow-[0_18px_36px_-12px_rgba(0,0,0,0.55)] ring-1 ring-champagne/40"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-obsidian" />
      {label}
    </div>
  )
}

function fallbackLabelFor(kind: BlockKind, id: number): string {
  if (kind === 'section') return `Section #${id}`
  if (kind === 'column') return `Column #${id}`
  return `Widget #${id}`
}

// cloneNode-based drag ghost. Reads the source element's DOM from
// the editor surface (the rendered EditableSection / Column / Block
// already carries `data-edit-*-id` markers) and renders an aria-hidden
// clone inside the DragOverlay so the operator sees a faded copy of
// the actual block riding the cursor. Falls back to a labelled pill
// when the source isn't found (rare — e.g. the operator detached the
// node from the DOM mid-drag).
//
// `dangerouslySetInnerHTML` here is safe: the source is server-rendered
// content already through every Zod + DOMPurify sanitiser on its way
// out. We strip duplicate `id` / `data-edit-*-id` attrs from the
// clone so the ghost can't be re-targeted by an unrelated
// `document.querySelector` elsewhere in the editor.
function DragGhost({
  id,
  kind,
  fallbackLabel,
}: {
  id: number
  kind: BlockKind
  fallbackLabel: string
}) {
  const [snapshot, setSnapshot] = useState<{
    html: string
    width: number
    height: number
  } | null>(null)

  useEffect(() => {
    const sel =
      kind === 'section'
        ? `[data-edit-section-id="${id}"]`
        : kind === 'column'
          ? `[data-edit-column-id="${id}"]`
          : `[data-edit-block-id="${id}"]`
    const source = document.querySelector<HTMLElement>(sel)
    if (!source) return
    const rect = source.getBoundingClientRect()
    // Large-section size cap. cloneNode(true) + per-descendant attr
    // walk is O(N×M). On a hero section with hundreds of widgets +
    // gallery images, the strip pass can exceed the drag-start frame
    // budget (16ms target) and stutter the ghost. Fall back to the
    // labelled pill above the cap — the ghost loses shape fidelity
    // but the drag stays smooth.
    const DESCENDANT_CAP = 500
    if (source.querySelectorAll('*').length > DESCENDANT_CAP) return
    const clone = source.cloneNode(true) as HTMLElement
    // Walk every element in the clone (root + descendants) and:
    //   1. Strip identifying attrs (id, every data-edit-* + data-
    //      section-id/data-column-id from the inner renderShell layout,
    //      every data-inline-edit*) so the ghost can't be re-targeted
    //      by a stray querySelector elsewhere in the editor.
    //   2. Strip ARIA-roleplay attrs (role, tabindex, contenteditable)
    //      so the ghost can't catch keyboard focus or be picked up by
    //      a `[contenteditable="true"]` scanner.
    //   3. Drop any `on*` event handler attribute and any
    //      script/iframe/object/embed element — even though React
    //      doesn't emit inline event handlers, a contentEditable
    //      operator who dropped raw HTML into the source surface
    //      (mid-typing, pre-sanitiser) could otherwise have
    //      `<img onerror>` ride into the DragGhost's
    //      dangerouslySetInnerHTML and fire.
    //   4. Reject javascript: / vbscript: / data:text/html URIs on
    //      src/href to close the same attacker surface.
    // Protocol-deny: strips C0 control chars + whitespace from the
    // attribute value BEFORE matching, then literal-matches the
    // protocol prefix. Catches `java<TAB>script:`, `java\nscript:`,
    // ` javascript:`, etc. — browsers normalise these during URL
    // parsing so they MUST be stripped from the deny check.
    const PROTOCOL_DENY = /^(?:javascript|vbscript|data:text\/html)/i
    const stripCtrlAndWs = (v: string): string =>
      v.replace(/[\u0000-\u001f\s]+/g, '')
    const PROTOCOL_ATTRS: ReadonlySet<string> = new Set([
      'src',
      'href',
      'action',
      'formaction',
      'poster',
      'background',
      'xlink:href',
    ])
    const stripDangerous = (node: HTMLElement) => {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name
        if (
          name === 'id' ||
          name === 'role' ||
          name === 'tabindex' ||
          name === 'contenteditable' ||
          name === 'style' ||
          // srcset is comma-separated (`url1 1x, url2 2x`); a single
          // protocol-deny test only checks the first candidate. Drop
          // it entirely — the ghost is a transient drag preview, no
          // need for responsive image candidates.
          name === 'srcset' ||
          name.startsWith('on') ||
          name.startsWith('data-edit-') ||
          name.startsWith('data-inline-edit') ||
          name === 'data-section-id' ||
          name === 'data-column-id'
        ) {
          node.removeAttribute(name)
          continue
        }
        if (
          PROTOCOL_ATTRS.has(name) &&
          PROTOCOL_DENY.test(stripCtrlAndWs(attr.value))
        ) {
          node.removeAttribute(name)
        }
      }
    }
    stripDangerous(clone)
    clone
      .querySelectorAll<HTMLElement>('*')
      .forEach((n) => stripDangerous(n))
    clone
      .querySelectorAll(
        'script, iframe, object, embed, link[rel="import"], base, meta, form',
      )
      .forEach((n) => n.remove())
    setSnapshot({
      html: clone.outerHTML,
      width: rect.width,
      height: rect.height,
    })
  }, [id, kind])

  if (!snapshot) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-none inline-flex items-center gap-2 rounded-full bg-near-black/95 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-cream-50 shadow-[0_18px_36px_-12px_rgba(5,5,5,0.55)] backdrop-blur-sm"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-copper-400" />
        {fallbackLabel}
      </div>
    )
  }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none opacity-60 transition-opacity duration-quick ease-standard motion-reduce:transition-none"
      style={{ width: snapshot.width, height: snapshot.height }}
      dangerouslySetInnerHTML={{ __html: snapshot.html }}
    />
  )
}

// (DropIndicator extracted to ./InsertionPreviewLine — mounted as
// <InsertionPreviewLine /> inside the DndContext above.)
