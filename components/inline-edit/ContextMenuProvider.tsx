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
import { useRouter } from 'next/navigation'
import { useToast } from './Toast'
import { ContextMenu } from './ContextMenu'
import { ConfirmModal } from './ConfirmModal'
import { PromptModal } from './PromptModal'
import {
  MENU_ITEMS_BY_KIND,
  type EditDrawerTab,
  type MenuContext,
} from '@/lib/cms/contextMenuActions'
import type {
  ClipboardColumn,
  ClipboardSlot,
  ClipboardWidget,
} from '@/lib/cms/clipboard'
import {
  useClipboard,
  useInlineEditDispatch,
  useInlineEditState,
} from './InlineEditContext'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import type { BlockKind } from '@/lib/cms/blockMeta'

// Chunk H — page-level provider that wires the right-click context menu
// into the editor.
//
// Architecture:
//   - Mounted once at the EditableMain root, INSIDE the InlineEditProvider
//     (it reads the clipboard slot + dispatches clipboard:set actions).
//   - Exposes a useContextMenu() hook each Editable* component uses to
//     register itself. The Editable component adds its own onContextMenu
//     handler that calls api.showFor({...}) with the right-clicked
//     block's identity + UI callbacks.
//   - Renders the ContextMenu via portal-mount (in ContextMenu.tsx
//     itself) when a menu is active. Confirm modals for destructive
//     actions render here so they survive menu unmount.
//
// Native menu preservation:
//   The provider has NO document-level contextmenu listener. Native
//   right-click on non-editor surfaces (site header nav, page chrome,
//   admin tables) just bubbles to the browser normally. The editor
//   surfaces hijack via their React onContextMenu handlers; everything
//   else gets the OS menu by default. This is the simplest possible
//   "cede the OS menu" strategy — no allowlist / blocklist, no
//   data-attribute walk. Right-clicking SELECTED TEXT inside an
//   InlineEditable richtext is the one tricky case: InlineEditable's
//   own contentEditable surface is INSIDE EditableBlock; the
//   EditableBlock's onContextMenu would intercept by default. The
//   Editable* components handle the boundary in their own handlers
//   (skip when e.target is inside [data-inline-editing="true"]).

export type ConfirmDeleteOpts = {
  title: string
  description: string
  confirmLabel?: string
}

interface ShowForParams {
  kind: BlockKind
  blockId: number
  blockType: string
  parentId: number | null
  pageId: number
  blockVersion: number
  pageVersion: number
  data: unknown
  meta: unknown
  columnCount?: number
  coords: { x: number; y: number }
  openEditDrawer: (initialTab?: EditDrawerTab) => void
  openSpacingToolbar?: () => void
  openAddWidget?: () => void
  triggerElement: HTMLElement | null
}

interface ContextMenuApi {
  showFor: (params: ShowForParams) => void
  isOpen: boolean
}

const Ctx = createContext<ContextMenuApi | null>(null)

// Module-level fallback so EVERY out-of-provider consumer shares the
// SAME object reference. Without this, the fallback was constructed
// per `useContextMenu()` call — every render of every Editable*
// invalidated its `onContextMenu` useCallback memo (the `contextMenu`
// dep was a fresh object identity each render), defeating the
// optimisation.
const NOOP_API: ContextMenuApi = {
  showFor: () => {
    /* no-op */
  },
  isOpen: false,
}

// Once-per-pageload signal so a regression that mounts a consumer
// outside the provider gets a single observable console line rather
// than one per render under React's re-render storms.
let warnedOutsideProvider = false

export function useContextMenu(): ContextMenuApi {
  const v = useContext(Ctx)
  if (v === null) {
    if (typeof window !== 'undefined' && !warnedOutsideProvider) {
      warnedOutsideProvider = true
      console.warn(
        '[ContextMenuProvider] useContextMenu called outside ContextMenuProvider — right-click menu actions will no-op.',
      )
    }
    return NOOP_API
  }
  return v
}

