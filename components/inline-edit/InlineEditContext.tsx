'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { csrfFetch } from '@/lib/client/csrf'
import { safeStorage } from '@/lib/client/safeStorage'
import { assertNever } from '@/lib/typeUtils'
import type { HydratedBlock } from '@/lib/cms/hydrate'
import { CLIPBOARD_SCHEMA_VERSION, type ClipboardSlot } from '@/lib/cms/clipboard'
import { SEED_DATA, type SeedBlockType } from '@/lib/cms/blockSeeds'
import {
  isSectionSurfaceDark,
  lightToneFor,
  type SectionMeta,
} from '@/lib/cms/blockMeta'
// Chunk J — useInsertBlock records an ADD command on the undo stack
// + surfaces a success toast with an inline Undo button. Imports go
// through the sibling providers (UndoStackProvider, Toast) mounted in
// EditableMain.
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import { useToast } from './Toast'

// Chunk B: page-scoped optimistic UI state for the edit-mode shell.
//
// Server state (server-rendered HydratedBlock[]) is the source of
// truth. The client mirrors it here so:
//
//   1. DnD reorders can mutate the tree BEFORE the server confirms,
//      eliminating the brief "old → new" flicker that landed on every
//      `router.refresh` round-trip in Chunks A→D.
//   2. EditDrawer can push a preview overlay (background swap, padding
//      change, etc.) into the tree without waiting for save — the
//      operator sees the section CSS flip the instant they pick a
//      swatch.
//   3. InlineEditable can drop its local (blockVersion, pageVersion)
//      state and let the context track the per-block version cursor
//      so a fast-typist's sequential saves don't 409 on each other.
//
// Server boundary is unchanged. parseAndSanitize at PATCH /api/cms/
// blocks/[id] stays authoritative. The optimistic state is UI-only;
// 409 / 422 always re-snapshot from the server.
//
// State is split into TWO contexts (StateContext + DispatchContext)
// so consumers that only call dispatch don't re-render on every state
// change. Standard React pattern.

export interface InlineEditState {
  /** Server-rendered tree as last reconciled. Mutated optimistically by
   *  apply-move and block-saved actions; reset to authoritative server
   *  state via 'snapshot'. */
  blocks: HydratedBlock[]
  /** Page-level optimistic-lock token. Bumped by PATCH success
   *  (widget save + container meta save). Reorder doesn't bump
   *  pages.version, so this stays put across DnD operations. */
  pageVersion: number
  /** Per-block live preview overlay pushed by the EditDrawer when the
   *  operator tweaks a field. Cleared on save success or discard. The
   *  overlay shape mirrors `block.data` for widgets and `block.meta`
   *  for containers; consumers shallow-merge it on top of the
   *  block's persisted shape. */
  previews: Map<number, Record<string, unknown>>
  /** Per-block version overrides set after a successful save. Lets
   *  child components (InlineEditable, EditDrawer) see the freshest
   *  (blockVersion, pageVersion) without waiting for a router refresh.
   *  Pruned when the snapshot effect detects the server has caught
   *  up. */
  versionOverrides: Map<number, { blockVersion: number; pageVersion: number }>
  /** Chunk H — in-memory clipboard for the right-click context menu's
   *  Copy / Paste actions. Survives within the React session (page
   *  navigations preserve it); a hard refresh drops it. No system-
   *  clipboard write — see lib/cms/clipboard.ts for the trade-off
   *  rationale. */
  clipboard: ClipboardSlot | null
}

export type InlineEditAction =
  // Server-driven reset. Fired by the reconciliation effect when the
  // server-rendered props advance, and by the DnD shell to roll back
  // a failed move (caller passes the pre-move snapshot).
  | { type: 'snapshot'; blocks: HydratedBlock[]; pageVersion: number }
  // Optimistic DnD reorder. Caller has already computed the post-move
  // ordering for source + destination parents. The reducer reparents
  // and assigns 1000-spaced positions matching the server's tie-break.
  | {
      type: 'apply-move'
      sourceParent: number | null
      sourceOrder: number[]
      destParent: number | null
      destOrder: number[]
    }
  // Widget save success. Replaces data + version on the matched block,
  // bumps pageVersion, sets a version override so any sibling
  // InlineEditable on this block sees the new cursor, and clears any
  // preview overlay since the persisted shape now matches. When the
  // matched block is NOT in state.blocks (deleted by a peer between
  // dispatch and reduce), the reducer leaves pageVersion +
  // versionOverrides untouched to avoid contaminating live cursors
  // with a ghost block's response.
  | {
      type: 'block-saved'
      blockId: number
      data: Record<string, unknown>
      blockVersion: number
      pageVersion: number
    }
  // Container meta save success. Same as block-saved but writes to
  // block.meta instead of block.data. Same ghost-block guard.
  | {
      type: 'block-meta-saved'
      blockId: number
      meta: unknown
      blockVersion: number
      pageVersion: number
    }
  // Drawer live-preview overlay push (no server roundtrip). Caller
  // MUST pass a plain Record<string, unknown> with no reserved keys
  // (__proto__, constructor, prototype) — the reducer strips them
  // defensively but the contract is "preview overlays are plain data".
  | { type: 'set-preview'; blockId: number; data: Record<string, unknown> }
  | { type: 'clear-preview'; blockId: number }
  // Direct per-block (blockVersion, pageVersion) override.
  //
  // EXCLUSIVELY used by the reorder success path (POST
  // /api/cms/blocks/reorder bumps content_blocks.version per row but
  // does NOT bump pages.version). The reducer intentionally does NOT
  // mutate state.pageVersion for this action — the pageVersion field
  // on the action is stored on the override so useEffectiveVersions
  // can carry it forward via Math.max against the live page cursor,
  // but the global cursor stays put.
  //
  // Do NOT dispatch this from widget-save / meta-save paths — those
  // must use block-saved / block-meta-saved which DO bump the page
  // cursor. Misuse would silently drift the page-level optimistic
  // lock.
  | {
      type: 'set-versions'
      blockId: number
      blockVersion: number
      pageVersion: number
    }
  // Chunk H — write the clipboard slot. Replaces the entire slot (the
  // clipboard holds a SINGLE most-recent copy gesture — there is no
  // history / stack in V1). Passing `slot: null` is invalid; use
  // 'clipboard:clear' to wipe.
  | { type: 'clipboard:set'; slot: ClipboardSlot }
  // Chunk H — wipe the clipboard slot. Currently unused by chunk-H
  // surfaces (operators don't need to clear, and a stale slot stays
  // valid until version gate or refresh), but exposed for future
  // "Cancel"-style affordances + completeness with set.
  | { type: 'clipboard:clear' }

