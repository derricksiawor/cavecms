// In-memory clipboard for the editor's right-click context menu (Chunk H).
//
// NO `server-only` import — the module is consumed by both the client
// provider (InlineEditContext slot, ContextMenu paste handlers) and the
// server boundary (paste endpoint re-validates the slot's payload through
// the same parseBlockData / SectionMetaSchema / ColumnMetaSchema / Zod
// gates a fresh POST goes through, so a tampered slot can't smuggle
// invalid data past the wire).
//
// In-memory ONLY. Survives same-session navigation; dies on hard refresh.
// No navigator.clipboard.write — that path would (a) require permission
// prompts in Safari + Firefox, (b) pollute the OS clipboard so an
// operator's "copy section" gesture overwrites their last text-copy on
// the system pasteboard, (c) introduce a cross-origin attack surface
// where a malicious page could later read the serialised tree. The
// trade-off is no cross-tab paste in V1 — acceptable; admin workflow is
// single-tab, and BroadcastChannel can land as a Phase 2 enhancement
// without changing this contract.
//
// Versioned so a future addition of new widget meta fields (or a new
// BlockKind like 'row') can bump CLIPBOARD_SCHEMA_VERSION and the
// `canPaste` predicate returns false for older slots in-flight from a
// pre-deploy session — no silent partial paste, no crash on missing
// fields. The version field is also useful for cross-tab clipboard via
// BroadcastChannel later (each tab can refuse incompatible payloads).
//
// TRUST BOUNDARY: the version check on canPaste() is a UX gate that
// blocks the paste BEFORE the network call when the schema is known
// to have shifted. The SECURITY gate is the server's parseAndSanitize
// + SectionMetaSchema / ColumnMetaSchema / WidgetMetaSchema parse on
// POST /api/cms/blocks — a tampered slot with javascript: URIs,
// malformed media_ids, or any other XSS / SSRF / DoS payload fails
// closed there, regardless of what canPaste returned client-side.
// Never use this module's predicate as a security boundary.

import type { BlockKind } from './blockMeta'

// V2 bump: section slots now carry the full subtree (columns + widgets).
// V1 slots (subtree-less) in-flight from a prior session are refused by
// canPaste because they fail the version check — operators are NOT
// silently fed a stale section-paste that drops widget content. The
// schema bump is the operator-visible contract for the gap.
export const CLIPBOARD_SCHEMA_VERSION = 2 as const
export type ClipboardSchemaVersion = typeof CLIPBOARD_SCHEMA_VERSION

/** Atomic widget payload — leaf in the clipboard tree. */
export interface ClipboardWidget {
  blockType: string
  data: unknown
  meta: unknown
}

/** Column payload — meta blob plus an ordered widget array. The
 *  widget array is ordered by source position so the paste replay
 *  inserts in the same visual sequence. */
export interface ClipboardColumn {
  meta: unknown
  widgets: ClipboardWidget[]
}

/** Top-level clipboard slot. Discriminated on `kind` so consumers narrow
 *  the payload shape correctly when handling paste.
 *
 *  V2: section slots carry their FULL subtree (columns + widgets) in
 *  `columns[]`. The paste handler chains POST /api/cms/blocks calls
 *  sequentially — section first, then each column under it, then
 *  each widget under each column. An empty `columns` array is still
 *  legal (paste = an empty section, same as V1) but the section copy
 *  path always captures the live subtree when state is reachable. */
export type ClipboardSlot =
  | {
      version: ClipboardSchemaVersion
      kind: 'section'
      meta: unknown
      columns: ClipboardColumn[]
      /** Total widget count across the captured subtree. Surfaced in
       *  the copy toast ("Section with N items copied.") so the
       *  operator confirms the structure they actually copied. */
      widgetCount: number
      /** Wall-clock ms of the copy gesture. Available for future "Copied
       *  2 min ago" hints; never round-trips to the server. */
      copiedAt: number
    }
  | {
      version: ClipboardSchemaVersion
      kind: 'column'
      meta: unknown
      widgets: ClipboardWidget[]
      copiedAt: number
    }
  | {
      version: ClipboardSchemaVersion
      kind: 'widget'
      blockType: string
      data: unknown
      meta: unknown
      copiedAt: number
    }

/** Right-click target context for a paste gesture. */
export type PasteTargetKind = BlockKind

/**
 * Compatibility predicate for the menu's disabled() check + the paste
 * handler's early-exit gate. Returns true iff the slot is paste-able at
 * the given target context.
 *
 * Matrix (V1 menu spec — Chunk H):
 *
 *   target  →  section     column     widget
 *   source  ↓
 *   section     ✓ (after)   ✗          ✗
 *   column      ✗           ✗          ✗      ← V1: no paste path for columns
 *   widget      ✗           ✓ (into)   ✓ (after)
 *
 * The "no V1 column paste" gap is intentional: the Column menu lists
 * Copy but neither Section.Paste nor Column.Paste accepts a column
 * (pasting a column into a column is structurally nonsensical, and
 * pasting a column into a section would require a section-level
 * "Paste column here" action that V1 doesn't ship). A future chunk
 * can add the section-level option without changing this predicate's
 * matrix shape.
 *
 * Null slot AND schema-version mismatch BOTH return false — a stale
 * in-memory slot from before a deploy that bumps the version gets
 * rejected here rather than fed into a downstream POST that would
 * parse-fail at the server boundary anyway.
 */
export function canPaste(
  slot: ClipboardSlot | null,
  target: PasteTargetKind,
): boolean {
  if (!slot) return false
  if (slot.version !== CLIPBOARD_SCHEMA_VERSION) return false
  if (target === 'section') return slot.kind === 'section'
  if (target === 'column') return slot.kind === 'widget'
  if (target === 'widget') return slot.kind === 'widget'
  return false
}