// Internal state shape carried by the provider while a menu is active.
// Aliased to ShowForParams today; named separately so a future per-show
// metadata field (menu-open timestamp for analytics, focus-restore
// fallback selector) can land without breaking the public showFor
// contract.
type ActiveMenuState = ShowForParams

interface ConfirmModalState {
  opts: ConfirmDeleteOpts
  resolve: (ok: boolean) => void
}

interface PromptModalState {
  opts: {
    title: string
    description?: string
    label?: string
    defaultValue?: string
    placeholder?: string
    confirmLabel?: string
    maxLength?: number
  }
  resolve: (value: string | null) => void
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const toast = useToast()
  const clipboard = useClipboard()
  const dispatch = useInlineEditDispatch()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  // Mirror the live block tree in a ref so the section-copy callback
  // injected into MenuContext reads the FRESHEST optimistic tree at
  // invocation time. Without the ref, the ctx object would freeze
  // state.blocks at menu-show time and a slash-command edit landed
  // mid-menu (vanishingly rare but possible) would be silently
  // omitted from the copied subtree.
  const inlineState = useInlineEditState()
  const inlineStateRef = useRef(inlineState)
  inlineStateRef.current = inlineState
  // useRef the clipboard so handlers built at right-click time can
  // observe the freshest slot when they fire — without this, the ctx
  // object's clipboard field would freeze at menu-show time and a
  // Copy gesture immediately followed by a Paste from a different
  // menu would see the stale (pre-copy) state. Closer-coupled hooks
  // (the menu's disabled() predicate) re-read at fire time via the
  // ctx getter pattern.
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard

  const [active, setActive] = useState<ActiveMenuState | null>(null)
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(
    null,
  )
  const [promptModal, setPromptModal] = useState<PromptModalState | null>(null)

  // Track the trigger element for focus restore. The active state
  // already carries it but we mirror in a ref so the close handler
  // can restore focus even when called from a post-unmount setTimeout.
  const triggerElRef = useRef<HTMLElement | null>(null)

  // Tracks "did a destructive action open a ConfirmModal?" so closeMenu
  // skips its focus-restore setTimeout. Without this, the modal's
  // useEffect-driven focus on its Cancel button is yanked back to the
  // trigger element by the 0ms setTimeout — operator loses keyboard
  // focus on the modal AND screen readers re-announce the wrong thing.
  const skipNextFocusRestoreRef = useRef(false)

  const closeMenu = useCallback(() => {
    setActive(null)
    // Defer focus restore one task so the menu has unmounted + React
    // has flushed. Focus the trigger element if it still exists in
    // the DOM — a destructive action that deleted the trigger leaves
    // focus on document.body (browser default), which is acceptable.
    const trigger = triggerElRef.current
    triggerElRef.current = null
    const skipRestore = skipNextFocusRestoreRef.current
    skipNextFocusRestoreRef.current = false
    if (skipRestore) return
    setTimeout(() => {
      if (trigger && document.body.contains(trigger)) {
        trigger.focus()
      }
    }, 0)
  }, [])

  const refresh = useCallback(() => {
    router.refresh()
  }, [router])

  const setClipboard = useCallback(
    (slot: ClipboardSlot) => {
      dispatch({ type: 'clipboard:set', slot })
    },
    [dispatch],
  )

