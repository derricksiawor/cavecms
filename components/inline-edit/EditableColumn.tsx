'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  Settings,
  Trash2,
  GripVertical,
  Loader2,
  Plus,
  ArrowLeft,
  ArrowRight,
  Image as ImageIcon,
  X,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { csrfFetch } from '@/lib/client/csrf'
import type { SectionBackground } from '@/lib/cms/blockMeta'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import { EditDrawer, type TabKey } from './EditDrawer'
import { useContextMenu } from './ContextMenuProvider'
import {
  ColumnWidgetsSortable,
  EmptyColumnDroppable,
} from './SortableContainers'
import { SpacingToolbar } from './SpacingToolbar'
import { useToast } from './Toast'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import { useMediaPicker } from './MediaPickerProvider'
import {
  useEffectiveVersions,
  useInsertBlock,
  useInlineEditDispatch,
  useInlineEditState,
} from './InlineEditContext'
import {
  SEED_ENTRIES,
  isPaletteVisible,
  type SeedBlockType,
} from '@/lib/cms/blockSeeds'
import { useSelection } from './SelectionContext'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'

// Column-level edit chrome (migration 0011 / Chunk C). Wraps a column's
// widget stack with a hover toolbar surfacing the column-only actions:
//   - Settings: opens EditDrawer keyed on blockType='column' which
//     PATCHes meta (width grid-span override).
//   - Move left/right: F1 — keyboard- + touch-reachable column reorder
//     within the parent section.
//   - Delete: optimistic soft-delete with a toast Undo (F5 — no
//     ConfirmModal; 30-day server trash backs recovery).
//
// Empty columns render a dashed drop-zone with a prominent "Add
// widget" CTA so the affordance is discoverable.

interface Props {
  blockId: number
  initialMeta: unknown
  initialVersion: number
  pageId: number
  pageVersion: number
  hasWidgets: boolean
  // Parent section's background tone — drives the empty-column
  // drop-zone palette so cream-on-cream and cream-on-near-black both
  // read with usable contrast (the dashed-zone otherwise muddies on
  // near-black sections, debugger flag).
  sectionBackground: SectionBackground
  // Parent section id — passed up to useSortable so the drag-end
  // handler resolves drops correctly (containerId = section.id for
  // column items).
  parentSectionId: number
  // Per-column widget ids in render order — items for the per-column
  // widgets SortableContext.
  widgetIds: number[]
  children: React.ReactNode
}

interface ToolButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  destructive?: boolean
  busy?: boolean
  disabled?: boolean
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  destructive,
  busy,
  disabled,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-busy={busy}
      className={clsx(
        // Touch target ≥ 44px per project standards mobile rules.
        'inline-flex h-11 w-11 items-center justify-center rounded-full text-cream-50 transition-all hover:scale-105 focus-visible:scale-105 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100',
        destructive
          ? 'hover:bg-red-500 focus-visible:bg-red-500'
          : 'hover:bg-copper-500 focus-visible:bg-copper-500',
      )}
    >
      {busy ? (
        <Loader2 size={15} strokeWidth={2.4} className="animate-spin" />
      ) : (
        <Icon size={15} strokeWidth={2.2} />
      )}
    </button>
  )
}

// Read sibling columns under the parent section. Columns are uniquely
// scoped per-section in `[data-edit-column-id]` rows — filter by the
// parent section id via the DOM ancestor chain.
function readColumnSiblings(
  pageId: number,
  parentSectionId: number,
): Array<{ id: number; version: number }> {
  if (typeof document === 'undefined') return []
  // Columns share the section as a DOM ancestor. Walk only the
  // descendants of the parent section so unrelated columns elsewhere
  // on the page don't pollute the list.
  const section = document.querySelector<HTMLElement>(
    `[data-edit-section-id="${parentSectionId}"]`,
  )
  const root: ParentNode = section ?? document
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>('[data-edit-column-id]'),
  )
    .map((el) => ({
      id: Number(el.dataset['editColumnId']),
      version: Number(el.dataset['editColumnVersion']),
      pageId: Number(el.dataset['editColumnPageId']),
      position: Number(el.offsetLeft) || 0,
    }))
    .filter((b) => b.pageId === pageId)
  // Columns are laid out left-to-right inside a grid; offsetLeft gives
  // the visual order independent of the queryAll return order.
  rows.sort((a, b) => a.position - b.position)
  return rows.map((r) => ({ id: r.id, version: r.version }))
}