const StateContext = createContext<InlineEditState | null>(null)
const DispatchContext = createContext<Dispatch<InlineEditAction> | null>(null)

// ── Clipboard persistence (cross-refresh + cross-page) ───────────────
//
// Pre-fix, the clipboard slot was React state only. It survived SPA
// navigation (the provider remounts but `useReducer` initializer can
// read storage), and died on hard refresh. Operators paste-after-
// refresh is a common workflow — restoring the slot from localStorage
// closes the gap.
//
// Single key, no pageId scoping: Webflow precedent allows pasting
// between pages, and the clipboard slot carries `kind` + block payload
// which is page-agnostic. Scoping per-page would also fragment storage
// (an admin who copied on /home and refreshed to /about would lose the
// slot for no good reason).
//
// TTL: 7 days. A slot older than that is dropped on hydrate so a
// session resumed weeks later doesn't paste stale content. The TTL is
// enforced ONLY on read — a slot that's already in-state is preserved
// until the operator overwrites or clears it (an in-progress 8-day
// session is implausible, and forcibly clearing live state would be a
// worse UX than the very-rare ageing).
//
// Schema version gate: persisted slots carry the same
// CLIPBOARD_SCHEMA_VERSION as the in-memory shape. A version bump in
// lib/cms/clipboard.ts invalidates older persisted slots — older slots
// fail the gate and are dropped silently rather than crashing the
// provider during hydrate.
// Single key, no userId scope: the editor doesn't have direct access to
// the session userId at this layer of the tree (provider props chain
// would need to thread it through EditableMain). Defence-in-depth is
// handled by the logout flow: AdminBarInteractive.signOut explicitly
// wipes this key BEFORE the hard navigation, so editor B logging in
// on the same browser after editor A logged out doesn't inherit A's
// clipboard slot. See components/admin-bar/AdminBarInteractive.tsx.
export const CLIPBOARD_STORAGE_KEY = 'bwc:clipboard'
const CLIPBOARD_TTL_MS = 7 * 24 * 60 * 60 * 1000

function isClipboardSlotShape(value: unknown): value is ClipboardSlot {
  // Hand-rolled type guard — no Zod here to avoid pulling a runtime
  // schema into the editor bundle for a single read path. The server
  // re-validates the slot via parseAndSanitize + Section/Column/Widget
  // MetaSchema on the paste-POST, so this gate is purely a UX shield
  // against a corrupt localStorage entry crashing the provider mount.
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.version !== CLIPBOARD_SCHEMA_VERSION) return false
  if (typeof v.copiedAt !== 'number' || !Number.isFinite(v.copiedAt)) {
    return false
  }
  if (v.kind === 'section') {
    return Array.isArray(v.columns)
  }
  if (v.kind === 'column') {
    return Array.isArray(v.widgets)
  }
  if (v.kind === 'widget') {
    return typeof v.blockType === 'string'
  }
  return false
}

function readPersistedClipboard(): ClipboardSlot | null {
  const raw = safeStorage.get(CLIPBOARD_STORAGE_KEY)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt entry — drop it so a future write isn't blocked by a
    // poisoned key. Defence-in-depth against a manual edit / quota
    // truncation.
    safeStorage.remove(CLIPBOARD_STORAGE_KEY)
    return null
  }
  if (!isClipboardSlotShape(parsed)) {
    safeStorage.remove(CLIPBOARD_STORAGE_KEY)
    return null
  }
  if (Date.now() - parsed.copiedAt > CLIPBOARD_TTL_MS) {
    safeStorage.remove(CLIPBOARD_STORAGE_KEY)
    return null
  }
  return parsed
}

function initialState(
  blocks: HydratedBlock[],
  pageVersion: number,
): InlineEditState {
  return {
    blocks,
    pageVersion,
    previews: new Map(),
    versionOverrides: new Map(),
    // Clipboard starts null. Hydration from localStorage runs in a
    // client-only useEffect inside InlineEditProvider so server-render
    // and first client-render produce the same DOM (any clipboard-
    // consuming surface — context menu paste-disabled gate, future
    // "Paste available" hints — sees null until after first paint,
    // matching SSR output, no hydration mismatch).
    clipboard: null,
  }
}