  /**
   * Walk the optimistic tree under `sectionId` and return its captured
   * subtree (columns + widgets) for the section-copy clipboard slot.
   *
   * Pure reader — the live state ref insulates the closure from
   * stale identity capture. Section blocks have children at parentId
   * === sectionId, kind === 'column'; widgets live one layer deeper
   * at parentId === columnId. Order matches state.blocks order which
   * the reconciler keeps sorted by (parent, position).
   */
  const getSectionSubtree = useCallback(
    (sectionId: number): { columns: ClipboardColumn[]; widgetCount: number } => {
      const all = inlineStateRef.current.blocks
      const columns: ClipboardColumn[] = []
      let widgetCount = 0
      // Two passes over the flat array — small N (single page).
      // Sorting by position is unnecessary because the reconciler in
      // InlineEditContext keeps the array partitioned by (parent,
      // position) on every snapshot/apply-move.
      const columnRows = all.filter(
        (b) => b.parentId === sectionId && b.kind === 'column',
      )
      for (const col of columnRows) {
        const widgetRows = all.filter(
          (b) => b.parentId === col.id && b.kind === 'widget',
        )
        const widgets: ClipboardWidget[] = widgetRows.map((w) => ({
          blockType: w.blockType,
          data: w.data,
          meta: w.meta,
        }))
        widgetCount += widgets.length
        columns.push({ meta: col.meta, widgets })
      }
      return { columns, widgetCount }
    },
    [],
  )

  const confirmDelete = useCallback(
    (opts: ConfirmDeleteOpts): Promise<boolean> => {
      // Signal closeMenu to skip its focus-restore setTimeout for the
      // immediately-preceding close. The destructive item's handler
      // calls ctx.closeMenu() first, then awaits confirmDelete — the
      // ref flag survives across those two calls and is cleared
      // inside closeMenu.
      skipNextFocusRestoreRef.current = true
      return new Promise((resolve) => {
        setConfirmModal({ opts, resolve })
      })
    },
    [],
  )

  const promptName = useCallback(
    (opts: PromptModalState['opts']): Promise<string | null> => {
      // Same focus-restore suppression as confirmDelete: the menu
      // handler closes the menu first, then awaits this prompt, so the
      // modal's own input focus must not be yanked back to the trigger.
      skipNextFocusRestoreRef.current = true
      return new Promise((resolve) => {
        setPromptModal({ opts, resolve })
      })
    },
    [],
  )

  // Resolve any in-flight confirmDelete with `false` on unmount so a
  // pending `await ctx.confirmDelete(...)` doesn't hang silently when
  // the provider unmounts mid-prompt (page navigation, dev hot-reload,
  // EditableMain disabled mid-flight). Without this the handler's
  // caller never reaches its `if (!ok) return` and the Promise stays
  // unresolved until process exit.
  useEffect(() => {
    return () => {
      if (confirmModal !== null) {
        confirmModal.resolve(false)
      }
    }
  }, [confirmModal])

  // Same unmount safety for the name prompt — resolve to null (cancel)
  // so a pending `await ctx.promptName(...)` never hangs.
  useEffect(() => {
    return () => {
      if (promptModal !== null) {
        promptModal.resolve(null)
      }
    }
  }, [promptModal])

  const showFor = useCallback((params: ShowForParams) => {
    triggerElRef.current = params.triggerElement
    setActive(params)
  }, [])

  const api = useMemo<ContextMenuApi>(
    () => ({ showFor, isOpen: active !== null }),
    [showFor, active],
  )

