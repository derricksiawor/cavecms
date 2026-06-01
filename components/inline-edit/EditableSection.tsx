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
  PlusSquare,
  Trash2,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import clsx from 'clsx'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { csrfFetch } from '@/lib/client/csrf'
import { MAX_SECTION_COLUMNS } from '@/lib/cms/blockMeta'
import { EditDrawer, type TabKey } from './EditDrawer'
import { SectionColumnsSortable } from './SortableContainers'
import { SpacingToolbar } from './SpacingToolbar'
import { useToast } from './Toast'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import {
  useEffectiveVersions,
  useInlineEditDispatch,
  useInlineEditState,
} from './InlineEditContext'
import { useContextMenu } from './ContextMenuProvider'
import { useSelection } from './SelectionContext'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'

// Section-level edit chrome (migration 0011 / Chunk C). Wraps a
// rendered <section> with a hover toolbar that surfaces the section's
// container-only actions:
//   - Settings: opens EditDrawer keyed on blockType='section', which
//     PATCHes meta (background, padding) instead of data.
//   - Add column: POSTs kind='column' parentId=this.id; the new column
//     lands at the tail of the section's existing columns.
//   - Move up/down: F1 — keyboard- + touch-reachable reorder so
//     operators without DnD can re-arrange sections.
//   - Delete: optimistic soft-delete with toast Undo (F5 — no
//     ConfirmModal; the 30-day trash window + the Undo button cover
//     the recovery surface).
//
// Click-to-edit is INTENTIONALLY NOT wired to the section body — the
// body is full of widgets the operator wants to click on directly.
// Settings is the only entry point for section-level meta editing.

interface Props {
  blockId: number
  initialMeta: unknown
  initialVersion: number
  pageId: number
  pageVersion: number
  // Toolbar disables Add column when the section is already at the
  // structural cap — the spec locks columns at 4 max so meta.columns
  // mismatch with the actual row count stays bounded.
  columnCount: number
  // Per-section column ids, in render order. Passed by BlockTreeRenderer
  // so this component can mount the per-section SortableContext for
  // its column children without re-deriving the list.
  columnIds: number[]
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
        <Loader2 size={17} strokeWidth={2.4} className="animate-spin" />
      ) : (
        <Icon size={17} strokeWidth={2.2} />
      )}
    </button>
  )
}

// Read the section's living top-level siblings from the DOM. At
// parent_id IS NULL the bucket includes BOTH sections and loose
// top-level widgets — same shape as EditableBlock's readSiblings.
// Merge by DOM offsetTop so the resulting array reflects visual order.
function readTopLevelSiblings(
  pageId: number,
): Array<{ id: number; version: number }> {
  if (typeof document === 'undefined') return []
  const sectionRows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-edit-section-id]'),
  )
    .map((el) => ({
      id: Number(el.dataset['editSectionId']),
      version: Number(el.dataset['editSectionVersion']),
      pageId: Number(el.dataset['editSectionPageId']),
      position: Number(el.offsetTop) || 0,
    }))
    .filter((b) => b.pageId === pageId)
  const widgetRows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-edit-block-id]'),
  )
    .map((el) => ({
      id: Number(el.dataset['editBlockId']),
      version: Number(el.dataset['editBlockVersion']),
      pageId: Number(el.dataset['editPageId']),
      parent: el.dataset['editParentId'] ?? '',
      position: Number(el.offsetTop) || 0,
    }))
    .filter((b) => b.pageId === pageId && b.parent === '')
  const all = [...sectionRows, ...widgetRows]
  all.sort((a, b) => a.position - b.position)
  return all.map((r) => ({ id: r.id, version: r.version }))
}

