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
import { SlashCommandPalette } from './SlashCommandPalette'
import { SlashCommandInline } from './SlashCommandInline'

// Chunk I — global state owner for the slash + ⌘K block-picker
// surfaces. Mounts at the EditableMain root (alongside the Chunk H
// ContextMenuProvider) so the picker is reachable from every edit-mode
// surface on the page.
//
// State shape:
//   - 'closed'   — neither surface is open
//   - 'palette'  — ⌘K opened the modal palette (page-end insertion)
//   - 'inline'   — operator typed / inside an empty richtext paragraph;
//                  inline popover anchored at caret coords. Holds the
//                  source block id so insertBlock can run the
//                  replaceSource source-delete after insertion.
//
// Why one provider for both surfaces (instead of a Palette- and an
// Inline-Provider): they're mutually exclusive (you can't have ⌘K open
// while the inline popover is also open — they'd fight for keyboard
// focus + the global Esc listener). Putting both in one state machine
// makes that invariant impossible to violate.
//
// Global keyboard handling:
//   - ⌘K / Ctrl+K → openPalette() (preventDefault so the browser's
//                   Bookmark bar / search bar doesn't claim focus)
//   - Esc          → close() when ANY surface is open
//   - / in empty   → handled by InlineEditable, which calls openInline
//     paragraph     (this provider doesn't listen for / globally —
//                   richtext / vs typed / disambiguation requires the
//                   contenteditable's local state)
//
// Both surfaces internally own their result-row navigation (↑/↓/Enter)
// — the provider only owns surface lifecycle.

export interface SlashCommandInlineAnchor {
  /** Viewport coords of the caret rect at the moment the / fired.
   *  Used by the popover's clamp to position itself near the caret
   *  without overflowing the viewport. */
  coords: { x: number; y: number }
  /** Source block id — the widget the InlineEditable belongs to. When
   *  sourceWidgetIsEmpty is true AND sourceBlockType === 'text', the
   *  insertBlock action soft-deletes this block after the new block
   *  POST succeeds (Notion-style "replace the empty paragraph"). */
  sourceBlockId: number
  /** Source widget kind. The replaceSource gate is sourceBlockType
   *  === 'text' AND sourceWidgetIsEmpty === true. Non-text widgets
   *  never trigger the source-delete (other widgets have richer
   *  schemas — mass-delete would lose data on widgets like Accordion
   *  whose richtext is one field among many). */
  sourceBlockType: string
  /** True when the source widget's ENTIRE textContent is empty
   *  (including any sibling paragraphs / other fields). False when
   *  only the current paragraph is empty but the widget carries
   *  other content. Gating replaceSource on this prevents the
   *  multi-paragraph data-loss case (operator typed "Hello", Enter,
   *  then '/' on the trailing empty paragraph — the source-delete
   *  would otherwise destroy "Hello"). */
  sourceWidgetIsEmpty: boolean
  /** Source widget's page id. Insert lands on the same page. */
  pageId: number
  /** Source block's parent column id, when the source widget lives
   *  inside a column. The new block lands as a sibling of the source
   *  (same parentId) so the operator's spatial expectation holds. */
  parentId: number | null
}

interface SlashCommandState {
  surface: 'closed' | 'palette' | 'inline'
  inline: SlashCommandInlineAnchor | null
  /** When a surface closes, focus restores to this element. Set on
   *  open (palette: document.activeElement at the moment ⌘K fired;
   *  inline: the InlineEditable's contenteditable element). */
  returnFocus: HTMLElement | null
}

const INITIAL: SlashCommandState = {
  surface: 'closed',
  inline: null,
  returnFocus: null,
}

interface SlashCommandContextValue {
  /** Open the modal palette. Page-end insertion via insertBlock. */
  openPalette: () => void
  /** Open the inline popover anchored at the operator's caret. */
  openInline: (anchor: SlashCommandInlineAnchor) => void
  /** Close whichever surface is open. When `restoreFocus` is true
   *  (default — Esc / programmatic close), focus returns to the
   *  element that owned focus when the surface opened. When false
   *  (outside-click close), focus stays where the operator's click
   *  landed — restoring would yank focus away from the new target
   *  and feel like a glitch. */
  close: (opts?: { restoreFocus?: boolean }) => void
  /** Read the current state. Both surface components consume this. */
  state: SlashCommandState
  /** The pageId the provider was mounted with. Used by the palette
   *  (which inserts at page end and has no other context source). */
  pageId: number
}

const SlashCommandContext = createContext<SlashCommandContextValue | null>(
  null,
)

interface ProviderProps {
  pageId: number
  children: ReactNode
}

