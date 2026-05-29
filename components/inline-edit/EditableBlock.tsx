'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type KeyboardEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import {
  Pencil,
  ArrowUp,
  ArrowDown,
  Copy,
  Trash2,
  GripVertical,
  Lock,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { csrfFetch } from '@/lib/client/csrf'
import { ConfirmModal } from './ConfirmModal'
import { EditDrawer, type TabKey } from './EditDrawer'
import { SpacingToolbar } from './SpacingToolbar'
import { useToast } from './Toast'
import {
  useEffectiveVersions,
  useInlineEditDispatch,
} from './InlineEditContext'
import { useSparkleSessionFor } from './AiSparkleSessionContext'
import { AISparkleButton } from './AISparkleButton'
import {
  AISparklePreviewOverlay,
  SPARKLE_ACTIVE_OUTLINE,
} from './AISparklePreviewOverlay'
import { useContextMenu } from './ContextMenuProvider'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import { useSelection } from './SelectionContext'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { useClipboard, useInlineEditState } from './InlineEditContext'
import { CLIPBOARD_SCHEMA_VERSION } from '@/lib/cms/clipboard'

// Wix-style in-place block editor wrapper. Public-page block render
// is wrapped in this component when the operator has edit mode on.
// Three layers of affordance:
//   1. Subtle copper-300 ring on hover (visual "you can interact here")
//   2. Floating action toolbar pinned top-right: Edit / Up / Down /
//      Duplicate / Delete — each action talks to /api/cms/blocks
//   3. Click anywhere on the block body opens the EditDrawer with the
//      block-type's Zod-validated form
//
// All buttons stay keyboard-accessible (the toolbar is focus-visible
// even without hover). Click-to-edit is gated on `e.target` not being
// inside the toolbar so a "Delete" click doesn't double-fire as Edit.

export interface EditableBlockProps {
  blockId: number
  blockType: string
  // Fixed-slot key. When non-null, the row is page-template-locked and
  // DELETE refuses (server returns 409 cannot_delete_fixed_block). The
  // toolbar pre-disables the trash button + shows a lock affordance so
  // the operator never lands a click that confirms a delete that will
  // bounce.
  blockKey: string | null
  initialData: unknown
  initialVersion: number
  // PR-3 (spec §3.5 + §7): saveBlock requires the page-side
  // optimistic-lock token AND pageId for the pages-before-content_blocks
  // lock-order TX. Both are mandatory — a missing prop would surface as
  // a TypeScript error at the call site, which is the contract.
  pageId: number
  pageVersion: number
  // Migration 0011 / Chunk B: parent_id of THIS widget. NULL for loose
  // top-level widgets (legacy + back-compat). A column.id when this
  // widget lives inside a section→column. The move-up/down toolbar
  // gesture uses it to (a) filter DOM siblings to those sharing this
  // parent and (b) pass `parentId` to /api/cms/blocks/reorder so the
  // server's drift check compares against the right LIVING set.
  parentBlockId: number | null
  // Chunk E: persisted widget meta (spacing-only). Passed through to
  // the SpacingToolbar so its stepper steppers initialize against the
  // current values + the auto-save PATCH can build the next-meta blob
  // by spreading on top. Pre-Chunk-E widget rows have meta=null which
  // parseWidgetMeta tolerates as the empty spacing meta.
  initialMeta: unknown
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
      aria-busy={busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={clsx(
        // Touch target ≥ 44px per project standards mobile rules — matches
        // the section/column toolbar buttons rather than the prior
        // 32px size that violated the rule.
        // Hover/focus fills champagne (luxury primary highlight) with
        // obsidian text — readable on the obsidian-fill toolbar
        // background AND consistent with the rest of the luxury chrome.
        'inline-flex h-11 w-11 items-center justify-center rounded-full text-cream-50 transition-all hover:scale-105 focus-visible:scale-105 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100',
        destructive
          ? 'hover:bg-red-500 hover:text-cream-50 focus-visible:bg-red-500 focus-visible:text-cream-50'
          : 'hover:bg-champagne hover:text-obsidian focus-visible:bg-champagne focus-visible:text-obsidian',
      )}
    >
      {busy ? (
        <Loader2 size={16} strokeWidth={2.4} className="animate-spin" />
      ) : (
        <Icon size={16} strokeWidth={2.2} />
      )}
    </button>
  )
}

// Read the widget's living siblings from the DOM, scoped to the same
// parent_id. At parent_id IS NULL (loose top-level widget) the server's
// drift check expects every living child of the parent — which includes
// the sibling sections that also occupy the NULL bucket. So we walk
// BOTH `[data-edit-block-id]` AND `[data-edit-section-id]` and merge
// by DOM offsetTop. Mirror of lib/cms/contextMenuActions.ts:readWidgetSiblings —
// the right-click menu uses the same shape; the toolbar must match it
// or top-level moves drift 409.
function readSiblings(
  pageId: number,
  parentBlockId: number | null,
): Array<{ id: number; version: number }> {
  if (typeof document === 'undefined') return []
  const myParent = parentBlockId === null ? '' : String(parentBlockId)
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
    .filter((b) => b.pageId === pageId && b.parent === myParent)
  let allRows = widgetRows
  if (parentBlockId === null) {
    const sectionRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-edit-section-id]'),
    )
      .map((el) => ({
        id: Number(el.dataset['editSectionId']),
        version: Number(el.dataset['editSectionVersion']),
        pageId: Number(el.dataset['editSectionPageId']),
        // Sections always sit at parent_id=null.
        parent: '',
        position: Number(el.offsetTop) || 0,
      }))
      .filter((b) => b.pageId === pageId)
    allRows = [...widgetRows, ...sectionRows]
  }
  allRows.sort((a, b) => a.position - b.position)
  return allRows.map((r) => ({ id: r.id, version: r.version }))
}