function reducer(
  state: InlineEditState,
  action: InlineEditAction,
): InlineEditState {
  switch (action.type) {
    case 'snapshot': {
      // Dedup: identical inputs return current state so downstream
      // useMemo / React.memo consumers don't churn on no-op renders.
      if (
        state.blocks === action.blocks &&
        state.pageVersion === action.pageVersion
      ) {
        return state
      }
      // Prune previews whose block no longer exists in the new tree
      // (operator deleted the block elsewhere; preview is
      // meaningless). Other previews are preserved — operator's
      // in-flight edit on block A doesn't get dropped when block B's
      // server state advances.
      const liveIds = new Set(action.blocks.map((b) => b.id))
      let prunedPreviews: Map<number, Record<string, unknown>> =
        state.previews
      if (state.previews.size > 0) {
        prunedPreviews = new Map()
        for (const [id, data] of state.previews) {
          if (liveIds.has(id)) prunedPreviews.set(id, data)
        }
      }
      // Prune version overrides the server has caught up to. If the
      // server-side block.version >= override.blockVersion, the server
      // is now authoritative and the override is stale.
      let prunedOverrides = state.versionOverrides
      if (state.versionOverrides.size > 0) {
        const blockById = new Map(action.blocks.map((b) => [b.id, b]))
        prunedOverrides = new Map()
        for (const [id, v] of state.versionOverrides) {
          const live = blockById.get(id)
          // Keep the override only when the server still trails it AND
          // the block still exists. A vanished block drops its override.
          if (live && live.version < v.blockVersion) {
            prunedOverrides.set(id, v)
          }
        }
      }
      // Preserve optimistic position/parentId for any block whose
      // `versionOverride.blockVersion` is FRESHER than the incoming
      // snapshot's block.version. This guards the DnD race: an
      // operator drops; the optimistic context advances; mid-flight
      // a sibling block save triggers a router.refresh that loads
      // a SSR-render-from-cache snapshot from BEFORE the reorder
      // committed. Without this preservation, the snapshot reverts
      // the moved block to its pre-drop position for one paint frame
      // before the next refresh brings the post-commit positions
      // back — visible as a jump-back. Operator-perceptible glitch.
      let mergedBlocks = action.blocks
      if (state.versionOverrides.size > 0) {
        let needsMerge = false
        const overrides = state.versionOverrides
        for (const b of action.blocks) {
          const ov = overrides.get(b.id)
          if (ov && ov.blockVersion > b.version) {
            needsMerge = true
            break
          }
        }
        if (needsMerge) {
          const liveById = new Map(state.blocks.map((b) => [b.id, b]))
          mergedBlocks = action.blocks.map((b) => {
            const ov = overrides.get(b.id)
            if (ov && ov.blockVersion > b.version) {
              const optimistic = liveById.get(b.id)
              if (optimistic) {
                return {
                  ...b,
                  parentId: optimistic.parentId,
                  position: optimistic.position,
                }
              }
            }
            return b
          })
        }
      }
      return {
        blocks: mergedBlocks,
        pageVersion: action.pageVersion,
        previews: prunedPreviews,
        versionOverrides: prunedOverrides,
        // Clipboard is operator-driven session state, not server state.
        // A snapshot from the server (router.refresh, 409 recovery) must
        // PRESERVE the clipboard slot — it would be surprising for a
        // sibling save's snapshot to wipe an in-progress Copy.
        clipboard: state.clipboard,
      }
    }
    case 'apply-move': {
      // Build a quick lookup of (id → new parent + new position).
      // Server semantics: positions are 1000-spaced within each
      // resolved-parent bucket, assigned by the submission order.
      const next = new Map<
        number,
        { parentId: number | null; position: number }
      >()
      const assign = (parent: number | null, order: number[]) => {
        order.forEach((id, idx) => {
          next.set(id, { parentId: parent, position: (idx + 1) * 1000 })
        })
      }
      assign(action.sourceParent, action.sourceOrder)
      if (action.destParent !== action.sourceParent) {
        assign(action.destParent, action.destOrder)
      }
      if (next.size === 0) return state
      let changed = false
      const updated = state.blocks.map((b) => {
        const u = next.get(b.id)
        if (!u) return b
        if (b.parentId === u.parentId && b.position === u.position) return b
        changed = true
        return { ...b, parentId: u.parentId, position: u.position }
      })
      if (!changed) return state
      return { ...state, blocks: updated }
    }
    case 'block-saved': {
      let changed = false
      const updated = state.blocks.map((b) => {
        if (b.id !== action.blockId) return b
        changed = true
        return {
          ...b,
          data: action.data as typeof b.data,
          version: action.blockVersion,
        }
      })
      if (!changed) {
        // Ghost-block guard: the dispatch's blockId is no longer in
        // state.blocks (a concurrent delete + snapshot dropped it
        // between save dispatch and reduce). Do NOT contaminate
        // state.pageVersion or versionOverrides with the ghost's
        // server response — a later save on a LIVING block would
        // then send the ghost's pageVersion and 409 against the
        // server's live page cursor.
        const previewsAlready = state.previews
        if (!previewsAlready.has(action.blockId)) return state
        const previews = new Map(previewsAlready)
        previews.delete(action.blockId)
        return { ...state, previews }
      }
      const previews = new Map(state.previews)
      previews.delete(action.blockId)
      const versionOverrides = new Map(state.versionOverrides)
      versionOverrides.set(action.blockId, {
        blockVersion: action.blockVersion,
        pageVersion: action.pageVersion,
      })
      return {
        blocks: updated,
        pageVersion: action.pageVersion,
        previews,
        versionOverrides,
        clipboard: state.clipboard,
      }
    }
    case 'block-meta-saved': {
      let changed = false
      const updated = state.blocks.map((b) => {
        if (b.id !== action.blockId) return b
        changed = true
        return {
          ...b,
          meta: action.meta,
          version: action.blockVersion,
        }
      })
      if (!changed) {
        // Same ghost-block guard as block-saved above.
        const previewsAlready = state.previews
        if (!previewsAlready.has(action.blockId)) return state
        const previews = new Map(previewsAlready)
        previews.delete(action.blockId)
        return { ...state, previews }
      }
      const previews = new Map(state.previews)
      previews.delete(action.blockId)
      const versionOverrides = new Map(state.versionOverrides)
      versionOverrides.set(action.blockId, {
        blockVersion: action.blockVersion,
        pageVersion: action.pageVersion,
      })
      return {
        blocks: updated,
        pageVersion: action.pageVersion,
        previews,
        versionOverrides,
        clipboard: state.clipboard,
      }
    }
    case 'set-preview': {
      // Defensive strip of prototype-pollution keys. Operator-driven
      // form fields can't typically produce these, but a malicious
      // browser extension dispatching set-preview with `__proto__`
      // would otherwise pollute every subsequent object spread that
      // consumes `effectivePreview` (useEffectivePreview /
      // useEffectiveBlockMeta both spread `{ ...fallback, ...preview }`).
      // The strip is shallow — nested objects on future preview shapes
      // would need a recursive walker. Today every preview payload is
      // a flat map of scalars so this is sufficient.
      const safe: Record<string, unknown> = {}
      for (const k of Object.keys(action.data)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          continue
        }
        safe[k] = action.data[k]
      }
      // Chunk E: MERGE semantics, not REPLACE. The EditDrawer pushes
      // its form-shaped preview on each keystroke (background/columns/
      // width/data fields); the SpacingToolbar pushes its spacing-shaped
      // preview on each stepper click. The two surfaces must coexist —
      // a REPLACE-only reducer would wipe whichever surface dispatched
      // last. Each surface is the source of truth ONLY for the keys it
      // manages, so a later dispatch with the same key wins (e.g. the
      // drawer re-pushes its full form on every keystroke so a stale
      // toolbar-side spacing key gets overwritten when the operator
      // changes background — which is correct: the drawer's commit
      // doesn't carry spacing, but the toolbar's next dispatch will).
      const previews = new Map(state.previews)
      const existing = previews.get(action.blockId)
      previews.set(action.blockId, existing ? { ...existing, ...safe } : safe)
      return { ...state, previews }
    }
    case 'clear-preview': {
      if (!state.previews.has(action.blockId)) return state
      const previews = new Map(state.previews)
      previews.delete(action.blockId)
      return { ...state, previews }
    }
    case 'set-versions': {
      // Per-block override AND opportunistic page-cursor advance.
      //
      // Reorder responses now carry the bumped pages.version (the
      // route was changed to bump pages.version in the same TX so
      // concurrent peer saves don't 409 on stale_page_version). When
      // the incoming pageVersion is HIGHER than the live state cursor,
      // we advance it — non-reordered widgets on the page would
      // otherwise carry the stale cursor until router.refresh
      // round-trips. Math.max ensures we never regress the cursor on
      // a late-arriving stale dispatch.
      const versionOverrides = new Map(state.versionOverrides)
      versionOverrides.set(action.blockId, {
        blockVersion: action.blockVersion,
        pageVersion: action.pageVersion,
      })
      const nextPageVersion =
        action.pageVersion > state.pageVersion
          ? action.pageVersion
          : state.pageVersion
      return { ...state, versionOverrides, pageVersion: nextPageVersion }
    }
    case 'clipboard:set': {
      // Defence-in-depth: refuse a null slot. The action type's body
      // field is ClipboardSlot (non-nullable) — TypeScript prevents the
      // mistake at compile time, but a forged dispatch via React
      // DevTools or a runtime bug could still land here. In production
      // we silently no-op (refusing to wipe). In development we throw
      // so the bug surfaces — clipboard:clear is the explicit path.
      if (!action.slot) {
        if (process.env.NODE_ENV !== 'production') {
          throw new Error(
            "clipboard:set dispatched with null slot — use 'clipboard:clear' instead.",
          )
        }
        return state
      }
      return { ...state, clipboard: action.slot }
    }
    case 'clipboard:clear': {
      if (state.clipboard === null) return state
      return { ...state, clipboard: null }
    }
    default:
      // Exhaustiveness gate — adding a new Action variant without a
      // matching `case` lands as a TS compile error here. Without it
      // a missed variant would silently fall through, return undefined,
      // and corrupt the reducer's state shape downstream.
      return assertNever(action)
  }
}