export function EditableSection(p: Props) {
  const router = useRouter()
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const contextMenu = useContextMenu()
  const dispatch = useInlineEditDispatch()
  const selection = useSelection()
  const [open, setOpen] = useState(false)
  // Chunk H: when the context menu's Spacing verb requests the drawer
  // on the Style tab, this state routes the request through to
  // EditDrawer's initialTab prop. Cleared on drawer close so the next
  // click-to-edit / pencil entry lands on the default Content tab.
  const [drawerInitialTab, setDrawerInitialTab] = useState<
    TabKey | undefined
  >(undefined)
  const [busyAction, setBusyAction] = useState<
    'addColumn' | 'delete' | 'up' | 'down' | null
  >(null)
  // F14 — optimistic delete state. Keeps the wrapper mounted so
  // sibling DOM reads stay coherent until refresh lands.
  const [optimisticallyDeleted, setOptimisticallyDeleted] = useState(false)
  const [, startTransition] = useTransition()
  // Chunk B: resolve the freshest (blockVersion, pageVersion) cursor
  // from InlineEditContext so sibling saves on this section land
  // immediately in the EditDrawer's optimistic-lock body. Falls back
  // to the props for the first render before any override has set.
  const versions = useEffectiveVersions(p.blockId, {
    blockVersion: p.initialVersion,
    pageVersion: p.pageVersion,
  })

  // Chunk D: register this section as a sortable item under the
  // top-level SortableContext (siblings: other sections + loose
  // widgets). `data.containerId = null` so the drag-end handler
  // resolves drops correctly when this section is the over target.
  //
  // Memoise the `data` payload (stable for the lifetime of the
  // section — containerId is always null + kind always 'section').
  const sortableData = useMemo(
    () => ({ containerId: null, kind: 'section' as const }),
    [],
  )
  const sortable = useSortable({
    id: p.blockId,
    data: sortableData,
  })
  const dragStyle = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  }

  // Chunk E: wrapperRef → SpacingOverlay's measurement target. Combined
  // with sortable.setNodeRef via a callback ref so DnD + overlay both
  // observe the same outer element. setNodeRef's identity is stable
  // across renders per @dnd-kit's contract.
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // F4 — dep is the stable `setNodeRef` (the only thing the callback
  // actually uses) so this ref function keeps identity across renders.
  // Depending on the full `sortable` object churns the callback every
  // render (useSortable returns a fresh object each call), which
  // re-fires React's ref-attach/detach cycle on every parent render —
  // visible as DnD listeners momentarily un-binding mid-drag.
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

  // SSR-safe section bounds for Up/Down pre-disable. Reads from
  // InlineEditContext's live blocks (hydrated identically on server +
  // client) instead of document.querySelectorAll which returned [] on
  // the server → hydration mismatch on the button's disabled/label
  // attributes → React detached event handlers in the subtree →
  // breaks save + reorder clicks. The top-level bucket includes
  // sibling sections AND loose widgets (both reorder through the
  // same /reorder endpoint).
  const liveBlocks = useInlineEditState().blocks
  // Memoise — same rationale as EditableBlock's isFirst/isLast memo.
  const { isFirst, isLast } = useMemo(() => {
    const siblings = liveBlocks
      .filter((b) => b.parentId === null)
      .slice()
      .sort((a, b) => a.position - b.position)
    const idx = siblings.findIndex((b) => b.id === p.blockId)
    if (idx < 0 || siblings.length === 0) {
      return { isFirst: true, isLast: true }
    }
    return { isFirst: idx === 0, isLast: idx === siblings.length - 1 }
  }, [liveBlocks, p.blockId])

  // Chunk H: right-click → context menu. Cede to the OS native menu
  // when the click target is inside an InlineEditable richtext
  // (operator wants spellcheck / Look Up on selected text). stopPropagation
  // prevents a nested Editable wrapper from also dispatching — sections
  // are top-level so this is defence-in-depth.
  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-inline-editing="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      contextMenu.showFor({
        kind: 'section',
        blockId: p.blockId,
        blockType: 'section',
        parentId: null,
        pageId: p.pageId,
        blockVersion: versions.blockVersion,
        pageVersion: versions.pageVersion,
        data: {},
        meta: p.initialMeta,
        columnCount: p.columnCount,
        coords: { x: e.clientX, y: e.clientY },
        openEditDrawer: openDrawerWithTab,
        triggerElement: e.currentTarget,
      })
    },
    [
      contextMenu,
      openDrawerWithTab,
      p.blockId,
      p.columnCount,
      p.initialMeta,
      p.pageId,
      versions.blockVersion,
      versions.pageVersion,
    ],
  )

  const atColumnCap = p.columnCount >= MAX_SECTION_COLUMNS

  // F13 — clicks on the section frame (not its children) select this
  // section. Inner blocks call e.stopPropagation in their own onClick,
  // so a click that reaches the wrapper is by definition on the
  // section frame itself.
  const onWrapperClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-edit-toolbar]')) return
    if (target.closest('[data-inline-editing="true"]')) return
    selection.select(p.blockId)
    e.stopPropagation()
  }

  const addColumn = async () => {
    // Disabled-button guard would normally swallow this click, but
    // the keyboard `Enter`-on-disabled-button path varies by browser.
    // Keep the runtime check + a toast so the operator gets feedback.
    if (busyAction || atColumnCap) return
    setBusyAction('addColumn')
    try {
      const res = await csrfFetch('/api/cms/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId: p.pageId,
          kind: 'column',
          parentId: p.blockId,
          meta: {},
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (j.error === 'column_count_exceeded') {
          toast.error(
            `This section is at the ${MAX_SECTION_COLUMNS}-column maximum.`,
          )
        } else {
          toast.error(j.error ?? "We couldn't add the column.")
        }
        return
      }
      toast.success('Column added.')
      refresh()
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusyAction(null)
    }
  }

  // F1 — Move section up/down. Uses the same /reorder endpoint as
  // widget reorder; the parent at top-level is null. F3 — applies
  // the response versions to the optimistic-lock cursor.
  const moveSectionBy = async (dir: -1 | 1) => {
    if (busyAction) return
    const siblings = readTopLevelSiblings(p.pageId)
    const idx = siblings.findIndex((b) => b.id === p.blockId)
    const targetIdx = idx + dir
    if (idx < 0 || targetIdx < 0 || targetIdx >= siblings.length) {
      toast.info(dir === -1 ? 'Already at the top.' : 'Already at the bottom.')
      return
    }
    setBusyAction(dir === -1 ? 'up' : 'down')
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
          parentId: null,
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
      // F11 — reorder bumps pages.version too; thread it through so a
      // subsequent edit doesn't 409 against a stale page cursor.
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

  const deleteSection = async () => {
    if (busyAction) return
    // F5 — descendant count for the Undo toast copy. Computed at click
    // time so the operator sees the blast-radius signal ("Section with
    // 7 items removed. Undo?") rather than a generic "Section removed."
    const wrapper = wrapperRef.current
    const descendantCount = wrapper
      ? wrapper.querySelectorAll('[data-edit-block-id]').length +
        wrapper.querySelectorAll('[data-edit-column-id]').length
      : 0
    setBusyAction('delete')
    setOptimisticallyDeleted(true)
    try {
      const res = await csrfFetch(`/api/cms/blocks/${p.blockId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? "We couldn't remove the section.")
        setOptimisticallyDeleted(false)
        return
      }
      // F3 — apply the new DELETE response shape (pageVersion + blocks[]).
      // Tolerates the legacy 204 (empty body) — the post-refresh
      // snapshot brings everything into alignment either way.
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
      // ── Record DELETE-CONTAINER with restore-context.
      // Sections live at parent_id=null; capture the slot so the
      // /restore POST lands the section back in its original position
      // (per the negotiated /restore contract).
      //
      // CRITICAL fix (correctness audit C1): /restore expects the
      // content_blocks.position COLUMN VALUE, not a sibling index. Read
      // the live section's canonical position from InlineEditContext.
      const liveSection = liveBlocks.find((b) => b.id === p.blockId)
      const sectionPosition = liveSection?.position ?? 0
      const blockId = p.blockId
      recordCommand({
        kind: 'delete-container',
        label: 'Removed section',
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
            position: sectionPosition,
            parentId: null,
          },
          expects: 200,
        },
        captures: {
          blockId,
          containerKind: 'section',
          parentId: null,
          position: sectionPosition,
          priorMeta: p.initialMeta,
          pageId: p.pageId,
        },
      })
      // F5 — descendant count surfaces blast-radius in the Undo toast.
      // The toast layer auto-extends action-bearing toasts to 8s and
      // pauses on hover; that combination gives the operator enough
      // time to read AND click Undo without a separate ConfirmModal
      // blocking the gesture upfront.
      const noun =
        descendantCount > 0
          ? `Section with ${descendantCount} ${
              descendantCount === 1 ? 'item' : 'items'
            } removed.`
          : 'Section removed.'
      // 12s TTL — section deletes cascade entire column/widget subtrees
        // and are the highest-blast-radius verb in the editor. The extended
        // window gives operators time to reconsider before the cascade
        // becomes invisible in the toast layer.
      toast.success(
        noun,
        {
          label: 'Undo',
          onClick: () => void runUndo(),
        },
        12_000,
      )
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

  // Reset optimistic-deleted on remount (covers ⌘Z undo bringing the
  // section back into the server-rendered tree).
  useEffect(() => {
    setOptimisticallyDeleted(false)
  }, [p.blockId])

  // Hydration guard. EditableBlockTreeRenderer is a dynamic import, so by the
  // time this subtree hydrates, the SelectionProvider's post-mount effect has
  // already restored the persisted selection. Reading it on the FIRST client
  // render would then disagree with the server HTML (nothing selected) →
  // hydration mismatch on data-edit-selected + the outline/toolbar/badge
  // classes. Gate the selected visuals on THIS section's own mount so the
  // first client render always matches SSR; the real selection applies a tick
  // later (imperceptible).
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  const isSelected = mounted && selection.isSelected(p.blockId)

  // Keyboard shortcuts. Sections are high-blast-radius — ⌘D / ⌫ /
  // ⌥↑↓ map to the same handlers the toolbar buttons use; the toast-
  // with-Undo affordance is the safety net (no separate confirm
  // modal — see F5 in the deletion design). Duplicate via keyboard
  // isn't wired today (the right-click menu's Duplicate has the
  // matching recordCommand machinery; promoting it to a shortcut
  // would require the same handler-extraction the widget path did,
  // and section duplicates are operator-deliberate enough that
  // discoverability via the menu is sufficient).
  // F6 — Section delete is the highest-blast-radius keyboard verb in
  // the editor (cascades to every column + widget). Require a modifier
  // (Shift OR Cmd/Ctrl) on Backspace/Delete so a stray plain Backspace
  // — common when an operator thinks they're in a text field that just
  // blurred — can't nuke an entire section. The toolbar Delete button
  // is always available without a modifier; this gate is keyboard-only.
  useKeyboardShortcuts(
    {
      onDelete: (e) => {
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) return
        void deleteSection()
      },
      onMoveUp: isFirst ? undefined : () => void moveSectionBy(-1),
      onMoveDown: isLast ? undefined : () => void moveSectionBy(1),
    },
    isSelected,
  )

  return (
    <div
      ref={setRefs}
      data-edit-section-id={p.blockId}
      data-edit-section-version={versions.blockVersion}
      data-edit-section-page-id={p.pageId}
      data-edit-selected={isSelected ? 'true' : undefined}
      onContextMenu={onContextMenu}
      onClick={onWrapperClick}
      // Chunk H: tabIndex=-1 lets the context menu's focus-restore on
      // close land on the wrapper rather than document.body. Not part
      // of natural Tab order (a keyboard operator tabs through the
      // inline-editable surfaces inside, not the section frame).
      tabIndex={-1}
      style={dragStyle}
      className={clsx(
        // Edit-mode-only spacing: outer vertical+horizontal margin
        // inset the section from the page edge so the chrome (top
        // pill at -top-4, drag handle at -left-3 with w-7 inline-flex,
        // toolbar at -top-4 right-6) has visible negative space to
        // live in — Elementor-style. The handle needs ~32px of
        // viewport gutter to render fully without browser-clip;
        // mx-6 sm:mx-10 gives 24/40px and keeps the section visually
        // inset like a Wix / Elementor editing canvas. Live mode
        // never mounts EditableSection, so anonymous visitors see
        // the section flush to its natural rhythm with no inset.
        'group/section relative my-8 sm:my-10 mx-6 sm:mx-10',
        sortable.isDragging && 'opacity-50',
        optimisticallyDeleted && 'hidden',
      )}
    >
      {/* Subtle copper outline + glow on hover — signals "this is a
          structural container you can act on". Section background +
          padding are emitted by the wrapped <section> from the
          renderer, so we keep this wrapper transparent. Children are
          wrapped in the per-section columns SortableContext so
          DnD-reordering of columns within this section works.

          F13 — persistent ring while selected. */}
      <div
        className={clsx(
          'relative rounded-2xl outline outline-2 outline-transparent transition-[outline-color,box-shadow] duration-quick ease-standard group-hover/section:outline-copper-300/70 group-hover/section:shadow-[0_24px_60px_-32px_rgba(160,90,40,0.35)] focus-within:outline-copper-300 motion-reduce:transition-none',
          isSelected &&
            '!outline-copper-300 shadow-[0_24px_60px_-32px_rgba(160,90,40,0.35)]',
        )}
      >
        <SectionColumnsSortable items={p.columnIds}>
          {p.children}
        </SectionColumnsSortable>
      </div>

      {/* Drag handle — top edge, horizontally centered. Matches the
          column + widget drag handle placement so all three container
          levels share the same affordance pattern. */}
      <button
        ref={sortable.setActivatorNodeRef}
        type="button"
        aria-label="Drag section to reorder"
        {...sortable.attributes}
        {...sortable.listeners}
        // F10 — drag-handle stays at z-30 alongside the section toolbar
        // so it can never be covered by a child column/widget chrome.
        // touch-action: none required on the dnd-kit PointerSensor activator
        // — see EditableBlock for the full rationale.
        style={{ touchAction: 'none' }}
        className="absolute -top-3 left-1/2 z-30 inline-flex h-7 w-11 -translate-x-1/2 cursor-grab touch-none items-center justify-center rounded-full bg-near-black/90 text-cream-50 opacity-0 shadow-[0_8px_18px_-8px_rgba(5,5,5,0.5)] transition-opacity duration-quick ease-standard hover:text-copper-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 active:cursor-grabbing group-hover/section:opacity-100 group-focus-within/section:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:opacity-100"
      >
        <GripVertical
          size={12}
          strokeWidth={2.2}
          className="rotate-90"
          aria-hidden="true"
        />
      </button>

      {/* Floating action toolbar — top-right. F1 — Move Up/Down for
          keyboard + touch operators. F10 — z-30 (section > column z-20
          > widget z-10). F11 — visible when selected even without
          hover, so touch operators can hit a button after the first
          tap. */}
      <div
        data-edit-toolbar
        className={clsx(
          'absolute -top-4 right-6 z-30 flex items-center gap-0.5 rounded-full bg-near-black/95 p-1 shadow-[0_14px_32px_-12px_rgba(5,5,5,0.45)] backdrop-blur-sm transition-all duration-quick ease-standard motion-reduce:transition-none',
          isSelected
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover/section:pointer-events-auto group-hover/section:opacity-100 group-focus-within/section:pointer-events-auto group-focus-within/section:opacity-100',
        )}
        aria-label="Section actions"
      >
        <ToolButton
          icon={Settings}
          label="Section settings"
          onClick={() => setOpen(true)}
        />
        <SpacingToolbar
          blockId={p.blockId}
          kind="section"
          initialMeta={p.initialMeta}
          initialVersion={versions.blockVersion}
          pageId={p.pageId}
          initialPageVersion={versions.pageVersion}
          targetRef={wrapperRef}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        <ToolButton
          icon={ArrowUp}
          label={isFirst ? 'Already at the top' : 'Move section up'}
          onClick={() => void moveSectionBy(-1)}
          busy={busyAction === 'up'}
          disabled={isFirst}
        />
        <ToolButton
          icon={ArrowDown}
          label={isLast ? 'Already at the bottom' : 'Move section down'}
          onClick={() => void moveSectionBy(1)}
          busy={busyAction === 'down'}
          disabled={isLast}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        <ToolButton
          icon={PlusSquare}
          label={
            atColumnCap
              ? `Section is at the ${MAX_SECTION_COLUMNS}-column maximum`
              : 'Add column'
          }
          onClick={() => void addColumn()}
          busy={busyAction === 'addColumn'}
          disabled={atColumnCap}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        {/* F5 — no ConfirmModal. Delete is optimistic with a toast
            Undo button. 30-day trash on the server backs the recovery
            surface. */}
        <ToolButton
          icon={Trash2}
          label="Delete section"
          destructive
          onClick={() => void deleteSection()}
          busy={busyAction === 'delete'}
        />
      </div>

      {/* Block-type pill — top-left while hovered. */}
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none absolute -top-4 left-6 z-30 rounded-full bg-copper-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cream-50 shadow-sm transition-opacity duration-quick ease-standard motion-reduce:transition-none',
          isSelected
            ? 'opacity-100'
            : 'opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100',
        )}
      >
        Section · {p.columnCount} col
      </span>

      {open && (
        <EditDrawer
          // Key on blockId only — see EditableBlock for the rationale.
          key={`section:${p.blockId}`}
          blockId={p.blockId}
          blockType="section"
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