// Highlight ring duration for the post-duplicate ping. Matches the
// OutlinePanel `cavecms-outline-ping` animation (1.6s) so the visual
// language is identical regardless of which surface introduced the
// new block.
const DUPLICATE_HIGHLIGHT_MS = 1600

export function EditableBlock(p: EditableBlockProps) {
  const router = useRouter()
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const contextMenu = useContextMenu()
  const dispatch = useInlineEditDispatch()
  const selection = useSelection()
  const [open, setOpen] = useState(false)
  // Chunk H: drawer-initial-tab override for context-menu-driven opens.
  // Always undefined for widget kinds today (the widget's "Spacing"
  // verb routes to the SpacingToolbar instead, not the drawer), but
  // present + plumbed through so a future widget menu item can route
  // to a specific tab without revisiting this component.
  const [drawerInitialTab, setDrawerInitialTab] = useState<
    TabKey | undefined
  >(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busyAction, setBusyAction] = useState<
    'up' | 'down' | 'duplicate' | 'delete' | null
  >(null)
  // F14 — optimistic delete. While true, the wrapper hides itself
  // (display:none on the inner shell so layout collapses); on
  // server-side rejection we flip back and surface a toast. The
  // wrapper itself stays mounted so DOM data attributes (siblings'
  // moveBy reads from these) survive the optimistic pass.
  const [optimisticallyDeleted, setOptimisticallyDeleted] = useState(false)
  const [, startTransition] = useTransition()
  // Chunk B: lift (blockVersion, pageVersion) reads to context so
  // sibling InlineEditable saves on the same block propagate to the
  // EditDrawer's optimistic-lock cursor without a router.refresh.
  const versions = useEffectiveVersions(p.blockId, {
    blockVersion: p.initialVersion,
    pageVersion: p.pageVersion,
  })

  // F4 — pre-disable destructive actions for fixed-slot rows. blockKey
  // is non-null exactly when the page template guarantees this slot —
  // DELETE would return 409 cannot_delete_fixed_block. The lock UI is
  // tighter than a 409 toast after confirm.
  const isFixedSlot = p.blockKey !== null

  // Chunk D: widget is a sortable item under either a column's
  // widgets SortableContext (when nested inside a column) or the
  // top-level SortableContext (loose widget). `containerId` resolves
  // to the parent column id (or null for top-level) so the
  // drag-end handler routes drops correctly.
  //
  // Memoise the `data` payload — dnd-kit identity-diffs it and a fresh
  // object literal per render forces internal re-sync on every parent
  // re-render (cascading from any InlineEditContext dispatch).
  const sortableData = useMemo(
    () => ({ containerId: p.parentBlockId, kind: 'widget' as const }),
    [p.parentBlockId],
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
  // F4 — dep is the stable `setNodeRef`. The full `sortable` object
  // returned by useSortable churns identity each render; depending on
  // it triggers React's ref attach/detach cycle every parent render
  // and momentarily un-binds DnD listeners — visible as mis-fired
  // drags after rapid state updates.
  const sortableSetNodeRef = sortable.setNodeRef
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node
      sortableSetNodeRef(node)
    },
    [sortableSetNodeRef],
  )

  const refresh = () => startTransition(() => router.refresh())

  const friendlyType = p.blockType.replace(/_/g, ' ')

  // F8 / F10 — live blocks from the optimistic InlineEditContext. The
  // ref-mirror is kept fresh via a layout effect so callbacks reading
  // it see the latest state without depending on the array identity
  // (which churns on every reducer dispatch — would otherwise re-make
  // moveBy + copyToClipboard on every keystroke).
  const liveBlocks = useInlineEditState().blocks
  const liveBlocksRef = useRef(liveBlocks)
  useEffect(() => {
    liveBlocksRef.current = liveBlocks
  }, [liveBlocks])

  // F9 — compute first/last position. Top-level rows (parent_id IS
  // NULL) read from the optimistic state so in-flight sibling section
  // creates are reflected in the Up/Down enable state immediately —
  // same source moveBy uses (F10). Nested rows still go through the
  // SSR-safe sibling read from InlineEditContext's live blocks. The
  // original implementation read from `document.querySelectorAll(...)`
  // which returns [] during server render → both isFirst+isLast were
  // forced true → buttons rendered "Already at the top/bottom" labels
  // on the server. Client mount with a populated DOM flipped them to
  // "Move up/down" → React hydration mismatch → React detaches the
  // subtree's event handlers, breaking save+toolbar clicks.
  //
  // The live blocks array is hydrated from server props before any
  // client effect, so it's available identically on server and client.
  // For top-level (parent_id IS NULL) include sibling sections.
  // Memoise isFirst/isLast — pre-memo this IIFE ran on every render of
  // every widget on every InlineEditContext dispatch (set-preview per
  // keystroke, set-versions per save). Each pass walked liveBlocks (the
  // whole page) → O(N) per widget × N widgets = O(N²) per editor render.
  // At N=100 widgets that's 10K iterations per keystroke. Memoising on
  // liveBlocks identity + the two stable id deps keeps the hot path
  // allocation-free unless the block tree actually changed.
  const { isFirst, isLast } = useMemo(() => {
    const siblings = liveBlocks
      .filter((b) =>
        p.parentBlockId === null
          ? b.parentId === null
          : b.parentId === p.parentBlockId,
      )
      .slice()
      .sort((a, b) => a.position - b.position)
    const idx = siblings.findIndex((b) => b.id === p.blockId)
    if (idx < 0 || siblings.length === 0) {
      return { isFirst: true, isLast: true }
    }
    return { isFirst: idx === 0, isLast: idx === siblings.length - 1 }
  }, [liveBlocks, p.blockId, p.parentBlockId])

  // F2 — siblings include sibling sections at top-level. F3 — DELETE +
  // reorder responses now carry per-row versions; apply them to the
  // optimistic-lock state instead of calling router.refresh and
  // discarding the body.
  //
  // F10 — for top-level siblings (parent_id IS NULL) read from the
  // optimistic state's blocks array instead of the DOM. The DOM read
  // misses in-flight section creates (POST /api/cms/blocks is in
  // flight, the optimistic insert has hit context, but the DOM row
  // hasn't mounted yet) — submitting a partial set 409s the server
  // with `drift`. The optimistic state INCLUDES the in-flight inserts
  // so the submitted set matches the server's living-children set on
  // commit. Nested cases (column children, section children) still
  // read from the DOM where the inline-edit context may lag the live
  // tree (e.g., during a router.refresh that hasn't reconciled yet).
  const moveBy = async (dir: -1 | 1) => {
    if (busyAction) return
    const siblings =
      p.parentBlockId === null
        ? liveBlocksRef.current
            .filter((b) => b.parentId === null)
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((b) => ({ id: b.id, version: b.version }))
        : readSiblings(p.pageId, p.parentBlockId)
    const idx = siblings.findIndex((b) => b.id === p.blockId)
    const targetIdx = idx + dir
    if (idx < 0 || targetIdx < 0 || targetIdx >= siblings.length) {
      // F9 guard — pre-disable should have caught this; the runtime
      // check stays as defence in depth (keyboard Enter-on-disabled
      // varies by browser).
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
          parentId: p.parentBlockId,
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
      // F3 / F11 — apply per-row versions + the bumped pageVersion
      // from the response so subsequent edits don't 409 against the
      // new cursors. F11: reorder now bumps pages.version too (closes
      // the race where a concurrent PATCH committed against the pre-
      // reorder cursor), and the response carries it explicitly.
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
      // Server reorder mutates parent_id assignment + position; the
      // optimistic-state reducer doesn't model position directly, so
      // we still router.refresh to pick up the new ordering. The
      // set-versions dispatches above ensure the in-flight cursor
      // matches what the refresh will land.
      refresh()
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusyAction(null)
    }
  }

  const duplicate = async () => {
    if (busyAction) return
    setBusyAction('duplicate')
    try {
      // Chunk H: route through the new /api/cms/blocks/[id]/duplicate
      // endpoint so the toolbar's behaviour matches the right-click
      // menu's "Duplicate" verb exactly. Pre-Chunk-H this path did a
      // shallow POST that (a) wiped meta (per-side spacing lost) and
      // (b) audited as kind='create' rather than 'duplicate'. The new
      // endpoint preserves meta, enforces the column-count cap on
      // column duplicates, applies parseAndSanitize re-validation,
      // and audits as kind='duplicate' with a forensic descendant
      // count. One gesture, one server effect, no toolbar-vs-menu
      // drift.
      const res = await csrfFetch(
        `/api/cms/blocks/${p.blockId}/duplicate`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId: p.pageId }),
        },
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? 'Duplicate failed.')
        // Source vanished mid-flight (peer delete race) — sync the
        // canvas so the operator doesn't see a ghost block.
        if (res.status === 404) refresh()
        return
      }
      // F7 — record on the undo stack so the toast Undo button + ⌘Z
      // both reach for the same command. Mirrors contextMenuActions.ts
      // (Duplicate). F8 — capture the new block id so we can scroll
      // + ping after refresh.
      const body = (await res.json().catch(() => ({}))) as { id?: number }
      const newId = typeof body.id === 'number' ? body.id : null
      if (newId !== null) {
        recordCommand({
          kind: 'duplicate',
          label: 'Duplicated block',
          timestamp: Date.now(),
          forward: {
            method: 'POST',
            path: `/api/cms/blocks/${p.blockId}/duplicate`,
            body: { pageId: p.pageId },
            expects: 201,
          },
          inverse: {
            method: 'DELETE',
            path: `/api/cms/blocks/${newId}`,
            expects: 200,
          },
          captures: { newBlockId: newId, sourceBlockId: p.blockId },
        })
      }
      toast.success('Duplicated.', {
        label: 'Undo',
        onClick: () => void runUndo(),
      })
      refresh()
      if (newId !== null) scheduleDuplicateHighlight(newId)
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusyAction(null)
    }
  }

  // F8 — scroll + highlight the duplicated block. The new block isn't
  // in the DOM until router.refresh resolves; defer via rAF +
  // setTimeout so the post-refresh paint lands first. requestAnimationFrame
  // is the standard signal that React has committed the new tree.
  const scheduleDuplicateHighlight = useCallback((newId: number) => {
    if (typeof window === 'undefined') return
    const attempt = (retries: number) => {
      const el = document.querySelector<HTMLElement>(
        `[data-edit-block-id="${newId}"]`,
      )
      if (!el) {
        // Server is still draining the revalidate queue. Retry up to
        // ~600ms total (10 × 60ms) before giving up — beyond that the
        // operator gets the success toast without the scroll-into-view,
        // which is preferable to a phantom scroll that lands on the
        // wrong element.
        if (retries > 0) {
          window.setTimeout(() => attempt(retries - 1), 60)
        }
        return
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Cleanup any prior pulse from a quick re-click before re-adding,
      // otherwise the animation doesn't restart (mirror of OutlinePanel).
      el.classList.remove('cavecms-outline-ping')
      void el.offsetWidth
      el.classList.add('cavecms-outline-ping')
      window.setTimeout(() => {
        el.classList.remove('cavecms-outline-ping')
      }, DUPLICATE_HIGHLIGHT_MS)
      // Select the new block too so the operator can edit immediately
      // without a follow-up click.
      selection.select(newId)
    }
    window.requestAnimationFrame(() => attempt(10))
  }, [selection])

  // F6 — capture priorData/priorMeta/parentId/position at delete time
  // so the undo command can fall back to a re-create POST if the
  // /restore route 404s (cron-purge gap). Also drives F15 — pass the
  // captured position + parentId to /restore so it lands in the
  // operator's original slot rather than the tail.
  //
  // CRITICAL fix (correctness audit C1): server's /restore route
  // interprets `position` as the `content_blocks.position` COLUMN VALUE
  // (positions are 1000-spaced), not a sibling INDEX. Sending the index
  // collapsed every undo to position 1/2/3 and head-inserted the
  // restored row regardless of original slot. Read the live block's
  // canonical position from InlineEditContext (which the reducer keeps
  // in sync with the server). Fall back to 0 → server bisects against
  // its living-siblings list and tail-appends. NEVER send a sibling
  // index here.
  const captureRestoreContext = useCallback((): {
    parentId: number | null
    position: number
  } => {
    const live = liveBlocksRef.current.find((b) => b.id === p.blockId)
    return {
      parentId: p.parentBlockId,
      position: live?.position ?? 0,
    }
  }, [p.blockId, p.parentBlockId])

  const deleteBlock = async () => {
    if (busyAction) return
    if (isFixedSlot) {
      // Defence in depth — UI pre-disables the trash button. Keep the
      // runtime guard so a forged dispatch doesn't reach the server
      // for a guaranteed 409.
      toast.info('Locked by page template — can’t remove this block.')
      return
    }
    setBusyAction('delete')
    // F14 — optimistically hide. The wrapper stays mounted (data
    // attributes preserve sibling reads) but collapses out of flow.
    const restoreCtx = captureRestoreContext()
    setOptimisticallyDeleted(true)
    try {
      const res = await csrfFetch(`/api/cms/blocks/${p.blockId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? 'Delete failed.')
        // Reveal the block again — the server still owns it.
        setOptimisticallyDeleted(false)
        return
      }
      // F3 — DELETE response (negotiated 200 with body) carries the
      // freshest pageVersion + per-row block versions. Apply them so
      // subsequent edits land on the right cursor without waiting for
      // router.refresh. Tolerate the legacy 204 shape (empty body)
      // gracefully — the refresh below brings everything back into
      // alignment either way.
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
      // ── F6 — record DELETE with restore-context captures ──
      // Inverse uses POST /api/cms/blocks/{id}/restore with the
      // captured position + parentId per the negotiated /restore
      // contract. captures.priorData / priorMeta land here so a
      // future fallback path (cron-purge 404) can re-create from
      // captured state — the executor wires the primary /restore
      // attempt; this provider records what would be needed.
      const blockId = p.blockId
      recordCommand({
        kind: 'delete-widget',
        label: 'Removed block',
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
            position: restoreCtx.position,
            parentId: restoreCtx.parentId,
          },
          expects: 200,
        },
        captures: {
          blockId,
          parentId: restoreCtx.parentId,
          position: restoreCtx.position,
          priorData: p.initialData,
          priorMeta: p.initialMeta,
          blockType: p.blockType,
          pageId: p.pageId,
        },
      })
      toast.success('Removed.', {
        label: 'Undo',
        onClick: () => void runUndo(),
      })
      refresh()
    } catch (e) {
      // Network failure — restore the block so the canvas matches the
      // server's reality.
      setOptimisticallyDeleted(false)
      toast.error(
        e instanceof Error ? e.message : 'Network error — try again.',
      )
    } finally {
      setBusyAction(null)
      setConfirmDelete(false)
    }
  }

  // Pencil "open drawer" entry point. When the operator clicks the
  // pencil while their caret is inside an inline-editable surface,
  // the contentEditable's onBlur fires the inline PATCH first; we
  // defer the drawer open one macrotask so the synchronous commit()
  // closure can flush its draftRef + savedValue + dispatch
  // block-saved into context. The drawer's useEffectiveVersions
  // then resolves the post-save cursor on mount, and the EditDrawer
  // initialData prop reflects the just-saved state — avoiding the
  // race where the drawer mounts with pre-save data, the operator
  // edits a different field, saves, and silently reverts the
  // inline edit. (Drawer key is now `block:${blockId}` only — see
  // EditableBlock's EditDrawer mount below — so the drawer does
  // NOT remount on the post-save context dispatch; the macrotask
  // defer is what keeps the form state coherent.)
  const openDrawer = () => {
    const focused = document.activeElement as HTMLElement | null
    const focusedInline = focused?.closest('[data-inline-editing="true"]')
    if (focusedInline) {
      focused?.blur()
      setTimeout(() => setOpen(true), 0)
      return
    }
    setOpen(true)
  }

  // Click-to-edit: open drawer ONLY when the click target isn't inside
  // the toolbar OR an inline-editable surface. Without the inline-edit
  // guard a click on the contentEditable bubbles up and pops the drawer
  // over the operator's text. InlineEditable also stops propagation
  // defensively; this guard is the second layer.
  //
  // F13 — also drives selection. Every wrapper click selects this
  // block + stops propagation so the parent column/section's outer
  // click handlers don't run. Selection persists via the
  // SelectionContext sessionStorage layer so refresh boundaries don't
  // collapse the toolbar.
  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-edit-toolbar]')) return
    if (target.closest('[data-inline-editing="true"]')) return
    selection.select(p.blockId)
    e.stopPropagation()
    setOpen(true)
  }

  // Lightweight click handler for the wrapper itself — drives
  // selection on clicks that hit padding/margin (between the inner
  // body and the wrapper edge) without opening the drawer. The body
  // click handler above still owns the drawer-open behaviour.
  const onWrapperClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-edit-toolbar]')) return
    if (target.closest('[data-inline-editing="true"]')) return
    // If the body click already fired, it's stopPropagation'd — we
    // won't see this event. So a click that reaches the wrapper is by
    // definition NOT a click on a child block. Select self + stop.
    selection.select(p.blockId)
    e.stopPropagation()
  }

  const openDrawerWithTab = useCallback((tab?: TabKey) => {
    setDrawerInitialTab(tab)
    setOpen(true)
  }, [])

  // Chunk H: invoked by the context menu's widget "Spacing" verb.
  // Programmatically clicks this widget's SpacingToolbar trigger
  // button — see SpacingToolbar.tsx for the data attribute. The
  // trigger lives inside this widget's wrapper, so the selector is
  // scoped to wrapperRef.current to avoid a forged data attribute on
  // a sibling element matching the global document query.
  //
  // If the toolbar's popover is ALREADY open (aria-expanded="true"),
  // clicking it toggles closed — dismissing the popover the operator
  // is trying to open. Skip the click in that case so the existing
  // open state is preserved.
  const openSpacingToolbar = useCallback(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const trigger = wrapper.querySelector<HTMLButtonElement>(
      `[data-spacing-toolbar-trigger="${p.blockId}"]`,
    )
    if (!trigger) return
    if (trigger.getAttribute('aria-expanded') === 'true') return
    // One-task defer so the menu's closeMenu focus restore (also
    // setTimeout 0) lands first — then the click opens the popover
    // in a fresh paint frame.
    setTimeout(() => trigger.click(), 0)
  }, [p.blockId])

  // Chunk H: right-click handler. Cedes to OS menu inside InlineEditable
  // richtext (spellcheck path). stopPropagation prevents the parent
  // column/section's onContextMenu from also firing — without this a
  // widget right-click would fall through to the column handler and
  // open the wrong menu.
  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-inline-editing="true"]')) return
      e.preventDefault()
      e.stopPropagation()
      contextMenu.showFor({
        kind: 'widget',
        blockId: p.blockId,
        blockType: p.blockType,
        parentId: p.parentBlockId,
        pageId: p.pageId,
        blockVersion: versions.blockVersion,
        pageVersion: versions.pageVersion,
        data: p.initialData,
        meta: p.initialMeta,
        coords: { x: e.clientX, y: e.clientY },
        openEditDrawer: openDrawerWithTab,
        openSpacingToolbar,
        triggerElement: e.currentTarget,
      })
    },
    [
      contextMenu,
      openDrawerWithTab,
      openSpacingToolbar,
      p.blockId,
      p.blockType,
      p.initialData,
      p.initialMeta,
      p.pageId,
      p.parentBlockId,
      versions.blockVersion,
      versions.pageVersion,
    ],
  )

  // Keyboard: Enter / Space on the wrapper opens the drawer (the
  // wrapper carries role="group" so SR users can perceive it as a
  // grouped target — same affordance as click-to-edit). Skip when the
  // event originates inside the toolbar or an inline-editable surface
  // so a Space-press while typing doesn't pop the drawer.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const target = e.target as HTMLElement
      if (target.closest('[data-edit-toolbar]')) return
      if (target.closest('[data-inline-editing="true"]')) return
      e.preventDefault()
      selection.select(p.blockId)
      setOpen(true)
    }
  }

  // Clear the persisted-deleted state if the wrapper remounts (e.g.,
  // the server-rendered tree includes us again because the operator
  // hit ⌘Z immediately). The setOptimisticallyDeleted(false) reveal
  // in the failure paths above covers the network/server reject case;
  // this useEffect covers the rare race where the block id reappears.
  useEffect(() => {
    setOptimisticallyDeleted(false)
  }, [p.blockId])

  const isSelected = selection.isSelected(p.blockId)
  // Active AI session against THIS block — drives the dashed copper
  // outline + "AI proposing…" pill via AISparklePreviewOverlay.
  const sparkleSession = useSparkleSessionFor(p.blockId)
  const sparkleActive =
    sparkleSession !== null &&
    sparkleSession.status !== 'idle' &&
    sparkleSession.status !== 'applying'

  // ── Keyboard shortcuts — only fire when this block is the selected one.
  // Webflow / Notion / Figma convention: ⌘D duplicate, ⌫/Delete remove,
  // ⌥↑/⌥↓ reorder, ⌘C/⌘V copy/paste. The hook owns the document
  // listener AND ignores keystrokes from text-editing surfaces, so a
  // ⌫ press inside InlineEditable safely deletes characters instead of
  // removing the block.
  const clipboard = useClipboard()
  const copyToClipboard = useCallback(() => {
    if (!isSelected) return
    // Capture from live state (after inline edits) rather than initial
    // props so a paste of a freshly-typed block carries the latest text.
    const live = liveBlocksRef.current.find((b) => b.id === p.blockId)
    dispatch({
      type: 'clipboard:set',
      slot: {
        version: CLIPBOARD_SCHEMA_VERSION,
        kind: 'widget',
        blockType: p.blockType,
        data: live?.data ?? p.initialData,
        meta: live?.meta ?? p.initialMeta,
        copiedAt: Date.now(),
      },
    })
    toast.info('Copied. ⌘V on another block to paste after it.')
  }, [
    isSelected,
    dispatch,
    toast,
    p.blockId,
    p.blockType,
    p.initialData,
    p.initialMeta,
  ])

  const pasteFromClipboard = useCallback(async () => {
    if (!isSelected) return
    if (!clipboard || clipboard.kind !== 'widget') {
      toast.info('Nothing to paste.')
      return
    }
    try {
      // Pre-build the body so we can both POST AND embed it in the undo
      // record without serialising twice.
      const postBody: Record<string, unknown> = {
        pageId: p.pageId,
        kind: 'widget',
        blockType: clipboard.blockType,
        data: clipboard.data,
        // Carry the source widget's meta (per-side spacing, label, htmlId,
        // visibility) onto the paste. Server POST accepts widget meta on
        // this route.
        ...(clipboard.meta !== undefined ? { meta: clipboard.meta } : {}),
        parentId: p.parentBlockId,
        afterBlockId: p.blockId,
      }
      const res = await csrfFetch('/api/cms/blocks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(postBody),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(j.error ?? 'Paste failed.')
        return
      }
      // Record an undo command so ⌘Z on a keyboard-pasted block targets
      // the paste itself rather than firing the previous unrelated command.
      // Pre-fix, the keyboard ⌘V path silently skipped recordCommand and
      // the context-menu Paste path was the only one wired into undo —
      // operators using the keyboard shortcut couldn't undo their paste
      // without scrolling the stack past unrelated edits.
      const body = (await res.json().catch(() => ({}))) as { id?: number }
      const newId = typeof body.id === 'number' ? body.id : null
      if (newId !== null) {
        recordCommand({
          kind: 'paste',
          label: 'Pasted block',
          timestamp: Date.now(),
          forward: {
            method: 'POST',
            path: '/api/cms/blocks',
            body: postBody,
            expects: 201,
          },
          inverse: {
            method: 'DELETE',
            path: `/api/cms/blocks/${newId}`,
            expects: 200,
          },
          captures: { newBlockId: newId },
        })
      }
      toast.success('Pasted.', {
        label: 'Undo',
        onClick: () => void runUndo(),
      })
      // Inline router.refresh + startTransition rather than depending on
      // the component-scope `refresh` closure — that closure has a fresh
      // identity per render, which would churn this useCallback every
      // pass. router is stable from useRouter; startTransition is stable
      // from useTransition's tuple.
      startTransition(() => router.refresh())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Network error — try again.')
    }
  }, [
    isSelected,
    clipboard,
    toast,
    router,
    startTransition,
    p.blockId,
    p.pageId,
    p.parentBlockId,
    recordCommand,
    runUndo,
    // refresh is stable (uses startTransition + router.refresh both from
    // hooks declared above); not in deps to avoid identity churn.
  ])

  // F6 — Widget delete keeps plain Backspace (no modifier required);
  // the blast radius is one widget and the operator has an Undo toast
  // for recovery. Sections + columns gate the same gesture behind
  // Shift / Cmd / Ctrl per the matching change in EditableSection +
  // EditableColumn.
  useKeyboardShortcuts(
    {
      onDuplicate: () => void duplicate(),
      onDelete: isFixedSlot ? undefined : () => void deleteBlock(),
      onMoveUp: isFirst ? undefined : () => void moveBy(-1),
      onMoveDown: isLast ? undefined : () => void moveBy(1),
      onCopy: copyToClipboard,
      onPaste: () => void pasteFromClipboard(),
    },
    isSelected,
  )

  return (
    <div
      ref={setRefs}
      data-edit-block-id={p.blockId}
      data-edit-block-version={versions.blockVersion}
      data-edit-block-type={p.blockType}
      data-edit-page-id={p.pageId}
      data-edit-page-version={versions.pageVersion}
      data-edit-parent-id={p.parentBlockId === null ? '' : p.parentBlockId}
      data-edit-selected={isSelected ? 'true' : undefined}
      onContextMenu={onContextMenu}
      onClick={onWrapperClick}
      // Chunk H: tabIndex=-1 lets focus-restore on context-menu close
      // land here. The INNER role="group" div carries tabIndex=0 for
      // the natural Tab order (Enter-to-edit affordance); this outer
      // wrapper is programmatic-focus-only.
      tabIndex={-1}
      style={dragStyle}
      className={clsx(
        // Edit-mode-only spacing: small vertical margin + a horizontal
        // padding sliver so the widget's top-pinned toolbar (-top-3) +
        // drag handle (-top-3) don't clip against the sibling widget
        // above / against the column's outline. Live mode never mounts
        // EditableBlock — widgets render flush in their natural rhythm.
        'group/edit relative my-2',
        'px-2',
        sortable.isDragging && 'opacity-50',
        // F14 — optimistic delete: collapse out of flow while the
        // server confirms. `hidden` removes from layout AND a11y.
        optimisticallyDeleted && 'hidden',
      )}
    >
      {/* Click target — full block surface. role="group" + tabIndex make
          the wrapper keyboard-focusable so a screen-reader user can
          press Enter to edit, mirroring the click affordance.

          When a descendant [data-inline-editing="true"] surface is
          focused, the outer hover ring is toned DOWN via the
          `group-has-[[data-inline-editing='true']:focus]` variant so
          the wrapper visual doesn't fight the contentEditable's own
          inset copper focus ring. The pencil button on the toolbar
          stays reachable — it's the "advanced" / drawer path. */}
      <div
        role="group"
        tabIndex={0}
        aria-label={`Edit ${friendlyType} block — press Enter to open`}
        onClick={onBodyClick}
        onKeyDown={onKeyDown}
        className={clsx(
          'relative cursor-pointer rounded-2xl outline outline-2 outline-transparent transition-[outline-color,box-shadow] duration-quick ease-standard',
          'group-hover/edit:outline-copper-400/70 group-hover/edit:shadow-[0_18px_44px_-22px_rgba(160,90,40,0.35)]',
          // Inline-edit-active toning. `!` overrides the hover ring on
          // the same element since both variants generate same-specificity
          // selectors — without it the hover state would shout over the
          // focused inline editor's own ring.
          "group-has-[[data-inline-editing='true']:focus]/edit:!outline-copper-200/25",
          "group-has-[[data-inline-editing='true']:focus]/edit:!shadow-none",
          'focus-within:outline-copper-400',
          // F13 — persistent selection ring. Outlasts hover/blur so
          // touch operators can hit the toolbar after the first tap.
          isSelected &&
            '!outline-copper-400 shadow-[0_18px_44px_-22px_rgba(160,90,40,0.35)]',
          // AI sparkle session active — dashed copper outline overrides
          // selection/hover state so the operator knows the AI is
          // working on THIS block specifically.
          sparkleActive && SPARKLE_ACTIVE_OUTLINE,
          'motion-reduce:transition-none',
        )}
      >
        {p.children}
        {sparkleSession !== null && <AISparklePreviewOverlay blockId={p.blockId} />}
      </div>

      {/* Floating action toolbar. Pinned top-right with a copper-pill
          background. Hidden by default; revealed on hover OR keyboard
          focus on any descendant. Sticky to viewport top within the
          block height so a tall section's toolbar stays reachable as
          the operator scrolls. F12 — the friendly-type badge is the
          FIRST child of the cluster so it shares the keyboard-focusable
          group and never floats outside it. F11 — when selected, the
          toolbar stays pinned visible regardless of hover state. */}
      <div
        data-edit-toolbar
        // F10 — widget toolbar at z-10 (section z-30 > column z-20 >
        // widget z-10) so a section's top-pinned chrome can never be
        // covered by a child widget's chrome.
        className={clsx(
          'absolute -top-3 right-4 z-10 flex items-center gap-0.5 rounded-full bg-obsidian/95 p-1 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.6)] ring-1 ring-champagne/30 backdrop-blur-sm transition-all duration-quick ease-standard motion-reduce:transition-none',
          isSelected
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 group-hover/edit:pointer-events-auto group-hover/edit:opacity-100 group-focus-within/edit:pointer-events-auto group-focus-within/edit:opacity-100',
        )}
        aria-label={`${friendlyType} block actions`}
      >
        {/* F12 — block-type label is part of the cluster now (was a
            floating absolute span). Champagne pill on the obsidian
            toolbar carries the same "what is this?" affordance with a
            single keyboard-focusable group. aria-hidden because the
            wrapper's role="group" aria-label already announces the
            block type to AT users. */}
        <span
          aria-hidden="true"
          className="hidden md:inline-flex items-center rounded-full bg-champagne px-3 py-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-obsidian"
        >
          {friendlyType}
        </span>
        <span
          aria-hidden="true"
          className="hidden md:inline-block mx-0.5 h-4 w-px bg-cream-50/15"
        />
        {/* Drag handle — folded into the toolbar as the first
           button so it shares the cluster's visible footprint and
           can never be covered by sibling chrome. dnd-kit's
           setActivatorNodeRef + listeners attach here; the rest of
           the toolbar's buttons get pointer-events but no drag
           activation. */}
        <button
          ref={sortable.setActivatorNodeRef}
          type="button"
          aria-label={`Drag ${friendlyType} to reorder`}
          title="Drag to reorder"
          {...sortable.attributes}
          {...sortable.listeners}
          // touch-none is REQUIRED on the dnd-kit PointerSensor activator.
          // @dnd-kit/core 6.x removed the auto-applied touch-action style;
          // without `touch-action: none` the browser claims vertical touch
          // gestures for scroll BEFORE the 6px activation distance is
          // reached, and the drag never starts on touch / trackpad. Mouse
          // works because mouse drag is unambiguous with scroll. See
          // https://docs.dndkit.com/api-documentation/sensors/pointer.
          style={{ touchAction: 'none' }}
          className="inline-flex h-11 w-11 cursor-grab touch-none items-center justify-center rounded-full text-cream-50 transition-all hover:scale-105 hover:bg-champagne hover:text-obsidian focus-visible:scale-105 focus-visible:bg-champagne focus-visible:text-obsidian focus-visible:outline-none active:cursor-grabbing motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100"
        >
          <GripVertical size={16} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        {/* AI sparkle — leading position so the most-used affordance
            is closest to the drag handle. Self-gates via aiSnapshot +
            INLINE_AI_BLOCK_TYPES; returns null when AI is off or the
            block isn't eligible, so the layout collapses cleanly.
            currentData reads from the live InlineEditContext (which
            includes any inline edits the operator made since page
            load) so AI fields reflect the freshest content, not the
            server-render snapshot. */}
        <AISparkleButton
          blockId={p.blockId}
          blockType={p.blockType}
          blockVersion={versions.blockVersion}
          pageId={p.pageId}
          pageVersion={versions.pageVersion}
          currentData={
            liveBlocksRef.current.find((b) => b.id === p.blockId)?.data ??
            p.initialData
          }
        />
        <ToolButton
          icon={Pencil}
          label="Edit"
          onClick={openDrawer}
        />
        <SpacingToolbar
          blockId={p.blockId}
          kind="widget"
          initialMeta={p.initialMeta}
          initialVersion={versions.blockVersion}
          pageId={p.pageId}
          initialPageVersion={versions.pageVersion}
          targetRef={wrapperRef}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        {/* F1/F9 — Up/Down for keyboard + touch operators. Pre-disabled
            at the bounds so the operator gets a greyed-out affordance
            with a tooltip instead of a spinner that resolves to an
            info toast. */}
        <ToolButton
          icon={ArrowUp}
          label={isFirst ? 'Already at the top' : 'Move up'}
          onClick={() => void moveBy(-1)}
          busy={busyAction === 'up'}
          disabled={isFirst}
        />
        <ToolButton
          icon={ArrowDown}
          label={isLast ? 'Already at the bottom' : 'Move down'}
          onClick={() => void moveBy(1)}
          busy={busyAction === 'down'}
          disabled={isLast}
        />
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-cream-50/15" />
        <ToolButton
          icon={Copy}
          label="Duplicate"
          onClick={() => void duplicate()}
          busy={busyAction === 'duplicate'}
        />
        {/* F4 — fixed-slot rows render a Lock affordance instead of a
            destructive Trash. Server returns 409 cannot_delete_fixed_block
            for these; the UI never lets the operator land a click that
            will bounce. */}
        {isFixedSlot ? (
          <ToolButton
            icon={Lock}
            label="Locked by page template"
            onClick={() => {
              toast.info(
                'This block is part of the page template and can’t be removed.',
              )
            }}
            disabled
          />
        ) : (
          <ToolButton
            icon={Trash2}
            label="Delete"
            destructive
            onClick={() => setConfirmDelete(true)}
            busy={busyAction === 'delete'}
          />
        )}
      </div>

      {open && (
        <EditDrawer
          // Key on blockId only. Pre-Chunk-B the version was in the key
          // so router.refresh-driven prop bumps would remount the
          // drawer with fresh data. Post-Chunk-B the drawer reads
          // (blockVersion, pageVersion) from InlineEditContext at
          // commit time via useEffectiveVersions — a sibling save
          // bumps the override without remounting the drawer (which
          // would wipe the operator's in-progress form draft).
          key={`block:${p.blockId}`}
          blockId={p.blockId}
          blockType={p.blockType}
          blockKey={p.blockKey}
          initialData={p.initialData}
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

      {confirmDelete && (
        <ConfirmModal
          ariaLabel={`Remove ${friendlyType} block?`}
          title={`Remove this ${friendlyType} block?`}
          description="It'll be hidden from the public site right away. You can restore from the admin trash within 30 days."
          confirmLabel="Remove"
          cancelLabel="Cancel"
          destructive
          busy={busyAction === 'delete'}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void deleteBlock()}
        />
      )}
    </div>
  )
}
