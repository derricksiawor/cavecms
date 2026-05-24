'use client'
import { useEffect, useLayoutEffect, useRef } from 'react'

// Cross-cutting keyboard-shortcuts hook for the inline editor. ONE
// global keydown listener attached to `document`, scoped by the
// `enabled` flag at the consumer (EditableBlock / EditableSection /
// EditableColumn pass `enabled: isSelected(myId)` so only the selected
// block reacts — no fan-out, no event collision between siblings).
//
// Text-editing fields (input / textarea / contentEditable) are passed
// through unmodified — the operator's typing must never compete with
// the editor's verbs. EXCEPT Escape, which always fires onEscape so a
// blur-on-Escape affordance works from anywhere.
//
// The Cmd/Ctrl+Z + Cmd/Shift+Z undo / redo pair is INTENTIONALLY not
// bound here — UndoRedoController owns that pair globally. Double
// binding would either no-op (preventDefault swallowed) or double-fire
// (the inverse undo runs twice). See UndoRedoController.tsx.

export interface ShortcutHandlers {
  /** ⌘D / Ctrl+D (no shift). Browser would otherwise open the
   *  bookmark dialog — the hook preventDefaults. */
  onDuplicate?: () => void
  /** Backspace / Delete on the selected block (not text-editing). The
   *  event is forwarded so the consumer can require modifier keys
   *  (Shift / Cmd / Ctrl) for high-blast-radius gestures like section
   *  + column delete — see F6. */
  onDelete?: (e: KeyboardEvent) => void
  /** Alt+ArrowUp — move block before its previous sibling. */
  onMoveUp?: () => void
  /** Alt+ArrowDown — move block after its next sibling. */
  onMoveDown?: () => void
  /** ⌘C / Ctrl+C with a block selected (not text-editing — the OS
   *  copy path still works on selected text). */
  onCopy?: () => void
  /** ⌘V / Ctrl+V (not text-editing — the OS paste path still works
   *  in form fields). */
  onPaste?: () => void
  /** Escape from anywhere, including text-editing surfaces. Used to
   *  blur the active editor / clear selection / close menus. */
  onEscape?: () => void
}

// Returns true when the active element is something the operator is
// typing into — we must not steal their keystrokes. The contentEditable
// check matches Slate, Lexical, TipTap, our InlineEditable, and any
// future rich-text surface.
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (typeof document === 'undefined') return false
  const el = (target as Element | null) ?? document.activeElement
  if (!el || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  // Walk up — a contentEditable surface (InlineEditable) often has
  // the editable attribute on a wrapper while the actual focused
  // element is a nested text node host. closest() with the attribute
  // selector covers both the host element and any descendant.
  return el.closest('[contenteditable="true"], [data-inline-editing="true"]')
    !== null
}

// Detect the meta key on macOS (Cmd) vs Windows/Linux (Ctrl). We
// accept EITHER on all platforms so a Linux operator using a Mac
// keyboard layout (or vice versa) still gets the shortcut.
function isCmdOrCtrl(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey
}

export function useKeyboardShortcuts(
  handlers: ShortcutHandlers,
  enabled: boolean = true,
): void {
  // F3 — stash the freshest `handlers` object in a ref and refresh it
  // on every render via a layout effect. Each consumer
  // (EditableBlock / EditableSection / EditableColumn) builds the
  // handlers object as a fresh inline literal per render. If the
  // useEffect below depended on `handlers` directly, the document
  // keydown listener would unbind+rebind on every render of every
  // selected block — pure churn that costs cycles AND momentarily
  // leaves a frame with no listener bound. The ref pattern lets the
  // listener register ONCE per (enabled) lifetime and read the
  // latest handlers at invocation time.
  const handlersRef = useRef(handlers)
  useLayoutEffect(() => {
    handlersRef.current = handlers
  })

  useEffect(() => {
    if (!enabled) return
    if (typeof document === 'undefined') return

    const onKeyDown = (e: KeyboardEvent) => {
      const current = handlersRef.current
      // Escape FIRST — fires regardless of text-editing context so
      // the operator can always bail out of a focused editor / menu
      // by pressing Escape. This is the only verb that runs while
      // typing.
      if (e.key === 'Escape') {
        if (current.onEscape) {
          current.onEscape()
        }
        return
      }

      // Every other verb defers to the OS / browser when the
      // operator is typing — we must not steal Backspace inside a
      // <textarea>, ⌘C from a selected text run, etc.
      if (isTextEditingTarget(e.target)) return

      // ⌘D / Ctrl+D → Duplicate. Shift+⌘D is a different gesture
      // (some browsers' bookmark-folder shortcut) — we don't bind
      // it here so the gesture remains unambiguous.
      if (isCmdOrCtrl(e) && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
        if (current.onDuplicate) {
          e.preventDefault()
          current.onDuplicate()
        }
        return
      }

      // Backspace / Delete → Delete the selected block. We accept
      // plain Backspace AND modifier combinations (Shift / Cmd / Ctrl)
      // so consumers can require modifiers for high-blast-radius
      // deletes (see F6 — sections + columns require Shift OR
      // Cmd/Ctrl). The event is forwarded so the consumer's onDelete
      // can inspect shiftKey / metaKey / ctrlKey on its own. Alt is
      // still excluded — Alt+Backspace is "delete word" in many
      // browsers' inputs and isn't a gesture we want to overload.
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey) {
        if (current.onDelete) {
          e.preventDefault()
          current.onDelete(e)
        }
        return
      }

      // Alt+ArrowUp / Alt+ArrowDown → reorder within siblings.
      // Alt (not ⌘) matches Notion + every other block editor. ⌘↑
      // is reserved by macOS for "scroll to top of document".
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === 'ArrowUp') {
          if (current.onMoveUp) {
            e.preventDefault()
            current.onMoveUp()
          }
          return
        }
        if (e.key === 'ArrowDown') {
          if (current.onMoveDown) {
            e.preventDefault()
            current.onMoveDown()
          }
          return
        }
      }

      // ⌘C / Ctrl+C → Copy the selected block to the editor's
      // clipboard slot. No preventDefault — the OS copy still runs
      // for whatever browser text selection might exist. The slot
      // write is additive; the operator's system clipboard is
      // never touched (see lib/cms/clipboard.ts trade-off note).
      if (isCmdOrCtrl(e) && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        if (current.onCopy) {
          current.onCopy()
        }
        return
      }

      // ⌘V / Ctrl+V → Paste from the editor's clipboard slot. Same
      // logic — no preventDefault unless we actually have a slot to
      // paste; the caller's onPaste implementation decides whether
      // to honour the gesture (slot version-gate, target kind
      // compatibility — see lib/cms/clipboard.ts canPaste).
      if (isCmdOrCtrl(e) && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        if (current.onPaste) {
          current.onPaste()
        }
        return
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // Stable identity per (enabled) lifetime. Handlers read via the ref.
  }, [enabled])
}