interface ProviderProps {
  initialBlocks: HydratedBlock[]
  initialPageVersion: number
  children: ReactNode
}

export function InlineEditProvider({
  initialBlocks,
  initialPageVersion,
  children,
}: ProviderProps) {
  const [state, dispatch] = useReducer(
    reducer,
    null,
    () => initialState(initialBlocks, initialPageVersion),
  )

  // Reconciliation effect — re-sync to server-rendered props when:
  //   (a) the props identity has actually changed (filters out re-
  //       renders that happen to pass the same prop reference), AND
  //   (b) no preview overlays are pending (operator's in-flight edit
  //       wins until they commit or discard).
  //
  // 409 recovery flow: InlineEditable / EditDrawer call router.refresh
  // on stale_version → server re-renders with the authoritative blocks
  // + pageVersion → this effect fires and resyncs.
  const lastSeenRef = useRef<{
    blocks: HydratedBlock[]
    pageVersion: number
  }>({ blocks: initialBlocks, pageVersion: initialPageVersion })
  useEffect(() => {
    if (
      lastSeenRef.current.blocks === initialBlocks &&
      lastSeenRef.current.pageVersion === initialPageVersion
    ) {
      return
    }
    lastSeenRef.current = {
      blocks: initialBlocks,
      pageVersion: initialPageVersion,
    }
    // Always reconcile. The snapshot reducer preserves operator
    // previews (only orphans pruned) so a mid-edit operator on
    // block X doesn't lose their overlay when block Y's server state
    // advances. InlineEditable's own caret-survival useEffect guards
    // against DOM clobber during active typing. The earlier
    // pending-previews skip was overly conservative — it permanently
    // stranded any server-side delta on block Y whenever any drawer
    // anywhere had a pending overlay.
    dispatch({
      type: 'snapshot',
      blocks: initialBlocks,
      pageVersion: initialPageVersion,
    })
  }, [initialBlocks, initialPageVersion])

  // ── Clipboard hydrate (client-only, post-mount) ──
  // Read the persisted slot AFTER first paint so SSR and the initial
  // client render produce identical output. A persisted slot found
  // here is replayed into state via clipboard:set; the reducer's
  // schema-version guard is the security gate (an old-version slot
  // never reaches state). Runs once per provider mount — the empty
  // dep array is correct here; we don't want a re-mount or unrelated
  // state change to re-hydrate over the operator's in-session edits.
  useEffect(() => {
    const persisted = readPersistedClipboard()
    if (persisted) {
      dispatch({ type: 'clipboard:set', slot: persisted })
    }
    // Intentionally one-shot — `dispatch` from useReducer is
    // identity-stable per React's contract, so the empty dep array
    // doesn't lint against any captured value that could change.
  }, [])

  // ── Clipboard persist (write through on every change) ──
  // Mirrors state.clipboard to localStorage so a hard refresh + paste
  // on a new tab/page picks up where the operator left off. Set
  // writes the JSON; clear removes the key. We deliberately write
  // through on EVERY change rather than debouncing — clipboard
  // mutations are operator-paced (a copy gesture, then maybe a paste),
  // not continuous, so the write rate is bounded and the operator
  // never experiences a "wrote, refreshed too quick, slot lost"
  // surprise window.
  useEffect(() => {
    if (state.clipboard === null) {
      safeStorage.remove(CLIPBOARD_STORAGE_KEY)
      return
    }
    try {
      safeStorage.set(CLIPBOARD_STORAGE_KEY, JSON.stringify(state.clipboard))
    } catch {
      // JSON.stringify on a circular ref or a non-serialisable value
      // (Map, Function) would throw. The ClipboardSlot shape is plain
      // JSON by contract, so this is defence-in-depth — better to
      // skip the write than crash the provider's render lifecycle.
    }
  }, [state.clipboard])

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  )
}

