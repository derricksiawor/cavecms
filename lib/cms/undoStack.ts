// Chunk J — undo/redo command stack (pure data layer).
//
// Industry survey informing this design (embedded as commentary so the
// design constraints don't drift away from their rationale):
//
//   Notion       — discrete block ops, ~15-20 entries, in-memory only,
//                  wiped on reload, separate page-history layer for
//                  long-tail recovery.
//   Webflow      — unlimited session stack, in-memory, server-side
//                  Backups as long-tail layer, visible History panel
//                  letting operator click into any past action.
//   Wix          — unlimited session stack, in-memory, server-side
//                  Site History layer.
//   Figma        — unlimited session stack, in-memory, server-side
//                  Version History layer.
//   Google Docs  — large bounded session stack, in-memory, server-side
//                  Version History layer, canonical "snackbar with
//                  inline Undo" pattern after destructive actions.
//
// Common shape: in-memory linear stack per session, server-side history
// as a separate concern. V1 here matches that shape. Phase 2 could
// extend the existing audit log (Chunk B) into a Webflow-style History
// panel — out of scope for this chunk.
//
// Stack model
// ───────────
//   commands : Command[]            // most recent at tail
//   cursor   : number               // index of the LAST COMPLETED command (-1 = empty)
//
//   undo     : run commands[cursor].inverse; cursor -= 1
//   redo     : cursor += 1; run commands[cursor].forward
//   push     : truncate commands[cursor+1..]; push new; cursor = newLength-1
//   cap      : keep at most STACK_LIMIT; oldest drops off the head AND
//              cursor stays bound to the last command (does NOT slide
//              back into the trimmed region).
//
// Design choices
// ──────────────
//   • Pure value layer. Stack is plain immutable arrays — no immer, no
//     zundo, no third-party undo lib. This file MUST stay free of React
//     / DOM / fetch. The executor (UndoRedoController.tsx) layers HTTP
//     + dispatch on top.
//   • Cap is 50 entries. With each command bounded at ~50 KB of captured
//     data (a section-with-children delete is the heaviest case), worst-
//     case stack memory ≈ 2.5 MB — acceptable in-tab.
//   • Cursor is the LAST COMPLETED command, not the next-to-execute.
//     This makes the "empty" state cursor === -1 and avoids the
//     off-by-one trap when push happens at cursor === commands.length-1.
//   • applyExec mutates a command's inverse target ID after redo so the
//     subsequent undo targets the FRESH id (re-creating an add yields a
//     different id every time; the inverse needs to chase that id).
//
// Tests for this layer live in tests/unit/undoStack.test.ts.

export const STACK_LIMIT = 50

/** Verbs covered by the undo system. Each verb's inverse is a counter-
 *  verb that runs through the same authoritative server boundary as the
 *  forward action — server-side authz + validation re-run on every
 *  undo / redo. */
export type CommandKind =
  | 'add'
  | 'delete-widget'
  | 'delete-container'
  | 'edit-data'
  | 'edit-meta'
  | 'reorder'
  | 'duplicate'
  | 'paste'
  | 'instantiate-template'

/** A single HTTP descriptor that the executor can fan out via csrfFetch.
 *  `expects` is the response status the executor treats as success
 *  (everything else surfaces as an undo failure → toast + stack
 *  discard). The executor is free to read the JSON body and call
 *  `onExecuted` to rebind ids. */
export interface HttpStep {
  method: 'POST' | 'PATCH' | 'DELETE'
  /** URL path (already CSRF-resolved at execution time). */
  path: string
  body?: Record<string, unknown>
  /** Acceptable 2xx code. Anything else is treated as failure. */
  expects: number
}

/** A command on the stack. Forward and inverse are HTTP descriptors;
 *  the executor wires them through csrfFetch. The captures map holds
 *  the values the inverse needs (prior data, prior versions, captured
 *  ids) so the inverse can be rebuilt freshly each time (versions
 *  advance per round-trip — see edit-data / edit-meta).
 *
 *  `label` is the operator-facing string for the success toast ("Added
 *  Heading", "Deleted section"). The toast layer references it.
 *
 *  Commands are MUTABLE at runtime: applyExec rebinds the inverse's
 *  captured id after a redo so the next undo targets the freshly-
 *  created id (see applyExec docstring).
 */