export function SlashCommandProvider({ pageId, children }: ProviderProps) {
  const [state, setState] = useState<SlashCommandState>(INITIAL)
  // State ref — the global keydown listener reads it WITHOUT going
  // through React's render cycle, so a rapid Esc->reopen doesn't race
  // against React's deferred state propagation.
  //
  // The ref is written from a useEffect (not inline during render).
  // Inline assignment was a concurrent-rendering hazard: React 19's
  // double-invoke + suspense retry can call the render function for a
  // commit that never lands, and the inline assignment would persist
  // a state value React never committed. The effect runs only after
  // commit, so the ref always tracks the committed state. The
  // microsecond gap between commit and effect is irrelevant for a
  // global-keydown listener — keyboard events can't fire faster than
  // React flushes effects.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const openPalette = useCallback(() => {
    const ret = (document.activeElement as HTMLElement | null) ?? null
    setState({ surface: 'palette', inline: null, returnFocus: ret })
  }, [])

  const openInline = useCallback((anchor: SlashCommandInlineAnchor) => {
    const ret = (document.activeElement as HTMLElement | null) ?? null
    setState({ surface: 'inline', inline: anchor, returnFocus: ret })
  }, [])

  const close = useCallback((opts?: { restoreFocus?: boolean }) => {
    // Default: restore focus on Esc / programmatic close. Outside-
    // click closes pass { restoreFocus: false } because the click
    // already chose a new focus target (yanking it back would feel
    // like a glitch).
    const shouldRestore = opts?.restoreFocus !== false
    const prevReturn = stateRef.current.returnFocus
    setState(INITIAL)
    if (!shouldRestore || !prevReturn) return
    // Defer focus restore one frame so React's unmount of the surface
    // has flushed — focusing into an element that's about to unmount
    // would land focus on document.body in Safari.
    //
    // requestAnimationFrame here is preferable to setTimeout(0) — it
    // runs AFTER the paint that removes the surface but BEFORE the
    // next interactive frame, so the operator sees seamless focus
    // continuity.
    requestAnimationFrame(() => {
      try {
        // Verify the target is still in the document. Safari's focus
        // model has shifted across versions; a disconnected node may
        // throw, may silently no-op, or may land focus elsewhere.
        if (!document.contains(prevReturn)) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              '[SlashCommandProvider] focus-restore target disconnected; leaving focus where browser placed it',
            )
          }
          return
        }
        prevReturn.focus()
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            '[SlashCommandProvider] focus-restore failed',
            err,
          )
        }
      }
    })
  }, [])

  // ── Global keyboard listener ──
  // Single document-level keydown listener (attach once on mount,
  // detach on unmount). Reads stateRef directly so a state-bouncing
  // gesture (open → close → open in rapid succession) doesn't race
  // against a stale closure.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K — toggle palette. Both modifiers accepted; Mac
      // operators are used to ⌘K, Linux/Windows use Ctrl+K. Notion +
      // Linear + Raycast all accept both.
      //
      // preventDefault always (the browser's ⌘K shortcut focuses the
      // URL bar in Firefox; we always want to keep focus in-app when
      // edit mode is on). stopPropagation is CONDITIONAL on the
      // gesture being a state-changing one — if a future surface
      // outside edit mode wants its own ⌘K, leaving the capture-
      // phase swallow off the no-op path lets that surface coexist.
      const isToggleKey =
        (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')
      if (isToggleKey) {
        e.preventDefault()
        const curr = stateRef.current.surface
        if (curr === 'closed') {
          e.stopPropagation()
          openPalette()
        } else {
          e.stopPropagation()
          // Already open — ⌘K toggles closed. Matches the prior-art
          // (Linear toggles, Raycast hides + reopens to the global
          // root). Programmatic close (restore focus).
          close()
        }
        return
      }
      // Esc — close whichever surface is open. Suppress further
      // propagation so an underlying contenteditable doesn't ALSO
      // process the Esc (which would, e.g., revert an inline edit).
      if (e.key === 'Escape' && stateRef.current.surface !== 'closed') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
    }
    // Capture phase so we beat the InlineEditable's onKeyDown handler
    // for Esc — without capture, Esc inside a focused contenteditable
    // would revert the inline edit BEFORE this listener saw it, leaving
    // the popover open. Cleanup matches the same capture flag (the
    // capture flag is part of the listener identity for removal).
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [openPalette, close])

  const value = useMemo<SlashCommandContextValue>(
    () => ({ openPalette, openInline, close, state, pageId }),
    [openPalette, openInline, close, state, pageId],
  )

  return (
    <SlashCommandContext.Provider value={value}>
      {children}
      {/* Both surfaces are conditionally rendered inside the provider
          so they can read context via the same hook the consumer
          surfaces (InlineEditable + global ⌘K) use to open them. */}
      {state.surface === 'palette' && <SlashCommandPalette />}
      {state.surface === 'inline' && state.inline && (
        <SlashCommandInline anchor={state.inline} />
      )}
    </SlashCommandContext.Provider>
  )
}

const PROD = process.env.NODE_ENV === 'production'

// Placeholder context value for the non-editable mount path. The
// InlineEditable in non-edit-mode never reaches the / detection
// (gated on canEdit), but the hook is still imported — returning a
// no-op value keeps the bundle simple while making misuse obvious in
// dev.
const PLACEHOLDER_VALUE: SlashCommandContextValue = {
  openPalette: () => {
    /* placeholder — outside provider */
  },
  openInline: () => {
    /* placeholder — outside provider */
  },
  close: (_opts?: { restoreFocus?: boolean }) => {
    /* placeholder — outside provider */
    void _opts
  },
  state: INITIAL,
  pageId: -1,
}

let warnedOutsideProvider = false

export function useSlashCommand(): SlashCommandContextValue {
  const v = useContext(SlashCommandContext)
  if (v === null) {
    if (!PROD) {
      // Dev throws so misplaced consumers (a regression mounting an
      // InlineEditable outside the EditableMain provider chain)
      // surface fast.
      throw new Error(
        'useSlashCommand called outside SlashCommandProvider — wrap the consumer in EditableMain’s provider chain.',
      )
    }
    if (!warnedOutsideProvider) {
      warnedOutsideProvider = true
      console.warn(
        '[SlashCommandProvider] useSlashCommand outside provider — palette / inline picker will not open.',
      )
    }
    return PLACEHOLDER_VALUE
  }
  return v
}