// In development, throw on use-outside-provider so a misplaced consumer
// surfaces during dev rather than silently no-oping. Production returns
// a safe placeholder to avoid hard-crashing a public render path.
const PROD = process.env.NODE_ENV === 'production'

const PLACEHOLDER_STATE: InlineEditState = {
  blocks: [],
  pageVersion: 0,
  previews: new Map(),
  versionOverrides: new Map(),
  clipboard: null,
}
function noopDispatch() {
  /* outside provider — placeholder for SSR / non-editable mounts */
}

// One-shot warn flags so a regression that mounts a context consumer
// outside the provider gets a single observable console signal per
// pageload (vs silent failure in prod or a flood per render). Dev
// throws — caught in development; prod surfaces in monitoring
// without crashing the public render path.
let warnedStateOutsideProvider = false
let warnedDispatchOutsideProvider = false

export function useInlineEditState(): InlineEditState {
  const v = useContext(StateContext)
  if (v === null) {
    if (!PROD) {
      throw new Error(
        'useInlineEditState called outside InlineEditProvider — wrap the consumer in EditableMain’s provider.',
      )
    }
    if (!warnedStateOutsideProvider) {
      warnedStateOutsideProvider = true
      console.warn(
        '[InlineEditContext] useInlineEditState called outside InlineEditProvider — falling back to placeholder. Editor state will not propagate.',
      )
    }
    return PLACEHOLDER_STATE
  }
  return v
}

export function useInlineEditDispatch(): Dispatch<InlineEditAction> {
  const v = useContext(DispatchContext)
  if (v === null) {
    if (!PROD) {
      throw new Error(
        'useInlineEditDispatch called outside InlineEditProvider — wrap the consumer in EditableMain’s provider.',
      )
    }
    if (!warnedDispatchOutsideProvider) {
      warnedDispatchOutsideProvider = true
      console.warn(
        '[InlineEditContext] useInlineEditDispatch called outside InlineEditProvider — dispatches will no-op. Sibling-save propagation broken.',
      )
    }
    return noopDispatch
  }
  return v
}

/**
 * Shallow-merge any pending preview overlay on top of the caller's
 * fallback. Returns the fallback unchanged when no preview is
 * pending. Used by both widget WidgetSlot (passes block.data) and
 * container SectionShell / ColumnSlot (passes block.meta).
 *
 * Stable reference when nothing has changed so downstream React.memo
 * boundaries don't churn. useMemo deps narrow to THIS block's preview
 * slot — without this narrowing every set-preview dispatch would
 * invalidate the memo for every widget on the page (the whole
 * previews Map identity changes per dispatch; Map.get for an
 * untouched key still returns the same inner reference, so binding
 * the dep to the slot prevents O(N) memo churn per keystroke).
 */
export function useEffectivePreview<T extends Record<string, unknown>>(
  blockId: number,
  fallback: T,
): T {
  const state = useInlineEditState()
  const preview = state.previews.get(blockId)
  // Fast path: no preview overlay → return the fallback directly, skipping
  // the useMemo bookkeeping AND avoiding a fresh `{...fallback, ...preview}`
  // object identity on every reducer dispatch. The hot path (no drawer
  // open, no in-flight preview) is 99% of renders — this short-circuit
  // keeps it allocation-free.
  return useMemo(() => {
    if (!preview) return fallback
    return { ...fallback, ...preview } as T
  }, [preview, fallback])
}