export interface Command {
  kind: CommandKind
  label: string
  timestamp: number
  forward: HttpStep
  inverse: HttpStep
  /** Free-form bag the executor uses to recompute step bodies after a
   *  redo. e.g. { newBlockId: 42 } gets overwritten by applyExec after
   *  the redo's POST response yields a fresh id. */
  captures: Record<string, unknown>
}

export interface UndoStackState {
  commands: Command[]
  cursor: number
}

export const EMPTY_STACK: UndoStackState = Object.freeze({
  commands: [],
  cursor: -1,
})

/** Push a new command at cursor+1 and truncate any commands beyond.
 *  Caps the stack at STACK_LIMIT — when capacity exceeded, the oldest
 *  command drops off the HEAD (and cursor stays at the new tail). */
export function push(
  state: UndoStackState,
  command: Command,
): UndoStackState {
  // Truncate the redo portion. After a new mutation, the operator's
  // intent is "this is the new tip" — any redo history beyond cursor
  // is discarded. Matches every text editor and visual editor in the
  // industry survey above (Notion / Wix / Figma / Webflow / Docs).
  const kept = state.commands.slice(0, state.cursor + 1)
  kept.push(command)
  // Cap at STACK_LIMIT entries. Drop from the head (oldest first).
  const trimmed =
    kept.length > STACK_LIMIT
      ? kept.slice(kept.length - STACK_LIMIT)
      : kept
  return { commands: trimmed, cursor: trimmed.length - 1 }
}

/** Return the command that ⌘Z should run (or null when nothing to undo).
 *  The command itself is NOT removed — that happens on `applyUndo`. */
export function peekUndo(state: UndoStackState): Command | null {
  if (state.cursor < 0) return null
  return state.commands[state.cursor] ?? null
}

/** Return the command ⇧⌘Z should run (or null when nothing to redo).
 *  Same not-removed semantic as peekUndo. */
export function peekRedo(state: UndoStackState): Command | null {
  const idx = state.cursor + 1
  if (idx >= state.commands.length) return null
  return state.commands[idx] ?? null
}

/** Commit the undo — move cursor back by one. Called by the executor
 *  AFTER the inverse HTTP step succeeds. Server-side failure should
 *  NOT call this (the stack stays where it was so the operator can
 *  retry). */
export function applyUndo(state: UndoStackState): UndoStackState {
  if (state.cursor < 0) return state
  return { commands: state.commands, cursor: state.cursor - 1 }
}

/** Commit the redo — move cursor forward by one. Same success-only
 *  semantic as applyUndo. */
export function applyRedo(state: UndoStackState): UndoStackState {
  if (state.cursor + 1 >= state.commands.length) return state
  return { commands: state.commands, cursor: state.cursor + 1 }
}

/** Rebind the captures bag on the command at `index` so the NEXT
 *  invocation of either side picks up the fresh ids/versions. Called
 *  by the executor after a forward or inverse step yields response
 *  data the next-side will need (e.g. a redo of add returns a new id
 *  that the subsequent undo's DELETE path needs).
 *
 *  Returns a new state with the mutated command — the array reference
 *  changes so React useReducer picks it up. */
export function applyExec(
  state: UndoStackState,
  index: number,
  patch: {
    captures?: Record<string, unknown>
    forward?: Partial<HttpStep>
    inverse?: Partial<HttpStep>
  },
): UndoStackState {
  if (index < 0 || index >= state.commands.length) return state
  const cur = state.commands[index]!
  const next: Command = {
    ...cur,
    captures: patch.captures ? { ...cur.captures, ...patch.captures } : cur.captures,
    forward: patch.forward ? { ...cur.forward, ...patch.forward } : cur.forward,
    inverse: patch.inverse ? { ...cur.inverse, ...patch.inverse } : cur.inverse,
  }
  const commands = state.commands.slice()
  commands[index] = next
  return { commands, cursor: state.cursor }
}

/** Wipe the stack. Called on page reload / navigation away — matches
 *  Notion / Wix / Figma session-only semantics from the industry
 *  survey above. Long-tail recovery is the server-side audit log
 *  (Chunk B), not this stack. */
export function clear(_state: UndoStackState): UndoStackState {
  return EMPTY_STACK
}

/** True when ⌘Z would do something. */
export function canUndo(state: UndoStackState): boolean {
  return state.cursor >= 0
}

/** True when ⇧⌘Z would do something. */
export function canRedo(state: UndoStackState): boolean {
  return state.cursor + 1 < state.commands.length
}
