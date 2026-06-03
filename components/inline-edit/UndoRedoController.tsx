'use client'

import { useEffect } from 'react'

// UndoRedoController — document-level ⌘Z / ⇧⌘Z (and Ctrl+Z / Ctrl+Y) handler
// for the inline editor.
//
// Defers to NATIVE undo when focus is in an editable surface (input / textarea
// / select / contenteditable / InlineEditable) so the operator's per-character
// undo wins. Otherwise it dispatches `cavecms:undo` / `cavecms:redo` window
// events. The admin-bar DraftBar (which lives outside this provider tree)
// listens for those and runs a SERVER-SIDE draft undo/redo
// (POST /api/cms/pages/[id]/undo|redo over the draft revision history), so the
// keyboard and the admin-bar Undo/Redo buttons share exactly one path.
//
// Draft undo/redo is server-persisted (page_draft_revisions, migration 0029):
// it survives reloads + sessions, handles every op uniformly, and is fully
// API-programmable — there is no client-side replay stack anymore.
export function UndoRedoController() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return

      // Native undo wins inside any editable surface (per-character intent).
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
        window.dispatchEvent(new Event('cavecms:redo'))
        return
      }
      if (key === 'z') {
        e.preventDefault()
        e.stopPropagation()
        window.dispatchEvent(new Event(e.shiftKey ? 'cavecms:redo' : 'cavecms:undo'))
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  return null
}