/** Container-focused alias — section/column SectionShell / ColumnSlot.
 *  Same overlay map; the caller decides whether to feed it `data` or
 *  `meta`. Same slot-narrowed memo deps as useEffectivePreview. */
export function useEffectiveBlockMeta(
  blockId: number,
  fallback: unknown,
): unknown {
  const state = useInlineEditState()
  const preview = state.previews.get(blockId)
  return useMemo(() => {
    if (!preview) return fallback
    if (fallback === null || typeof fallback !== 'object') return preview
    return { ...(fallback as Record<string, unknown>), ...preview }
  }, [preview, fallback])
}

/**
 * Resolve the freshest (blockVersion, pageVersion) for a given block.
 * Order of preference:
 *   1. context.versionOverrides[blockId] — set after a successful save
 *      so a sibling InlineEditable sees the latest cursor before the
 *      server re-render lands.
 *   2. The caller's fallback (server-rendered props).
 *
 * Memoised so the EditDrawer's drawer-key (which encodes these
 * values) stays stable across re-renders that don't change versions.
 */
export interface EffectiveVersions {
  blockVersion: number
  pageVersion: number
}

/** Chunk H — clipboard read hook. Returns the current ClipboardSlot or
 *  null. Consumers that ONLY read the clipboard (the context menu's
 *  paste disabled() predicate, future Status indicators) should use
 *  this rather than full useInlineEditState() so a state change in
 *  unrelated slots (previews / versionOverrides / blocks) doesn't
 *  re-render them. */
export function useClipboard(): ClipboardSlot | null {
  return useInlineEditState().clipboard
}

export function useEffectiveVersions(
  blockId: number,
  fallback: EffectiveVersions,
): EffectiveVersions {
  const state = useInlineEditState()
  const override = state.versionOverrides.get(blockId)
  // Destructure to primitive deps so useMemo doesn't churn when the
  // caller passes a freshly-constructed `fallback` object every
  // render (typical: `{ blockVersion: props.blockVersion, ... }`).
  const fbBlock = fallback.blockVersion
  const fbPage = fallback.pageVersion
  // Take the FRESHER of override vs fallback on each axis
  // independently. blockVersion is per-row; pageVersion is per-page
  // and can advance via a sibling-block save while THIS block's
  // override carries an older pageVersion. Returning the override
  // verbatim (which an earlier version did) would propagate that
  // stale page cursor and 409 on the next save. Math.max prevents it.
  return useMemo(() => {
    if (!override) return { blockVersion: fbBlock, pageVersion: fbPage }
    const bv =
      override.blockVersion < fbBlock ? fbBlock : override.blockVersion
    const pv =
      override.pageVersion < fbPage ? fbPage : override.pageVersion
    return { blockVersion: bv, pageVersion: pv }
  }, [override, fbBlock, fbPage])
}

// ── Chunk I — insertBlock action ─────────────────────────────────────
//
// Centralised "add a block" POST + optimistic refresh. Before Chunk I
// four callers (InsertBlockHere, EditableColumn.ColumnInlinePicker,
// OutlinePanel.AddBlockMenu, EditModeEmptyState) each held their own
// copy of the body builder + csrfFetch + error mapping + router.refresh.
// Drift between them caused subtle bugs (one caller forgot the
// position_gap_exhausted special case; another never sent parentId).
//
// The hook returns a stable function reference (useCallback) so callers
// can put it in dep arrays without churn. Each invocation runs to
// completion + reports back via InsertBlockResult — callers handle the
// busy-state spinner themselves so per-row spinners stay independent
// (Counter + Stats Row both POST 'stats_row' but spin independently
// keyed on their picker label).
//
// MediaPicker round-trip stays OUT of this hook — that's a UI concern
// (open modal, wait for pick). The 4 image callers open MediaPicker
// themselves + then call insertBlock('image', { data: ... }) with the
// picked media_id baked into the data payload.

// Hero / Gallery / Featured-projects are NOT in SeedBlockType because
// their schemas require media or project refs that can't be seeded
// blindly — they need a MediaPicker round-trip (hero/gallery) or are
// reserved for fixed-slot template pages (hero/featured_projects on
// /home, /about, /services, /contact — see FIXED_BLOCK_KEYS_PER_PAGE
// in lib/cms/block-registry.ts). The inline +Add Block palette opens
// the MediaPicker first and surfaces a clean "reserved for this page"
// toast on the 409 path.
export type InsertableBlockType =
  | SeedBlockType
  | 'image'
  | 'hero'
  | 'gallery'
  | 'featured_projects'

export interface InsertBlockOptions {
  pageId: number
  /** When omitted (undefined), useInsertBlock falls back to
   *  SEED_DATA[blockType] (text/cta/quote etc) so the server's
   *  missing_data 400 never fires for SeedBlockType callers. When the
   *  caller has a richer seed (e.g. SeedEntry.data for Counter / Stats
   *  Row that share blockType='stats_row') or a MediaPicker-derived
   *  image payload, it's passed here verbatim and overrides the
   *  fallback. Media-bound types ('image' | 'hero' | 'gallery' |
   *  'featured_projects') aren't in SEED_DATA — the caller MUST
   *  provide data for these (MediaPicker round-trip path). */
  data?: Record<string, unknown>
  /** Optional spacing/style meta — Chunk H's widget-meta-on-create
   *  path. Used by the context menu's Paste verb today; the palette +
   *  inline pickers never set this (they create with NULL meta). */
  meta?: Record<string, unknown>
  /** Position routing. Mutually exclusive — both set → server rejects
   *  with 'after_and_before_are_mutually_exclusive'. Both unset →
   *  server appends to tail of the parent bucket. */
  afterBlockId?: number | null
  beforeBlockId?: number | null
  /** Parent column id for widgets that should land inside a column.
   *  Omitted for top-level loose widgets (parent_id IS NULL). */
  parentId?: number | null
  /** Chunk I — replace-source marker. When set, after the new block
   *  POST succeeds, the referenced source block is soft-deleted so
   *  the new block visually REPLACES it. Matches Notion's slash
   *  behaviour where a /-pick on an empty paragraph replaces the
   *  paragraph with the new block.
   *
   *  Named `replaceSource` (not `fromInline`) so future "drag-to-
   *  replace" and "paste-replace" gestures can reuse the same option
   *  without misleading the call site about provenance. Today only
   *  SlashCommandInline sets it; the gate (source widget is empty +
   *  source kind is replaceable) lives in the caller per the strategy-
   *  pattern split.
   *
   *  The caller is responsible for ensuring sourceBlockId references
   *  a block whose user-visible content is genuinely empty.
   *  SlashCommandInline only sets this when the entire source widget
   *  is empty (not just the current paragraph) — multi-paragraph
   *  widgets with sibling content NEVER trigger the source-delete. */
  replaceSource?: {
    sourceBlockId: number
  }
}