  // ── Document-level close affordances. Scoped to the active state —
  // the listeners only register while the menu is open. Click-outside
  // is handled inside the ContextMenu's panel logic; THIS effect
  // covers scroll, resize, and the global Esc key. ──
  useEffect(() => {
    if (active === null) return
    const onScrollOrResize = () => closeMenu()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeMenu()
      }
    }
    // Outside-click + outside-contextmenu close. Capture phase so we
    // run before any descendant React click handlers, which is the
    // standard "popover dismissal" pattern.
    const onClick = (e: MouseEvent) => {
      // The ContextMenu portal mounts on document.body. A click inside
      // the menu's panel is identifiable by walking up from e.target
      // until we hit a [role="menu"] container; if found, the click
      // was inside — do nothing.
      const target = e.target as HTMLElement | null
      if (target?.closest('[role="menu"]')) return
      closeMenu()
    }
    const onCtx = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[role="menu"]')) return
      // A second right-click outside should close THIS menu; the
      // editor surface's own onContextMenu will then open the NEW
      // menu (React event ordering — capture-phase outside close
      // runs before bubble-phase showFor).
      closeMenu()
    }
    // Scroll: BUBBLE phase + passive. Capture-phase would catch nested
    // scroll containers (overflow-y'd panels, virtualized lists, the
    // EditDrawer's sidebar) — scrolling INSIDE any descendant of the
    // page would dismiss the menu, which is a surprising UX regression
    // compared to native context menus. Limiting to the window's own
    // scroll matches OS behaviour.
    window.addEventListener('scroll', onScrollOrResize, { passive: true })
    window.addEventListener('resize', onScrollOrResize)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onCtx, true)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize)
      window.removeEventListener('resize', onScrollOrResize)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('contextmenu', onCtx, true)
    }
  }, [active, closeMenu])

  // Build the MenuContext that handlers see. Memoised on the active
  // identity so the items[].handler closures don't churn on every
  // re-render while the menu is open. The clipboard field is read
  // via the ref so a stale ctx capture doesn't pin pre-copy state.
  const menuCtx = useMemo<MenuContext | null>(() => {
    if (active === null) return null
    return {
      kind: active.kind,
      blockId: active.blockId,
      blockType: active.blockType,
      parentId: active.parentId,
      pageId: active.pageId,
      blockVersion: active.blockVersion,
      pageVersion: active.pageVersion,
      data: active.data,
      meta: active.meta,
      columnCount: active.columnCount,
      // Read clipboard via the ref AT FIRE TIME so handlers always
      // see the freshest slot. Disabled() predicates read this at
      // render time which is fine — the menu reopens on each right-
      // click anyway.
      get clipboard() {
        return clipboardRef.current
      },
      setClipboard,
      getSectionSubtree,
      closeMenu,
      refresh,
      toast,
      confirmDelete,
      promptName,
      openEditDrawer: active.openEditDrawer,
      openSpacingToolbar: active.openSpacingToolbar,
      openAddWidget: active.openAddWidget,
      // Chunk J — undo stack injection. duplicate / paste handlers
      // record their inverse via recordCommand; the inline-Undo toast
      // (where the handlers add one) routes through runUndo so the
      // cursor moves consistently with ⌘Z.
      recordCommand,
      runUndo: () => void runUndo(),
    }
  }, [
    active,
    setClipboard,
    getSectionSubtree,
    closeMenu,
    refresh,
    toast,
    confirmDelete,
    promptName,
    recordCommand,
    runUndo,
  ])

  return (
    <Ctx.Provider value={api}>
      {children}
      {active !== null && menuCtx !== null && (
        <ContextMenu
          items={MENU_ITEMS_BY_KIND[active.kind]}
          ctx={menuCtx}
          coords={active.coords}
          ariaLabel={`${capitalize(active.kind)} actions`}
        />
      )}
      {confirmModal !== null && (
        <ConfirmModal
          ariaLabel={confirmModal.opts.title}
          title={confirmModal.opts.title}
          description={confirmModal.opts.description}
          confirmLabel={confirmModal.opts.confirmLabel ?? 'Remove'}
          cancelLabel="Cancel"
          destructive
          onCancel={() => {
            confirmModal.resolve(false)
            setConfirmModal(null)
          }}
          onConfirm={() => {
            confirmModal.resolve(true)
            setConfirmModal(null)
          }}
        />
      )}
      {promptModal !== null && (
        <PromptModal
          ariaLabel={promptModal.opts.title}
          title={promptModal.opts.title}
          description={promptModal.opts.description}
          label={promptModal.opts.label}
          defaultValue={promptModal.opts.defaultValue}
          placeholder={promptModal.opts.placeholder}
          confirmLabel={promptModal.opts.confirmLabel}
          maxLength={promptModal.opts.maxLength}
          onCancel={() => {
            promptModal.resolve(null)
            setPromptModal(null)
          }}
          onConfirm={(value) => {
            promptModal.resolve(value)
            setPromptModal(null)
          }}
        />
      )}
    </Ctx.Provider>
  )
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