export function EditableColumn(p: Props) {
  const router = useRouter()
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const contextMenu = useContextMenu()
  const dispatch = useInlineEditDispatch()
  const selection = useSelection()
  const [open, setOpen] = useState(false)
  // Chunk H: pre-routes the drawer to a specific tab when the context
  // menu's Set column width verb is invoked. Cleared on close so
  // pencil/click-to-edit entry points stay on the default tab.
  const [drawerInitialTab, setDrawerInitialTab] = useState<
    TabKey | undefined
  >(undefined)
  const [busyAction, setBusyAction] = useState<
    'delete' | 'left' | 'right' | null
  >(null)
  const [optimisticallyDeleted, setOptimisticallyDeleted] = useState(false)
  const [, startTransition] = useTransition()
  // Chunk B: pull the freshest (blockVersion, pageVersion) from
  // context so EditDrawer + data attrs stay in sync with sibling saves.
  const versions = useEffectiveVersions(p.blockId, {
    blockVersion: p.initialVersion,
    pageVersion: p.pageVersion,
  })

  // Chunk D: column is a sortable item under the per-section
  // SortableContext. containerId resolves to the parent section so
  // the drag-end handler routes column-to-column drops correctly.
  //
  // Memoise the `data` payload — same rationale as EditableBlock's
  // sortableData memo.
  const sortableData = useMemo(
    () => ({ containerId: p.parentSectionId, kind: 'column' as const }),
    [p.parentSectionId],
  )
  const sortable = useSortable({
    id: p.blockId,
    data: sortableData,
  })
  const dragStyle = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  }

  // Chunk E: wrapperRef → SpacingOverlay's measurement target. See
  // EditableSection for the ref-combo rationale.
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // F4 — dep is the stable `setNodeRef` (the only thing the callback
  // actually uses). The full `sortable` return object churns identity
  // every render; depending on it would re-fire React's ref attach/
  // detach cycle and momentarily un-bind DnD listeners mid-drag.
  const sortableSetNodeRef = sortable.setNodeRef
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node
      sortableSetNodeRef(node)
    },
    [sortableSetNodeRef],
  )

  const refresh = () => startTransition(() => router.refresh())

  const openDrawerWithTab = useCallback((tab?: TabKey) => {
    setDrawerInitialTab(tab)
    setOpen(true)
  }, [])

  // SSR-safe column bounds for Move Left/Right pre-disable. Reads
  // from InlineEditContext's live blocks (hydrated identically server +
  // client) instead of document.querySelectorAll which returned [] on
  // the server → hydration mismatch → React detached event handlers.
  const liveBlocks = useInlineEditState().blocks
  // Memoise — same rationale as EditableBlock's isFirst/isLast memo.
  const { isFirst, isLast } = useMemo(() => {
    const siblings = liveBlocks
      .filter((b) => b.parentId === p.parentSectionId && b.kind === 'column')
      .slice()
      .sort((a, b) => a.position - b.position)
    const idx = siblings.findIndex((b) => b.id === p.blockId)
    if (idx < 0 || siblings.length === 0) {
      return { isFirst: true, isLast: true }
    }
    return { isFirst: idx === 0, isLast: idx === siblings.length - 1 }
  }, [liveBlocks, p.blockId, p.parentSectionId])

  // Chunk H: invoked by the context menu's column "Add widget" verb.
  // Scopes the DOM query to THIS column's wrapper so a forged
  // data-add-widget-target attribute on a sibling/unrelated element
  // (future template gallery preview tile, third-party admin chrome)
  // can't be clicked by mistake. The wrapper's data-edit-column-id
  // attribute uniquely identifies this column's subtree; descending
  // from there guarantees the selector matches only the EmptyColumnSlot
  // button (empty case) OR the after-last-widget InsertBlockHere pill
  // (non-empty case), each carrying matching parentId.
  const openAddWidget = useCallback(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    wrapper.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const targets = wrapper.querySelectorAll<HTMLButtonElement>(
      `[data-add-widget-target="${p.blockId}"]`,
    )
    const last = targets[targets.length - 1]
    if (last) {
      // Defer one task so the smooth-scroll has at least one frame to
      // start — the click() that immediately follows the scrollIntoView
      // works in Chromium but Safari's smooth-scroll can mis-place
      // popover anchors when fired in the same task.
      setTimeout(() => last.click(), 0)
    }
  }, [p.blockId])

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      // Cede to OS menu inside InlineEditable richtext (spellcheck path).
      if (target.closest('[data-inline-editing="true"]')) return
      // If a descendant EditableBlock already handled this event (it
      // calls e.stopPropagation in its own onContextMenu), the column
      // handler won't fire at all — React event propagation. The check
      // below is defence-in-depth in case a future descendant emits
      // without stopPropagation.
      if (target.closest('[data-edit-block-id]')) return
      e.preventDefault()
      e.stopPropagation()
      contextMenu.showFor({
        kind: 'column',
        blockId: p.blockId,
        blockType: 'column',
        parentId: p.parentSectionId,
        pageId: p.pageId,
        blockVersion: versions.blockVersion,
        pageVersion: versions.pageVersion,
        data: {},
        meta: p.initialMeta,
        coords: { x: e.clientX, y: e.clientY },
        openEditDrawer: openDrawerWithTab,
        openAddWidget,
        triggerElement: e.currentTarget,
      })
    },
    [
      contextMenu,
      openAddWidget,
      openDrawerWithTab,
      p.blockId,
      p.initialMeta,
      p.pageId,
      p.parentSectionId,
      versions.blockVersion,
      versions.pageVersion,
    ],
  )

  // F13 — clicks on the column frame select this column. Inner blocks
  // call e.stopPropagation in their own onClick.
  const onWrapperClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-edit-toolbar]')) return
    if (target.closest('[data-inline-editing="true"]')) return
    selection.select(p.blockId)
    e.stopPropagation()
  }

  // F1 — column reorder via /reorder. Parent is this column's section.
  const moveColumnBy = async (dir: -1 | 1) => {
    if (busyAction) return
    const siblings = readColumnSiblings(p.pageId, p.parentSectionId)
    const idx = siblings.findIndex((b) => b.id === p.blockId)
    const targetIdx = idx + dir
    if (idx < 0 || targetIdx < 0 || targetIdx >= siblings.length) {
      toast.info(
        dir === -1 ? 'Already the leftmost column.' : 'Already the rightmost column.',
      )
      return
    }
    setBusyAction(dir === -1 ? 'left' : 'right')
    try {
      const reordered = [...siblings]
      const a = reordered[idx]!
      const b = reordered[targetIdx]!
      reordered[idx] = b
      reordered[targetIdx] = a
      const res = await csrfFetch('/api/cms/blocks/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: p.pageId,
          parentId: p.parentSectionId,
          blocks: reordered.map((s) => ({ id: s.id, version: s.version })),
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (res.status === 409) {
          toast.error(
            'Someone else changed this page. Refresh to see the latest order.',
          )
          return
        }
        toast.error(j.error ?? 'Reorder failed.')
        return
      }
      // F11 — reorder bumps pages.version too; advance both cursors so
      // a subsequent edit on a sibling doesn't 409 on stale_page_version.
      const body = (await res.json().catch(() => ({}))) as {
        blocks?: Array<{ id: number; version: number }>
        pageVersion?: number
      }
      const fresh = Array.isArray(body.blocks) ? body.blocks : []
      const nextPageVersion =
        typeof body.pageVersion === 'number'
          ? body.pageVersion
          : versions.pageVersion
      for (const row of fresh) {
        if (typeof row.id === 'number' && typeof row.version === 'number') {
          dispatch({
            type: 'set-versions',
            blockId: row.id,
            blockVersion: row.version,
            pageVersion: nextPageVersion,
          })
        }
      }
      refresh()
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusyAction(null)
    }
  }

  const deleteColumn = async () => {
    if (busyAction) return
    // F5 — descendant count from the DOM so the Undo toast carries
    // blast-radius signal.
    const wrapper = wrapperRef.current
    const descendantCount = wrapper
      ? wrapper.querySelectorAll('[data-edit-block-id]').length
      : 0
    setBusyAction('delete')
    setOptimisticallyDeleted(true)
    try {
      const res = await csrfFetch(`/api/cms/blocks/${p.blockId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? "We couldn't remove the column.")
        setOptimisticallyDeleted(false)
        return
      }
      const body = (await res.json().catch(() => ({}))) as {
        pageVersion?: number
        blocks?: Array<{ id: number; version: number; deletedAt?: string }>
      }
      if (Array.isArray(body.blocks)) {
        const pv =
          typeof body.pageVersion === 'number'
            ? body.pageVersion
            : versions.pageVersion
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
      // ── F6 / Chunk J — record DELETE-CONTAINER (column) with
      // restore-context. Restore POSTs the original slot back in.
      //
      // CRITICAL fix (correctness audit C1): /restore expects the
      // content_blocks.position COLUMN VALUE, not a sibling index. Read
      // the live column's canonical position from InlineEditContext.
      const liveColumn = liveBlocks.find((b) => b.id === p.blockId)
      const columnPosition = liveColumn?.position ?? 0
      const blockId = p.blockId
      recordCommand({
        kind: 'delete-container',
        label: 'Removed column',
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
            cascade: true,
            position: columnPosition,
            parentId: p.parentSectionId,
          },
          expects: 200,
        },
        captures: {
          blockId,
          containerKind: 'column',
          parentId: p.parentSectionId,
          position: columnPosition,
          priorMeta: p.initialMeta,
          pageId: p.pageId,
        },
      })
      const noun =
        descendantCount > 0
          ? `Column with ${descendantCount} ${
              descendantCount === 1 ? 'widget' : 'widgets'
            } removed.`
          : 'Column removed.'
      toast.success(noun, {
        label: 'Undo',
        onClick: () => void runUndo(),
      })
      refresh()
    } catch (e) {
      setOptimisticallyDeleted(false)
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusyAction(null)
    }
  }

  useEffect(() => {
    setOptimisticallyDeleted(false)
  }, [p.blockId])

  const isSelected = selection.isSelected(p.blockId)

  // Keyboard shortcuts. Columns get the same delete + move pair the
  // toolbar surfaces; duplicate is omitted because column duplication
  // is governed by the per-section column-count cap (1..4) and the
  // right-click menu's Duplicate already surfaces the cap-aware error.
  // F6 — Column delete cascades to every widget inside the column.
  // Require a modifier (Shift OR Cmd/Ctrl) on Backspace/Delete so a
  // stray plain Backspace can't nuke a populated column. The toolbar
  // Delete button stays modifier-free; this gate is keyboard-only.
  useKeyboardShortcuts(
    {
      onDelete: (e) => {
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) return
        void deleteColumn()
      },
      onMoveUp: isFirst ? undefined : () => void moveColumnBy(-1),
      onMoveDown: isLast ? undefined : () => void moveColumnBy(1),
    },
    isSelected,
  )

  return (
    <div
      ref={setRefs}
      data-edit-column-id={p.blockId}
      data-edit-column-version={versions.blockVersion}
      data-edit-column-page-id={p.pageId}
      data-edit-selected={isSelected ? 'true' : undefined}
      onContextMenu={onContextMenu}
      onClick={onWrapperClick}
      // Chunk H: tabIndex=-1 lets the context menu's focus-restore on
      // close land here rather than document.body. Not part of the
      // natural Tab order — operators tab through the column's widget
      // surfaces, not the column frame itself.
      tabIndex={-1}
      style={dragStyle}
      className={clsx(
        // Edit-mode-only spacing: modest padding so the column's
        // drag handle (-top-3 left-1/2) + toolbar (-top-3 right-3)
        // have breathing room without compressing the parent
        // section's grid gap. Live mode never mounts EditableColumn,
        // so anonymous visitors see columns flush.
        'group/column relative min-h-[64px] py-3 px-1',
        sortable.isDragging && 'opacity-50',
        optimisticallyDeleted && 'hidden',
      )}
    >
      <div
        className={clsx(
          'relative rounded-xl outline outline-2 outline-transparent transition-[outline-color,box-shadow] duration-quick ease-standard group-hover/column:outline-copper-300/50 focus-within:outline-copper-300 motion-reduce:transition-none',
          isSelected && '!outline-copper-300',
        )}
      >
        {p.hasWidgets ? (
          <ColumnWidgetsSortable items={p.widgetIds}>
            {p.children}
          </ColumnWidgetsSortable>
        ) : (
          <EmptyColumnDroppable columnId={p.blockId}>
            <EmptyColumnSlot
              pageId={p.pageId}
              columnId={p.blockId}
              sectionBackground={p.sectionBackground}
            />
          </EmptyColumnDroppable>
        )}
      </div>

      {/* Drag handle — top edge, horizontally centered. Drag listeners
          scoped here so clicks on column-toolbar buttons or widget
          content don't accidentally start a column drag. F10 — z-20
          (between widget z-10 and section z-30). */}
      <button
        ref={sortable.setActivatorNodeRef}
        type="button"
        aria-label="Drag column to reorder"
        {...sortable.attributes}
        {...sortable.listeners}
        // touch-action: none required on the dnd-kit PointerSensor activator
        // — see EditableBlock for the full rationale.
        style={{ touchAction: 'none' }}
        className="absolute -top-3 left-1/2 z-20 inline-flex h-7 w-11 -translate-x-1/2 cursor-grab touch-none items-center justify-center rounded-full bg-near-black/90 text-cream-50 opacity-0 shadow-[0_6px_14px_-6px_rgba(5,5,5,0.5)] transition-opacity duration-quick ease-standard hover:text-copper-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 active:cursor-grabbing group-hover/column:opacity-100 group-focus-within/column:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:opacity-100"
      >
        <GripVertical
          size={12}
          strokeWidth={2.2}
          className="rotate-90"
          aria-hidden="true"
        />
      </button>

      {/* Floating action toolbar — top-right of the column. F1 — Move
          Left/Right for keyboard + touch operators. F10 — z-20. F11 —
          stays open while selected. */}
      <div
        data-edit-toolbar
        className={clsx(
          'absolute -top-3 right-3 z-20 flex items-center gap-0.5 rounded-full bg-near-black/95 p-0.5 shadow-[0_10px_24px_-12px_rgba(5,5,5,0.45)] backdrop-blur-sm transition-all duration-quick ease-standard motion-reduce:transition-none',
          isSelected
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover/column:pointer-events-auto group-hover/column:opacity-100 group-focus-within/column:pointer-events-auto group-focus-within/column:opacity-100',
        )}
        aria-label="Column actions"
      >
        <ToolButton
          icon={Settings}
          label="Column settings"
          onClick={() => setOpen(true)}
        />
        <SpacingToolbar
          blockId={p.blockId}
          kind="column"
          initialMeta={p.initialMeta}
          initialVersion={versions.blockVersion}
          pageId={p.pageId}
          initialPageVersion={versions.pageVersion}
          targetRef={wrapperRef}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        <ToolButton
          icon={ArrowLeft}
          label={isFirst ? 'Already the leftmost column' : 'Move column left'}
          onClick={() => void moveColumnBy(-1)}
          busy={busyAction === 'left'}
          disabled={isFirst}
        />
        <ToolButton
          icon={ArrowRight}
          label={isLast ? 'Already the rightmost column' : 'Move column right'}
          onClick={() => void moveColumnBy(1)}
          busy={busyAction === 'right'}
          disabled={isLast}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        {/* F5 — no ConfirmModal; optimistic delete + toast Undo. */}
        <ToolButton
          icon={Trash2}
          label="Delete column"
          destructive
          onClick={() => void deleteColumn()}
          busy={busyAction === 'delete'}
        />
      </div>

      {open && (
        <EditDrawer
          // Key on blockId only — see EditableBlock for the rationale.
          key={`column:${p.blockId}`}
          blockId={p.blockId}
          blockType="column"
          initialData={(p.initialMeta as Record<string, unknown>) ?? {}}
          initialVersion={versions.blockVersion}
          pageId={p.pageId}
          initialPageVersion={versions.pageVersion}
          initialTab={drawerInitialTab}
          onClose={() => {
            setOpen(false)
            setDrawerInitialTab(undefined)
          }}
        />
      )}
    </div>
  )
}

// Empty-column drop-zone. The ENTIRE dashed surface is the trigger
// — clicking anywhere opens a picker inline (the prior design hid
// the picker pill behind opacity-0 inside an interactive zone, which
// invited the "why can't I click the empty column" complaint). The
// picker reuses the same shape + seed data as InsertBlockHere so add
// flows stay identical regardless of entry point.
function EmptyColumnSlot({
  pageId,
  columnId,
  sectionBackground,
}: {
  pageId: number
  columnId: number
  sectionBackground: SectionBackground
}) {
  const dark = sectionBackground === 'near-black'
  const [open, setOpen] = useState(false)
  return (
    <div
      className={clsx(
        'relative min-h-[140px] rounded-xl border-2 border-dashed transition-colors',
        dark
          ? 'border-cream-50/30 bg-cream-50/5 hover:border-copper-300 hover:bg-cream-50/10'
          : 'border-warm-stone/30 bg-cream/50 hover:border-copper-400 hover:bg-cream',
      )}
    >
      {open ? (
        <ColumnInlinePicker
          pageId={pageId}
          columnId={columnId}
          dark={dark}
          onClose={() => setOpen(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add widget to this column"
          aria-haspopup="menu"
          // Chunk H — stable selector for the context menu's column
          // "Add widget" verb. Mirrors the data-add-widget-target on
          // InsertBlockHere pills for non-empty columns so the handler
          // finds whichever entry point is currently mounted.
          data-add-widget-target={columnId}
          className="flex h-full w-full min-h-[140px] flex-col items-center justify-center gap-2 rounded-[10px] px-4 py-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <span
            aria-hidden="true"
            className={clsx(
              'inline-flex h-9 w-9 items-center justify-center rounded-full',
              dark
                ? 'bg-copper-500/25 text-copper-300'
                : 'bg-copper-500/15 text-copper-500',
            )}
          >
            <Plus size={15} strokeWidth={2.4} />
          </span>
          <p
            className={clsx(
              'text-[11px] font-semibold uppercase tracking-[0.18em]',
              dark ? 'text-cream-50/80' : 'text-warm-stone',
            )}
          >
            Empty column
          </p>
          <p
            className={clsx(
              'text-[10px]',
              // contrast bumped from /70 → full warm-stone so axe
              // color-contrast passes on cream surfaces (was 3.5:1)
              dark ? 'text-cream-50/80' : 'text-warm-stone',
            )}
          >
            Click to add a widget
          </p>
        </button>
      )}
    </div>
  )
}

// Inline picker that fills the empty-column surface when the operator
// clicks. Same shape as InsertBlockHere's popover but renders in-flow
// (not as a floating popover) because there's already nothing else in
// the column to compete for the space. Mirrors the same seed types +
// the image-via-MediaPicker flow so the operator's mental model is
// identical regardless of entry point (between-blocks pill vs.
// empty-column click).

// Seed list + payloads come from the shared registry — see
// `lib/cms/blockSeeds.ts`. Identical entry shape to InsertBlockHere
// + OutlinePanel.AddBlockMenu + EditModeEmptyState.

function ColumnInlinePicker({
  pageId,
  columnId,
  dark,
  onClose,
}: {
  pageId: number
  columnId: number
  dark: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const mediaPicker = useMediaPicker()
  const insertBlock = useInsertBlock()
  const [busy, setBusy] = useState<string | null>(null)
  // Synchronous in-flight guard against rapid double-clicks. See the
  // matching comment in InsertBlockHere.tsx for full rationale.
  const inFlightRef = useRef(false)

  // Chunk I — POST + refresh routed through useInsertBlock. The picker
  // owns: open/close, in-flight guard, busy-key disambiguation, toast
  // mapping. The hook owns: body shape, default seed lookup,
  // router.refresh.
  const add = async (
    blockType: SeedBlockType | 'image',
    data?: Record<string, unknown>,
    busyKey?: string,
  ) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(busyKey ?? blockType)
    try {
      const res = await insertBlock(blockType, {
        pageId,
        data,
        parentId: columnId,
      })
      if (!res.ok) {
        toast.error(mapInsertBlockError(res.error).copy)
        return
      }
    } finally {
      setBusy(null)
      inFlightRef.current = false
    }
  }

  const addImage = () => {
    if (busy) return
    mediaPicker.open(undefined, (m) => {
      void add('image', {
        image: { media_id: m.media_id, alt: m.alt ?? '' },
        caption: '',
        alignment: 'center',
      })
    })
  }

  return (
    <div
      role="menu"
      aria-label="Pick a widget to add to this column"
      className={clsx(
        'relative p-3 animate-bwc-fade-in',
        dark ? 'text-cream-50' : 'text-near-black',
      )}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <p
          className={clsx(
            'text-[9px] font-semibold uppercase tracking-[0.22em]',
            dark ? 'text-cream-50/70' : 'text-warm-stone',
          )}
        >
          Add to this column
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close picker"
          className={clsx(
            'inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors',
            dark
              ? 'text-cream-50/70 hover:bg-cream-50/10 hover:text-cream-50'
              : 'text-warm-stone hover:bg-warm-stone/10 hover:text-near-black',
          )}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>
      <ul className="space-y-1">
        {SEED_ENTRIES.filter(isPaletteVisible).map((entry) => {
          const Icon = entry.icon
          // `busy` keyed by entry.label so two entries (Counter +
          // Stats Row) sharing a blockType spin independently.
          // isPaletteVisible gates legacy widget types per the
          // luxury-redesign migration (see blockSeeds.ts).
          const isBusy = busy === entry.label
          return (
            <li key={entry.label}>
              <button
                type="button"
                role="menuitem"
                aria-busy={isBusy}
                disabled={busy !== null}
                onClick={() => void add(entry.type, entry.data, entry.label)}
                className={clsx(
                  'flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                  dark
                    ? 'hover:bg-cream-50/10 focus-visible:bg-cream-50/10'
                    : 'hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8',
                )}
              >
                <span
                  className={clsx(
                    'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1',
                    dark
                      ? 'bg-copper-500/25 text-copper-300 ring-copper-400/40'
                      : 'bg-copper-500/15 text-copper-500 ring-copper-400/30',
                  )}
                >
                  {isBusy ? (
                    <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
                  ) : (
                    <Icon size={12} strokeWidth={2.4} />
                  )}
                </span>
                <span className="flex flex-col">
                  <span
                    className={clsx(
                      'text-sm font-semibold',
                      dark ? 'text-cream-50' : 'text-near-black',
                    )}
                  >
                    {entry.label}
                  </span>
                  <span
                    className={clsx(
                      'text-[11px]',
                      dark ? 'text-cream-50/60' : 'text-warm-stone',
                    )}
                  >
                    {entry.description}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
        <li>
          <button
            type="button"
            role="menuitem"
            aria-busy={busy === 'image'}
            disabled={busy !== null}
            onClick={addImage}
            className={clsx(
              'flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
              dark
                ? 'hover:bg-cream-50/10 focus-visible:bg-cream-50/10'
                : 'hover:bg-warm-stone/8 focus-visible:bg-warm-stone/8',
            )}
          >
            <span
              className={clsx(
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1',
                dark
                  ? 'bg-copper-500/25 text-copper-300 ring-copper-400/40'
                  : 'bg-copper-500/15 text-copper-500 ring-copper-400/30',
              )}
            >
              {busy === 'image' ? (
                <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
              ) : (
                <ImageIcon size={12} strokeWidth={2.4} />
              )}
            </span>
            <span className="flex flex-col">
              <span
                className={clsx(
                  'text-sm font-semibold',
                  dark ? 'text-cream-50' : 'text-near-black',
                )}
              >
                Picture
              </span>
              <span
                className={clsx(
                  'text-[11px]',
                  dark ? 'text-cream-50/60' : 'text-warm-stone',
                )}
              >
                Pick from the media library or upload a new one.
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>
  )
}