export interface InsertBlockResult {
  ok: boolean
  /** Server-assigned id of the newly inserted block, when ok. */
  blockId?: number
  /** Server error code (parsed from `error` field) when ok=false.
   *  Callers map this to localised copy + special-case
   *  'position_gap_exhausted' for the inline pill toast. */
  error?: string
}

export type InsertBlockFn = (
  blockType: InsertableBlockType,
  options: InsertBlockOptions,
) => Promise<InsertBlockResult>

// Walk the block tree from `parentId` up the parent chain until a
// kind='section' row is reached, then return its parsed meta. Returns
// null when no section ancestor exists (loose top-level widget) or the
// parent chain is broken (soft-delete mid-edit). The full meta is
// returned (not just `background`) so the surface-darkness probe in
// blockMeta.ts can also consider backgroundImage + backgroundOverlay
// — a cream section with a dark cover photo + darken overlay reads as
// a dark surface and demands a light tone too.
//
// Depth-capped at section→column→widget = 2 hops (cap at 10 for
// defence-in-depth against any unexpected cycle). The schema doesn't
// permit cycles; bounding the walk costs nothing.
function resolveAncestorSectionMeta(
  parentId: number | null | undefined,
  blocks: ReadonlyArray<HydratedBlock>,
): SectionMeta | null {
  if (typeof parentId !== 'number') return null
  const byId = new Map<number, HydratedBlock>()
  for (const b of blocks) byId.set(b.id, b)
  let cursor: number | null = parentId
  for (let hop = 0; hop < 10 && cursor !== null; hop++) {
    const block = byId.get(cursor)
    if (!block) return null
    if (block.kind === 'section') {
      return (block.meta ?? null) as SectionMeta | null
    }
    cursor = block.parentId
  }
  return null
}

/**
 * Hook returning the centralised insertBlock function. Stable
 * reference across renders so dep-array-conscious callers (memoised
 * sub-components) don't churn.
 *
 * Behaviour contract:
 *   1. POST /api/cms/blocks with the resolved body shape.
 *   2. On 2xx: router.refresh() to pull the new block into the tree.
 *      If options.replaceSource is set, DELETE /api/cms/blocks/<source>
 *      runs AFTER the POST + BEFORE the refresh so a single refresh
 *      sweeps both mutations.
 *   3. On 4xx/5xx: returns { ok: false, error } — caller surfaces a
 *      toast / inline error. Does NOT refresh.
 *   4. Network errors (AbortError, fetch reject) → { ok: false } with
 *      error set to the message; caller toasts.
 *
 * replaceSource NOTE: the source delete is BEST-EFFORT. If it fails
 * (the source block was already deleted by a peer admin, or hit a
 * CSRF mismatch, or the network times out), the insert still
 * succeeded — the operator gets an extra empty text block they can
 * delete via the context menu's Delete verb. Bubbling the failure as
 * an error would be more disruptive than the outcome. The catch logs
 * a dev console.warn so a regression that flips ALL replaceSource
 * deletes failing surfaces in dev before reaching production.
 */
