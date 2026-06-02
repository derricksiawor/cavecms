'use client'

import { useEffect } from 'react'
import {
  useCanRedo,
  useCanUndo,
  useUndoActions,
} from './UndoStackProvider'

// Chunk J — UndoRedoController
//
// Document-level keyboard handler. Listens for ⌘Z / ⇧⌘Z (Mac) and
// Ctrl+Z / Ctrl+Y (non-Mac), defers to native browser undo when focus
// is in an editable surface (input / textarea / select / contenteditable),
// and otherwise calls the centralised runUndo / runRedo functions from
// UndoStackProvider. Cursor management, executor logic, and rebind
// semantics all live in UndoStackProvider — this file is just the
// keyboard surface.
//
// Industry survey informing this design (full notes at head of
// lib/cms/undoStack.ts):
//   • Notion / Webflow / Wix / Figma / Google Docs all intercept ⌘Z at
//     the document level and run their own structural stack. We do
//     the same, BUT we defer to native undo when focus is on ANY
//     editable surface — operator's per-character keystroke undo intent
//     must win over our chunk's structural undo.
//   • Inline-Undo toast buttons go through the SAME runUndo path so
//     the cursor moves consistently. A subsequent ⌘Z after clicking
//     the toast correctly targets the NEXT command on the stack, not
//     the just-undone one.

export function UndoRedoController() {
  const { runUndo, runRedo } = useUndoActions()
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()

  // ── Admin-bar bridge ──
  // The public admin bar (AdminBarInteractive) renders in the root layout,
  // OUTSIDE the UndoStackProvider, so its Undo/Redo pills cannot call
  // runUndo/runRedo or read canUndo/canRedo directly. Same constraint the
  // OutlineTogglePill solves with `cavecms:outline-visibility`. The pills
  // post `cavecms:undo` / `cavecms:redo` window events (executed here) and
  // a `cavecms:undo-state-request` to pull the current enabled state; this
  // controller broadcasts `cavecms:undo-state` { canUndo, canRedo } both on
  // request AND whenever the cursor moves, so the pills enable/disable in
  // lockstep with the stack.
  useEffect(() => {
    const onUndo = () => void runUndo()
    const onRedo = () => void runRedo()
    const broadcast = () =>
      window.dispatchEvent(
        new CustomEvent('cavecms:undo-state', {
          detail: { canUndo, canRedo },
        }),
      )
    window.addEventListener('cavecms:undo', onUndo)
    window.addEventListener('cavecms:redo', onRedo)
    window.addEventListener('cavecms:undo-state-request', broadcast)
    // Announce the current state immediately so a pill that mounted before
    // this controller (or after) converges to the right enabled state.
    broadcast()
    return () => {
      window.removeEventListener('cavecms:undo', onUndo)
      window.removeEventListener('cavecms:redo', onRedo)
      window.removeEventListener('cavecms:undo-state-request', broadcast)
    }
  }, [runUndo, runRedo, canUndo, canRedo])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()

      // Defer to native undo when focus is in any editable surface:
      // form fields (input/textarea/select), an InlineEditable
      // contenteditable, or any other contenteditable (drawer rich-
      // text, etc.). The operator's per-character undo intent inside
      // ANY of these must win over the chunk's structural undo.
      const active = document.activeElement as HTMLElement | null
      if (active) {
        const tag = active.tagName
        const isFormField =
          tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        const isContentEditable =
          active.isContentEditable === true ||
          active.getAttribute('data-inline-editing') === 'true'
        if (isFormField || isContentEditable) return
      }

      // Ctrl+Y / ⌘Y → redo (Windows / cross-OS convention).
      if (key === 'y' && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        void runRedo()
        return
      }
      if (key === 'z') {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) {
          void runRedo()
        } else {
          void runUndo()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [runUndo, runRedo])

  return null
}