export function useInsertBlock(): InsertBlockFn {
  const router = useRouter()
  // Chunk J — undo-stack + toast hooks. Hooks are pulled at the
  // useInsertBlock callsite (not inside the callback) so the rules of
  // hooks aren't violated. Captured by reference in the closure
  // below; refs stay stable across renders by virtue of React's hook
  // contract.
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const toast = useToast()
  // Theme-aware tone default needs to read live state.blocks to walk
  // from the destination parent up to its ancestor section. Reading
  // state directly would re-create the useCallback every block-tree
  // mutation; the ref pattern (mirror state into a ref via useEffect)
  // gives the callback access to fresh data without churning its
  // identity. Same pattern as EditModeDndShell.stateRef.
  const state = useInlineEditState()
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  return useCallback<InsertBlockFn>(
    async (blockType, options) => {
      const body: Record<string, unknown> = {
        pageId: options.pageId,
        blockType,
      }
      // Data fallback chain: explicit caller data > SEED_DATA[blockType] >
      // omit (and let the server's missing_data 400 fire). The fallback
      // means every SeedBlockType insert (the 25+ widgets surfaced in
      // WidgetPicker / OutlinePanel / slash / empty-state / drag-drop)
      // can omit `data` and still satisfy the server's per-kind Zod
      // schema with the minimum required fields. Media-bound types
      // ('image' | 'hero' | 'gallery' | 'featured_projects') aren't in
      // SEED_DATA — the lookup is `undefined` for those and the caller
      // MUST provide data (every existing caller does — MediaPicker
      // round-trip on the click paths, MediaPicker required on /slash).
      //
      // The `blockType in SEED_DATA` runtime check is necessary because
      // SEED_DATA is typed `Record<SeedBlockType, ...>` and InsertableBlockType
      // is wider (adds the 4 media-bound types). Bypassing the check would
      // make `SEED_DATA[blockType]` a TypeScript error at this site.
      const dataFallback =
        blockType in SEED_DATA
          ? SEED_DATA[blockType as SeedBlockType]
          : undefined
      let resolvedData =
        options.data !== undefined ? options.data : dataFallback

      // Theme-aware tone default. When the destination section's
      // visible surface reads as dark AND the block has a tone field
      // with a light enum member, substitute that light token before
      // POSTing — so the freshly-inserted widget isn't black-on-black.
      // Both inputs are derived dynamically:
      //   - lightToneFor(blockType) walks the block's tone enum (from
      //     BLOCK_TONE_ENUMS) and picks the first member tagged
      //     'light' in COLOR_TOKEN_BRIGHTNESS.
      //   - isSectionSurfaceDark(meta) considers both `meta.background`
      //     color brightness AND a `backgroundImage` with a darkening
      //     overlay (cinematic hero pattern — cream bg + dark cover
      //     photo).
      //
      // Respects explicit caller-set `tone` — the override only fires
      // when the resolved payload has no `tone` property.
      const lightTone = lightToneFor(blockType)
      if (
        lightTone !== null &&
        typeof resolvedData === 'object' &&
        resolvedData !== null &&
        !('tone' in resolvedData)
      ) {
        const sectionMeta = resolveAncestorSectionMeta(
          options.parentId,
          stateRef.current.blocks,
        )
        if (isSectionSurfaceDark(sectionMeta)) {
          resolvedData = { ...resolvedData, tone: lightTone }
        }
      }

      if (resolvedData !== undefined) body.data = resolvedData
      if (options.meta !== undefined) body.meta = options.meta
      if (typeof options.afterBlockId === 'number') {
        body.afterBlockId = options.afterBlockId
      }
      if (typeof options.beforeBlockId === 'number') {
        body.beforeBlockId = options.beforeBlockId
      }
      if (typeof options.parentId === 'number') {
        body.parentId = options.parentId
      }
      try {
        const res = await csrfFetch('/api/cms/blocks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          return { ok: false, error: j.error ?? 'insert_failed' }
        }
        const j = (await res.json().catch(() => ({}))) as {
          id?: number
        }
        const newId = typeof j.id === 'number' ? j.id : undefined

        // ── Chunk J — record ADD on the undo stack + surface inline-Undo toast ──
        // Forward = POST with the resolved body shape (replayed verbatim on redo;
        // server returns a fresh id which the controller rebinds into the
        // inverse via deriveRebind). Inverse = DELETE the captured new id.
        //
        // replaceSource (Notion-style empty-paragraph swap) is OUT of the
        // command shape: it's a best-effort secondary side-effect, not a
        // primary mutation. Undoing the add restores the new block but does
        // NOT resurrect the source paragraph — matching Notion's behaviour
        // where the "/" replace is treated as a single atomic gesture.
        if (typeof newId === 'number') {
          recordCommand({
            kind: 'add',
            label: `Added ${blockType}`,
            timestamp: Date.now(),
            forward: {
              method: 'POST',
              path: '/api/cms/blocks',
              body,
              expects: 201,
            },
            inverse: {
              method: 'DELETE',
              path: `/api/cms/blocks/${newId}`,
              expects: 200,
            },
            captures: { newBlockId: newId, blockType },
          })
          toast.success(`Added ${blockType.replace(/_/g, ' ')}`, {
            label: 'Undo',
            // Inline Undo routes through the same runUndo path as ⌘Z
            // so the cursor moves consistently. A subsequent ⌘Z after
            // clicking targets the NEXT command on the stack, not the
            // just-undone one. (Agent review HIGH — bypassing the
            // cursor here would leave the inverse re-runnable.)
            onClick: () => void runUndo(),
          })
        }

        // ── replaceSource source-delete ──
        // Notion-style "replace the empty paragraph with the new
        // block". Best-effort — see hook docstring for rationale.
        // The DELETE runs BEFORE router.refresh so a single refresh
        // sweeps both mutations.
        //
        // Chunk J fix: gate on `typeof newId === 'number'`. The
        // server should ALWAYS return an id on 2xx but a malformed
        // response (proxy / CDN body mangling, server bug) would
        // otherwise produce a "source deleted, new block has no
        // recovery handle" outcome — the operator loses content with
        // no undo path. If the new block didn't materialise, leave the
        // source paragraph alone; the operator can retry.
        if (options.replaceSource && typeof newId === 'number') {
          try {
            const delRes = await csrfFetch(
              `/api/cms/blocks/${options.replaceSource.sourceBlockId}`,
              { method: 'DELETE' },
            )
            if (!delRes.ok && process.env.NODE_ENV !== 'production') {
              console.warn(
                '[useInsertBlock] replaceSource delete returned non-OK status',
                delRes.status,
              )
            }
          } catch (delErr) {
            // Best-effort — no propagation. Dev warn so a regression
            // that breaks ALL replaceSource deletes (CSRF rotation,
            // route 404, etc.) surfaces during development.
            if (process.env.NODE_ENV !== 'production') {
              console.warn(
                '[useInsertBlock] replaceSource delete failed',
                delErr,
              )
            }
          }
        }

        router.refresh()
        return { ok: true, blockId: newId }
      } catch (e) {
        return {
          ok: false,
          error:
            e instanceof Error && e.name === 'AbortError'
              ? 'timeout'
              : 'network_error',
        }
      }
    },
    [router, recordCommand, runUndo, toast],
  )
}

