'use client'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { X, Check, Loader2, CloudOff } from 'lucide-react'
import clsx from 'clsx'
import { Drawer } from '@/components/ui/Drawer'
import { csrfFetch } from '@/lib/client/csrf'
import { safeStorage } from '@/lib/client/safeStorage'
import { ConfirmModal } from './ConfirmModal'
import { SHAPES_FOR_BLOCK, ZodForm, type FieldShape } from './ZodForm'
import { CrmDestinationsPanel } from './CrmDestinationsPanel'
import { SEED_ENTRIES, type SeedBlockType } from '@/lib/cms/blockSeeds'
import { useToast } from './Toast'
import { useRecordCommand, useUndoActions } from './UndoStackProvider'
import { emitSaveBegin, emitSaveEnd } from './SaveStatusIndicator'
import {
  useEffectiveVersions,
  useInlineEditDispatch,
} from './InlineEditContext'

const DRAFT_AUTOSAVE_MS = 5_000

// Chunk H — TabKey is now an alias of EditDrawerTab, exported from
// lib/cms/editDrawerTabs.ts so the context menu registry, the EditDrawer
// itself, and each Editable* `drawerInitialTab` slot share ONE source
// of truth. A future rename ('style' → 'design') updates one file.
import type { EditDrawerTab } from '@/lib/cms/editDrawerTabs'
export type TabKey = EditDrawerTab

export interface EditDrawerProps {
  blockId: number
  blockType: string
  initialData: unknown
  initialVersion: number
  // PR-3 (spec §3.5 + §7): dual-axis optimistic lock. The save TX
  // locks pages BEFORE content_blocks, so the body MUST carry both
  // tokens AND the pageId. Tracked as state because each successful
  // save bumps BOTH versions and the FE needs the new values for
  // the next save attempt.
  pageId: number
  initialPageVersion: number
  onClose: () => void
  /** Chunk H — optional initial tab override. The context menu's
   *  Spacing / Set column width verbs route to the Style tab; future
   *  verbs may route to Advanced. When omitted, the drawer opens to
   *  the first non-empty tab via initialTabFor — preserving the
   *  pre-chunk-H default for the click-to-edit + pencil-toolbar
   *  entry points. */
  initialTab?: TabKey
  /** F5 — fixed-slot blocks (e.g. `site_footer`, `site_header_nav`)
   *  are identified by their registry blockKey rather than by their
   *  `data.label`. Threading the prop in lets the drawer heading
   *  surface "Section · site_footer" instead of "Section #42",
   *  matching the canvas + outline labels and giving operators a
   *  stable, recognisable identity for system blocks. Optional so
   *  click-to-edit on a non-keyed widget still works without the
   *  caller needing to plumb it. */
  blockKey?: string | null
}

// Field-key → tab routing. Keys that read as visual / layout settings
// land on the Style tab; identifier / CSS-class style keys would land
// on Advanced (none in v1 schemas yet, structure ready). Everything
// else stays on Content. This avoids adding a `tab?:` prop to every
// FieldShape variant — single lookup at render time keeps the schema
// declarations terse.
// Style-tab routing — match BOTH camelCase + snake_case variants
// for every visual key. The codebase has converged on camelCase in
// FieldShape declarations, but the snake_case mirrors are kept as
// defence in depth so a future shape that follows the DB-column
// convention (`columns_count`, `column_count`) lands on Style not
// Content.
const STYLE_KEYS = new Set([
  'alignment',
  'columns',
  'columns_count',
  'columnsCount',
  'layout',
  'background',
  'padding',
  'width',
  // Section / column background-image triad (Elementor-parity).
  // Listed here so the media picker + overlay + min-height fields
  // route to the Style tab instead of falling into Content.
  'backgroundImage',
  'backgroundOverlay',
  'backgroundFit',
  'minHeight',
  // Per-side spacing axes (F3). The toolbar's spacing popover writes
  // these onto `meta` for sections/columns and onto `data` for
  // widgets that surface per-side knobs. Without these entries, any
  // future per-side FieldShape would route to Content — they are
  // styling, not content. Listed as the camelCase variants the
  // FieldShape declarations use; the snake_case mirrors are defence
  // in depth.
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'padding_top',
  'padding_right',
  'padding_bottom',
  'padding_left',
  'margin_top',
  'margin_right',
  'margin_bottom',
  'margin_left',
])
// Schema canonicalises identity to a single `htmlId` field (see
// SectionMeta / ColumnMeta / WidgetMeta in lib/cms/blockMeta.ts). The
// `anchor` and `id` aliases are kept ONLY for legacy field-shape
// definitions that haven't been migrated yet — they still resolve to
// the Advanced tab so operators editing a pre-rename row don't see the
// field disappear. New field shapes should use `htmlId` directly.
// `cssClass` / `css_class` are reserved for the upcoming custom-class
// affordance (advanced-tab Pro escape hatch).
const ADVANCED_KEYS = new Set([
  'cssClass',
  'css_class',
  'htmlId',
  'anchor',
  'id',
  'visibility',
  // `label` is the operator's name for a section/column — it belongs
  // alongside htmlId + visibility under the "Identity & visibility"
  // group on the Advanced tab. Widgets don't surface a label field
  // (they're identified by their content), so this is effectively
  // section + column only.
  'label',
])

function tabForShape(shape: FieldShape): TabKey {
  if (STYLE_KEYS.has(shape.key)) return 'style'
  if (ADVANCED_KEYS.has(shape.key)) return 'advanced'
  return 'content'
}

// Pre-compute the first tab that actually has fields for a given
// blockType. Container kinds (section/column) only have style fields,
// so the default 'content' would land them on an empty "No content
// settings" message and force a manual tab click. This helper picks
// the first non-empty bucket so the drawer opens to a useful surface.
function initialTabFor(shapes: FieldShape[]): TabKey {
  let hasContent = false
  let hasStyle = false
  let hasAdvanced = false
  for (const s of shapes) {
    const t = tabForShape(s)
    if (t === 'content') hasContent = true
    else if (t === 'style') hasStyle = true
    else if (t === 'advanced') hasAdvanced = true
  }
  if (hasContent) return 'content'
  if (hasStyle) return 'style'
  if (hasAdvanced) return 'advanced'
  return 'content'
}

function eyebrowFor(blockType: string): string {
  if (blockType === 'section') return 'Section settings'
  if (blockType === 'column') return 'Column settings'
  return 'Block settings'
}

// Drawer-header display name. Prefer the seed registry label (the
// same string the slash palette + OutlinePanel render) so the three
// surfaces stay aligned. Sections + columns aren't in the widget seed
// table — fall back to a manual title-case on the snake_case
// blockType for those. Audit finding E11 (Chunk K).
function titleCaseBlockType(blockType: string): string {
  return blockType
    .split('_')
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')
}
// Common operator-editable text fields to surface as a per-block
// identity hint when no `label` / `blockKey` is set. Ordered by how
// strongly each field reads as "what this block is" — `heading`, `title`,
// `text` first because those map to the visible word the operator
// most recently typed on the canvas.
const IDENTITY_TEXT_KEYS = [
  'heading',
  'title',
  'text',
  'headline',
  'label',
  'quote',
]

function inlineTextHint(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const rec = data as Record<string, unknown>
  for (const k of IDENTITY_TEXT_KEYS) {
    const v = rec[k]
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (trimmed !== '') {
        return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed
      }
    }
  }
  return undefined
}

// F4 — per-block identity. Container drawers used to read just "Section"
// regardless of which section they targeted. Now consults block.label
// (an operator-set label on meta) and block.blockKey (the registry's
// fixed key for keyed blocks). For widgets, appends the block id as
// a stable hint when no inline text identifies the block.
function displayNameFor(
  blockType: string,
  data: unknown,
  blockId: number,
  blockKey?: string | null,
): string {
  const meta = (data ?? null) as Record<string, unknown> | null
  // Operator-set label has highest priority — that's the explicit
  // intent of the field (Agent A6).
  if (meta && typeof meta.label === 'string') {
    const t = meta.label.trim()
    if (t !== '') return t.length > 48 ? `${t.slice(0, 48)}…` : t
  }
  const isContainer = blockType === 'section' || blockType === 'column'
  if (isContainer) {
    // Fixed-key blocks (e.g., a global Footer block keyed 'site_footer')
    // are identified by the registry key — surface it so two sections
    // on the same page don't both read as "Section".
    if (blockKey && blockKey.trim() !== '') {
      return blockType === 'column'
        ? `Column · ${blockKey}`
        : `Section · ${blockKey}`
    }
    return blockType === 'column'
      ? `Column #${blockId}`
      : `Section #${blockId}`
  }
  // Widget: prefer the seed registry label, optionally augmented with
  // an inline-text hint or the block id so two of the same widget type
  // on the same page are distinguishable.
  const seed = SEED_ENTRIES.find((e) => e.type === (blockType as SeedBlockType))
  const base = seed ? seed.label : titleCaseBlockType(blockType)
  const hint = inlineTextHint(data)
  if (hint) return `${base} · ${hint}`
  return `${base} · #${blockId}`
}

export function EditDrawer({
  blockId,
  blockType,
  initialData,
  initialVersion,
  pageId,
  initialPageVersion,
  onClose,
  initialTab,
  blockKey,
}: EditDrawerProps) {
  const router = useRouter()
  const toast = useToast()
  const recordCommand = useRecordCommand()
  const { runUndo } = useUndoActions()
  const dispatch = useInlineEditDispatch()
  const [, startTransition] = useTransition()
  const inFlightRef = useRef(false)
  // Set on tryClose / discardAndClose so a still-running form-mutation
  // handler (e.g. ZodForm's onChange firing during unmount) can't
  // dispatch a trailing `set-preview` after the operator dismissed
  // the drawer — that would leak a stale overlay onto the canvas
  // with no UI affordance to dismiss it.
  const closingRef = useRef(false)
  // Mounted guard for post-await setters / dispatches. Without this,
  // a save() that completes after the drawer unmounts (e.g. operator
  // hit Esc through the Drawer's overlay or keydown — both bypass the
  // X / footer Close button's disabled gate) would call setBusy /
  // setLastSavedAt on a torn-down component AND dispatch block-saved
  // contradicting the operator's discard intent.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // Buffer for keystrokes that arrive during an in-flight save. We
  // can't push them into React state mid-save (the optimistic
  // dispatch is gated on inFlightRef to prevent the canvas thrashing
  // between sent vs current data), but we DO need to capture them so
  // the post-save flush picks them up — otherwise the operator's
  // typing during the network round-trip silently vanishes.
  const pendingDataRef = useRef<Record<string, unknown> | null>(null)

  // Drawer-owned (blockVersion, pageVersion) state. Pre-fix the local
  // state was bumped only on this drawer's save; a sibling InlineEditable
  // save on the same block would advance the context's versionOverride
  // but the drawer kept saving with its stale local cursor → guaranteed
  // 409 on the next drawer save. Subscribing to useEffectiveVersions
  // (and mirroring through a ref for the save() closure) keeps the
  // drawer's lock token aligned with every per-block bump.
  const versions = useEffectiveVersions(blockId, {
    blockVersion: initialVersion,
    pageVersion: initialPageVersion,
  })
  const versionsRef = useRef(versions)
  useEffect(() => {
    versionsRef.current = versions
  }, [versions])

  // Chunk J — undo capture. Tracks the LAST-SAVED data so an undo of
  // a chained edit (save → edit → save → ⌘Z) reverts to the previous
  // saved state, not to the original drawer-open state. Starts at
  // initialData (the operator's first view), advances on every
  // successful save.
  const lastSavedDataRef = useRef<unknown>(initialData)

  // draftKey moves with the drawer's CURRENT block version so a stale
  // draft from a previous save cycle doesn't resurrect; the sweep
  // effect below removes the prior key on every advance.
  const draftKey = useMemo(
    () => `cavecms:draft:${blockId}:${versions.blockVersion}`,
    [blockId, versions.blockVersion],
  )
  // F7 — explicit-discard sentinel. The Discard button writes the
  // timestamp here so that on a subsequent mount (parent re-render,
  // error-boundary recovery, hot-reload) the draft is treated as
  // absent when discardedAt is newer than the draft's savedAt. The
  // key is per-block (NOT per-version) so a discard on v3 still
  // suppresses a stale v3 draft after the page hot-reloads.
  const discardKey = useMemo(() => `cavecms:discarded:${blockId}`, [blockId])

  const [data, setData] = useState<Record<string, unknown>>(() => {
    if (typeof window === 'undefined') return initialData as Record<string, unknown>
    const saved = safeStorage.get(draftKey)
    if (!saved) return initialData as Record<string, unknown>
    try {
      const parsed = JSON.parse(saved) as unknown
      // F7 — draft format evolved to { savedAt, data } so we can
      // compare against the discard sentinel. Backwards-compat: a raw
      // object (pre-F7) is treated as the data payload with no
      // recoverable savedAt — those drafts win against any discard
      // (they predate the sentinel, so we can't know which is newer).
      if (
        parsed &&
        typeof parsed === 'object' &&
        'savedAt' in parsed &&
        'data' in parsed
      ) {
        const draft = parsed as { savedAt: number; data: Record<string, unknown> }
        const discardedRaw = safeStorage.get(discardKey)
        const discardedAt = discardedRaw === null ? 0 : Number(discardedRaw)
        if (Number.isFinite(discardedAt) && discardedAt > draft.savedAt) {
          // Operator explicitly discarded after this draft was saved.
          safeStorage.remove(draftKey)
          return initialData as Record<string, unknown>
        }
        return draft.data
      }
      // Legacy draft shape — return as-is.
      return parsed as Record<string, unknown>
    } catch {
      safeStorage.remove(draftKey)
      return initialData as Record<string, unknown>
    }
  })

  const [busy, setBusy] = useState(false)
  // Chunk H: caller may pre-route to a specific tab (e.g., the context
  // menu's Spacing verb opens directly on Style). initialTabFor stays
  // the default for all pre-Chunk-H entry points (click-to-edit, pencil
  // toolbar button) — preserves the existing UX where the drawer lands
  // on the first non-empty bucket. The override is applied ONLY when
  // the requested tab has shapes to show; an "open on Style" request
  // for a widget whose Style tab is empty falls back to initialTabFor
  // so the operator doesn't land on an empty form.
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const shapes = SHAPES_FOR_BLOCK[blockType] ?? []
    if (initialTab !== undefined) {
      const hasFieldsOnRequestedTab = shapes.some(
        (s) => tabForShape(s) === initialTab,
      )
      if (hasFieldsOnRequestedTab) return initialTab
    }
    return initialTabFor(shapes)
  })
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const eyebrow = eyebrowFor(blockType)
  const kindNoun = blockType === 'section'
    ? 'Section'
    : blockType === 'column'
      ? 'Column'
      : 'Block'

  // Cache the initialData serialisation so a keystroke re-stringify
  // doesn't waste CPU on large widget payloads (gallery image arrays,
  // long rich-text bodies). `initialData` is stable for the drawer's
  // lifetime; only `data` changes per keystroke.
  const initialSerialized = useMemo(() => {
    try {
      return JSON.stringify(initialData)
    } catch {
      return null
    }
  }, [initialData])
  // F8 — `dirty` must read false immediately after a successful save
  // even though `initialSerialized` still reflects the drawer-open
  // state. Tracking the LAST-SAVED serialised payload as state (not a
  // ref) makes the `dirty` memo re-evaluate on save success and the
  // Save button correctly disables until the next edit. The ref
  // mirror is kept for the save() closure's undo-record path which
  // needs the prior data object reference, not the string.
  const [savedSerialized, setSavedSerialized] = useState<string | null>(
    initialSerialized,
  )
  const dirty = useMemo(() => {
    const baseline = savedSerialized ?? initialSerialized
    if (baseline === null) return true
    try {
      return JSON.stringify(data) !== baseline
    } catch {
      return true
    }
  }, [data, initialSerialized, savedSerialized])

  // Pushes the form's draft into the canvas as a live-preview overlay
  // (Chunk B). The renderer's useEffectiveBlockMeta /
  // useEffectivePreview merges this on top of the persisted shape so
  // the operator sees background swaps, padding shifts, title tweaks
  // the instant they happen — no save needed. The overlay is cleared
  // on save success (via block-saved / block-meta-saved reducers) or
  // on discard (via clear-preview).
  const handleSetData = useCallback(
    (next: Record<string, unknown>) => {
      // Trailing-event guard: if tryClose/discardAndClose has already
      // committed (drawer unmounting), drop the dispatch so we don't
      // leak a preview overlay that the operator can no longer dismiss
      // from the (closed) drawer.
      if (closingRef.current) return
      if (inFlightRef.current) {
        // Mid-save typing: buffer the latest into a ref so the
        // post-save finally{} block can flush it. We can't update
        // React state here because the canvas would thrash between
        // sent vs current data and the dispatch closure would race
        // the block-saved overlay-clear. The ref captures intent
        // without invading React's render cycle.
        pendingDataRef.current = next
        return
      }
      setData(next)
      dispatch({ type: 'set-preview', blockId, data: next })
    },
    [blockId, dispatch],
  )

  // Autosave draft to localStorage.
  useEffect(() => {
    if (!dirty) {
      safeStorage.remove(draftKey)
      return
    }
    const t = setTimeout(
      () =>
        safeStorage.set(
          draftKey,
          // F7 — wrap with savedAt so a subsequent discard can be
          // compared against this timestamp on next mount.
          JSON.stringify({ savedAt: Date.now(), data }),
        ),
      DRAFT_AUTOSAVE_MS,
    )
    return () => clearTimeout(t)
  }, [data, dirty, draftKey])

  // Sweep stale drafts for this block left over from prior versions.
  // Deps are [blockId] only so the O(localStorage.length) scan runs
  // ONCE per drawer mount, not every time `draftKey` changes (which
  // happens on every successful save when initialVersion bumps).
  // The current draftKey is read from a ref to avoid re-running.
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey
  useEffect(() => {
    if (typeof window === 'undefined') return
    const prefix = `cavecms:draft:${blockId}:`
    const current = draftKeyRef.current
    const stale: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (k && k.startsWith(prefix) && k !== current) stale.push(k)
    }
    stale.forEach((k) => safeStorage.remove(k))
  }, [blockId])

  // Beforeunload warning on dirty unsaved state.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // Custom unsaved-changes confirmation. the project standards ban
  // alert/confirm/prompt — switching to a state-driven modal that
  // matches the rest of the editor's chrome (cream + copper, custom
  // dialog with auto-focus + Esc).
  const tryClose = useCallback(() => {
    // Save-in-flight close-block. The X / footer Close buttons are
    // already `disabled={busy}` at the DOM level, but the Drawer's
    // Escape handler + overlay click both route here without the
    // disabled gate. Without this check, an operator who hits
    // Esc mid-save can discard-and-close while the PATCH continues
    // to commit server-side — the server's data persists, the
    // post-await block-saved dispatch (mountedRef gated, but the
    // server commit is independent) still lands, contradicting
    // the operator's "discard" intent.
    if (inFlightRef.current) return
    if (!dirty) {
      // Defensive clear — set-preview overlays from earlier mutations
      // that landed back at the persisted shape would otherwise leak
      // through the close.
      closingRef.current = true
      dispatch({ type: 'clear-preview', blockId })
      onClose()
      return
    }
    setConfirmClose(true)
  }, [blockId, dirty, dispatch, onClose])
  const discardAndClose = useCallback(() => {
    closingRef.current = true
    safeStorage.remove(draftKey)
    // F7 — write the discard sentinel so that if a stale draft for
    // this block resurfaces from another tab / hot-reload / error
    // boundary, the next mount can compare savedAt vs discardedAt
    // and treat the draft as absent when the operator explicitly
    // dropped it.
    safeStorage.set(discardKey, String(Date.now()))
    setConfirmClose(false)
    // Drop any pending preview overlay so the canvas reverts to the
    // persisted shape immediately.
    dispatch({ type: 'clear-preview', blockId })
    onClose()
  }, [blockId, discardKey, dispatch, draftKey, onClose])

  // Container kinds (section/column) PATCH `meta` instead of `data`.
  // The blockType column carries the literal kind name for containers
  // (set by POST /api/cms/blocks for kind!=widget), so a single-string
  // check here is the same dispatch the server uses internally.
  const isContainer = blockType === 'section' || blockType === 'column'

  const save = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    // Broadcast to the global save-status indicator. id keys on
    // blockId so rapid Save clicks coalesce; concurrent drawer +
    // inline saves on the same block produce distinct entries
    // (drawer prefix vs inline prefix) that coalesce-when-empty
    // into one Saved/Failed signal.
    const saveStatusId = `drawer:${blockId}`
    emitSaveBegin(saveStatusId)
    let saveOk = false

    // Snapshot the data sent so we can detect operator-typed-during-
    // save and re-publish a fresh preview overlay (via pendingDataRef
    // flush below) after the block-saved dispatch clears the in-flight
    // overlay.
    const sentData = data
    const v = versionsRef.current

    // F5 — developer-visible registry invariant. The save body sends
    // `meta` for containers (section/column) and `data` for widgets;
    // this maps to the reducer's `block-meta-saved` vs `block-saved`
    // dispatch downstream. If a future registry misconfiguration makes
    // these axes disagree (e.g., blockType=='section' but the renderer
    // expects `data`), the silent drift writes to the wrong column and
    // is virtually impossible to debug post-hoc. Asserting at dispatch
    // time fails LOUDLY at dev time — production strips the throw to
    // avoid surfacing an internal misconfiguration to operators.
    if (process.env.NODE_ENV !== 'production') {
      const expectedField = isContainer ? 'meta' : 'data'
      const expectedKind = isContainer ? 'container' : 'widget'
      const actualKind =
        blockType === 'section' || blockType === 'column'
          ? 'container'
          : 'widget'
      if (expectedKind !== actualKind) {
        throw new Error(
          `[EditDrawer] block.kind dispatch mismatch: blockType="${blockType}" ` +
            `resolved to ${actualKind} but save expected ${expectedKind} → ${expectedField}. ` +
            `Registry misconfiguration — check SHAPES_FOR_BLOCK / isContainer.`,
        )
      }
    }

    try {
      const res = await csrfFetch(`/api/cms/blocks/${blockId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pageId,
          blockVersion: v.blockVersion,
          pageVersion: v.pageVersion,
          ...(isContainer ? { meta: sentData } : { data: sentData }),
        }),
      })
      if (!mountedRef.current) return
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        if (!mountedRef.current) return
        if (res.status === 409) {
          toast.error(
            'Someone else changed this section. Reopen the editor to see their changes.',
          )
          // 409 is the only path that still needs router.refresh —
          // server state has actually diverged and the optimistic
          // context can't recover without re-fetching. Clear THIS
          // drawer's preview first so the reconciliation snapshot
          // overlay-prune doesn't drop the operator's data.
          dispatch({ type: 'clear-preview', blockId })
          startTransition(() => router.refresh())
        } else if (res.status === 422) {
          // F1 — 422 rollback. Pre-fix the optimistic preview overlay
          // stayed painted on the canvas with no UI affordance to
          // dismiss it; the operator had to close the drawer to
          // discard. Restore the drawer's local state AND the canvas
          // overlay to the last-known-good value so the next paint
          // matches the persisted shape exactly.
          const lastGood = lastSavedDataRef.current as
            | Record<string, unknown>
            | undefined
          if (lastGood !== undefined) {
            setData(lastGood)
            // clear-preview drops the in-flight overlay; the renderer
            // falls back to the persisted block.data/meta → matches
            // server state. No need to set-preview to lastGood because
            // lastGood IS the persisted shape (it was written here by
            // the last successful save).
            dispatch({ type: 'clear-preview', blockId })
          }
          toast.error(
            j.error ??
              "We couldn't save those changes — your last saved values are restored.",
          )
        } else {
          toast.error(j.error ?? "We couldn't save. Try again in a moment.")
        }
        return
      }
      // Success but the body parse may still fail (proxy/gzip mid-
      // stream truncation, CDN interstitial). The save HAS COMMITTED
      // server-side; falling into the outer catch would re-save the
      // draft + toast "we can't reach the server" + cause the
      // operator to retry into a 409 stale_version. Without the post-
      // save versions we have to refresh — but this is the EXCEPTIONAL
      // success path, not the steady-state one.
      let j: { blockVersion?: number; pageVersion?: number }
      try {
        j = (await res.json()) as {
          blockVersion?: number
          pageVersion?: number
        }
      } catch {
        if (!mountedRef.current) return
        safeStorage.remove(draftKey)
        setLastSavedAt(Date.now())
        // F2 — body-parse failure on 200. The server accepted the
        // change (200) but we couldn't read the new version cursors.
        // Pre-fix we silently router.refresh()'d, which threw away
        // the operator's ⌘Z affordance for the just-saved change.
        // Record the undo command using the SENT data so undo still
        // works; we skip captures.blockVersion/pageVersion because we
        // don't have them — the inverse PATCH will need a fresh
        // version exchange (deriveRebind handles that path). Then
        // refresh to reconcile the version cursors with the server.
        const priorData = lastSavedDataRef.current
        const fieldKey = isContainer ? 'meta' : 'data'
        recordCommand({
          kind: isContainer ? 'edit-meta' : 'edit-data',
          label: `${kindNoun} edit`,
          timestamp: Date.now(),
          forward: {
            method: 'PATCH',
            path: `/api/cms/blocks/${blockId}`,
            body: {
              pageId,
              blockVersion: v.blockVersion,
              pageVersion: v.pageVersion,
              [fieldKey]: sentData,
            },
            expects: 200,
          },
          inverse: {
            method: 'PATCH',
            path: `/api/cms/blocks/${blockId}`,
            body: {
              pageId,
              // Best-effort: we send the pre-save versions because we
              // never received the post-save pair. The server-side
              // 409-on-stale handler + deriveRebind will pull the
              // current versions and retry on the next stack walk.
              blockVersion: v.blockVersion,
              pageVersion: v.pageVersion,
              [fieldKey]: priorData,
            },
            expects: 200,
          },
          captures: {
            blockId,
            // Version cursors unknown — record the pre-save pair so
            // deriveRebind has something to compare against. The
            // refresh below will reconcile the optimistic context
            // with the real server cursors.
            blockVersion: v.blockVersion,
            pageVersion: v.pageVersion,
          },
        })
        lastSavedDataRef.current = sentData
        // F8 — advance the dirty baseline so the Save button correctly
        // disables until the next edit.
        try {
          setSavedSerialized(JSON.stringify(sentData))
        } catch {
          // Unserialisable payloads are already impossible to PATCH; if
          // we somehow got here, leave the baseline alone — `dirty`
          // will continue to read against the prior serialisation.
        }
        saveOk = true
        toast.success(`${kindNoun} saved. Reloading to sync.`)
        startTransition(() => router.refresh())
        return
      }
      if (!mountedRef.current) return
      // JSON shape validation: the cast above is a TypeScript-only
      // assertion. A malformed body (proxy/CDN returning {}, {ok:true},
      // or null) would otherwise propagate `undefined` into the
      // block-saved dispatch → reducer writes `version: undefined`
      // into state.blocks[i] → next save sends `blockVersion: undefined`
      // → server 422. Fail safe by treating as the body-parse-failed
      // success path.
      if (
        typeof j.blockVersion !== 'number' ||
        typeof j.pageVersion !== 'number'
      ) {
        safeStorage.remove(draftKey)
        setLastSavedAt(Date.now())
        // F8 — keep the dirty baseline aligned even on the malformed-
        // body fall-through. The save committed server-side; the
        // operator's Save button should disable until the next edit.
        try {
          setSavedSerialized(JSON.stringify(sentData))
        } catch {
          // see comment on the body-parse-failure path above.
        }
        lastSavedDataRef.current = sentData
        saveOk = true
        toast.success(`${kindNoun} saved. Reloading to sync.`)
        startTransition(() => router.refresh())
        return
      }
      setLastSavedAt(Date.now())
      safeStorage.remove(draftKey)
      // Publish the saved state into the optimistic tree. block-saved
      // (widget) / block-meta-saved (container) reducers update the
      // matched block, bump the per-block + page version cursors via
      // versionOverrides, AND clear the preview overlay — the canvas
      // now reads the persisted shape directly. NO router.refresh on
      // the steady-state save path; that was the prior round-trip
      // flicker Chunk B exists to eliminate.
      if (isContainer) {
        dispatch({
          type: 'block-meta-saved',
          blockId,
          meta: sentData,
          blockVersion: j.blockVersion,
          pageVersion: j.pageVersion,
        })
      } else {
        dispatch({
          type: 'block-saved',
          blockId,
          data: sentData,
          blockVersion: j.blockVersion,
          pageVersion: j.pageVersion,
        })
      }
      // Flush any keystrokes that arrived during the save round-trip.
      // The buffer in handleSetData captured the latest value; here
      // we hand it back to React state AND publish a preview overlay
      // so the canvas stays on the operator's latest typing instead
      // of flashing back to sentData for a paint. Closing guard
      // skips when the operator's already discarded.
      const pending = pendingDataRef.current
      pendingDataRef.current = null
      if (pending !== null && !closingRef.current) {
        setData(pending)
        dispatch({ type: 'set-preview', blockId, data: pending })
      }
      // ── Chunk J — record EDIT on the undo stack ──
      // Forward: PATCH with sentData + the just-committed versions
      // (the controller will rebind these on redo via deriveRebind).
      // Inverse: PATCH with the PRIOR saved data + the response's new
      // versions (an immediate undo expects the freshly-bumped pair).
      // After the undo PATCH succeeds, deriveRebind updates BOTH sides'
      // expected versions to the inverse PATCH's response.
      const priorData = lastSavedDataRef.current
      const fieldKey = isContainer ? 'meta' : 'data'
      recordCommand({
        kind: isContainer ? 'edit-meta' : 'edit-data',
        label: `${kindNoun} edit`,
        timestamp: Date.now(),
        forward: {
          method: 'PATCH',
          path: `/api/cms/blocks/${blockId}`,
          body: {
            pageId,
            blockVersion: v.blockVersion,
            pageVersion: v.pageVersion,
            [fieldKey]: sentData,
          },
          expects: 200,
        },
        inverse: {
          method: 'PATCH',
          path: `/api/cms/blocks/${blockId}`,
          body: {
            pageId,
            blockVersion: j.blockVersion,
            pageVersion: j.pageVersion,
            [fieldKey]: priorData,
          },
          expects: 200,
        },
        captures: {
          blockId,
          blockVersion: j.blockVersion,
          pageVersion: j.pageVersion,
        },
      })
      // Advance the prior-saved cursor so the next save's inverse
      // reverts to THIS saved state, not the drawer-open state.
      lastSavedDataRef.current = sentData
      // F8 — same advance for the serialised baseline used by `dirty`.
      // The flushed `pending` (typing during round-trip) keeps dirty=true
      // for the new keystrokes because JSON.stringify(pending) !==
      // JSON.stringify(sentData). When no pending typing arrived, dirty
      // immediately reads false until the operator's next edit.
      try {
        setSavedSerialized(JSON.stringify(sentData))
      } catch {
        // unreachable for any payload the PATCH could have carried.
      }
      saveOk = true
      toast.success(`${kindNoun} saved.`, {
        label: 'Undo',
        // Routes through runUndo so the cursor moves. Subsequent ⌘Z
        // targets the NEXT command on the stack.
        onClick: () => void runUndo(),
      })
    } catch (e) {
      if (!mountedRef.current) return
      // closingRef gate: an operator who already discarded shouldn't
      // see the draft resurrected on the next drawer open (they
      // explicitly chose to drop it).
      if (!closingRef.current) {
        // Keep the F7 draft shape consistent with the autosave path.
        safeStorage.set(
          draftKey,
          JSON.stringify({ savedAt: Date.now(), data }),
        )
      }
      if (e instanceof Error && e.name === 'AbortError') {
        toast.error(
          "That took too long. Try again — we've saved your changes on this device.",
        )
      } else {
        toast.error(
          "We can't reach the server right now. Your changes are saved on this device.",
        )
      }
    } finally {
      inFlightRef.current = false
      if (mountedRef.current) setBusy(false)
      emitSaveEnd(saveStatusId, saveOk)
      // Drop any unflushed buffered typing. The success path above
      // already flushed it; reaching the finally with pendingDataRef
      // still set means we hit an error / mountedRef-false /
      // closingRef-true exit. Leaving the buffer in place would
      // resurrect this typing on the NEXT successful save —
      // overwriting whatever the operator typed after recovering
      // from the error.
      pendingDataRef.current = null
    }
  }, [
    blockId,
    blockType,
    data,
    dispatch,
    draftKey,
    isContainer,
    kindNoun,
    pageId,
    recordCommand,
    router,
    runUndo,
    toast,
  ])

  // Preview-overlay cleanup safety net. Every documented close path
  // (tryClose, discardAndClose, post-save) sets closingRef and
  // dispatches clear-preview explicitly. This effect handles
  // unexpected unmounts (parent conditional render swap, error
  // boundary catch, hot-reload) so a stranded preview overlay can't
  // lock the canvas in a previewed state with no UI to dismiss it.
  useEffect(() => {
    return () => {
      if (!closingRef.current) {
        dispatch({ type: 'clear-preview', blockId })
      }
    }
  }, [blockId, dispatch])

  const allShapes = useMemo<FieldShape[]>(
    () => SHAPES_FOR_BLOCK[blockType] ?? [],
    [blockType],
  )
  const tabShapes = useMemo(() => {
    const buckets: Record<TabKey, FieldShape[]> = {
      content: [],
      style: [],
      advanced: [],
      crm: [],
    }
    for (const s of allShapes) buckets[tabForShape(s)].push(s)
    return buckets
  }, [allShapes])

  // Widget types that own a `crmDestinations` field. Surface the CRM
  // tab only for these — every other widget keeps the existing 3-tab
  // bar. Currently the contact_form widget is the only one with
  // crmDestinations in its block-registry schema; extending CRM
  // dispatch to a future form widget = (1) add the field to that
  // block's Zod schema and (2) add its type to this set.
  const widgetHasCrm = blockType === 'contact_form'

  // crmDestinations array — read from data; falls back to [] when
  // the block has never been configured. Updates flow through
  // handleSetData so the existing autosave + dirty-tracking pipeline
  // catches them automatically.
  type CrmDest = NonNullable<Record<string, unknown>>
  const crmDestinations = useMemo(
    () => (Array.isArray((data as Record<string, unknown>)?.crmDestinations)
      ? ((data as Record<string, unknown>).crmDestinations as CrmDest[])
      : []) as Array<{ provider: 'hubspot' | 'zoho' } & Record<string, unknown>>,
    [data],
  )

  const visibleTabs = useMemo(() => {
    const tabs: Array<{ key: TabKey; label: string; count: number }> = []
    tabs.push({ key: 'content', label: 'Content', count: tabShapes.content.length })
    if (tabShapes.style.length > 0) {
      tabs.push({ key: 'style', label: 'Style', count: tabShapes.style.length })
    }
    if (tabShapes.advanced.length > 0) {
      tabs.push({
        key: 'advanced',
        label: 'Advanced',
        count: tabShapes.advanced.length,
      })
    }
    if (widgetHasCrm) {
      tabs.push({ key: 'crm', label: 'CRM', count: crmDestinations.length })
    }
    return tabs
  }, [tabShapes, widgetHasCrm, crmDestinations.length])

  const activeShapes = tabShapes[activeTab]

  return (
    <Drawer
      open
      onClose={tryClose}
      width="lg"
      tone="dark"
      resizable
      resizeStorageKey="cavecms:drawer-width:edit"
      // Full-height, on top of ALL page chrome (site header + admin bar).
      // The Drawer portals to <body> and renders at z-[85] (above the
      // admin bar's z-60), so the editor panel is never trapped behind a
      // sticky header's stacking context. Close the panel to get the
      // admin bar back.
      // Editor side-panel: keep the canvas scrollable behind the drawer so
      // the operator can scroll to other blocks while editing. Mobile (the
      // 85vh bottom-sheet) still locks scroll — handled inside Drawer.
      allowBackgroundScroll
    >
      {/* Header — bold, copper eyebrow + serif title + block-type pill.
         Dark-tone restyle: cream/near-black flipped, copper accent
         survives the inversion (it was always the brand colour on
         either side). */}
      <header className="sticky top-0 z-10 border-b border-cream-50/12 bg-near-black/95 px-6 pt-6 pb-0 backdrop-blur-md">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-300">
              {eyebrow}
            </p>
            <h2 className="font-serif text-2xl font-bold tracking-tight text-cream-50">
              {displayNameFor(blockType, data, blockId, blockKey ?? null)}
            </h2>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-cream-50/8 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50/65 ring-1 ring-cream-50/10">
              #{blockId} · v{versions.blockVersion}
            </span>
          </div>
          <button
            onClick={tryClose}
            disabled={busy}
            aria-label={`Close ${kindNoun.toLowerCase()} editor`}
            // Disabled while a save is in flight so the operator can't
            // discard-and-close mid-PATCH — that path would still
            // persist the in-flight data server-side AND dispatch
            // block-saved into the now-unmounted drawer's context,
            // contradicting the operator's "discard" intent.
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-cream-50/70 transition-colors hover:bg-cream-50/10 hover:text-cream-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={17} strokeWidth={2.2} />
          </button>
        </div>

        {/* Tab bar — only renders tabs that have at least one field */}
        {visibleTabs.length > 1 && (
          <nav
            role="tablist"
            aria-label={`${eyebrow} tabs`}
            className="mt-5 flex items-center gap-1 border-b border-cream-50/10"
          >
            {visibleTabs.map((t) => {
              const active = t.key === activeTab
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(t.key)}
                  className={clsx(
                    '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-colors',
                    active
                      ? 'border-copper-400 text-cream-50'
                      : 'border-transparent text-cream-50/55 hover:text-cream-50',
                  )}
                >
                  {t.label}
                  <span
                    className={clsx(
                      'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-[9px]',
                      active
                        ? 'bg-copper-400/20 text-copper-200'
                        : 'bg-cream-50/10 text-cream-50/60',
                    )}
                  >
                    {t.count}
                  </span>
                </button>
              )
            })}
          </nav>
        )}
        {/* Spacer when only one tab — keep ~14px breathing room */}
        {visibleTabs.length <= 1 && <div className="h-3" />}
      </header>

      {/* Scrollable form region */}
      <fieldset disabled={busy} className="contents">
        <div className="px-6 pt-6 pb-28">
          {allShapes.length === 0 ? (
            <div className="rounded-2xl border border-copper-400/40 bg-copper-500/10 p-5 text-sm text-copper-100">
              <p className="font-semibold">
                This {kindNoun.toLowerCase()} type can&rsquo;t be edited here yet.
              </p>
              <p className="mt-1.5 text-copper-200/80">
                Please let an admin know so a form can be added for it.
              </p>
            </div>
          ) : activeTab === 'crm' && widgetHasCrm ? (
            <CrmDestinationsPanel
              destinations={crmDestinations as never}
              onChange={(next) => handleSetData({ ...(data as Record<string, unknown>), crmDestinations: next })}
            />
          ) : activeShapes.length === 0 ? (
            // F6 — point operators to the right control instead of a
            // dead-end. Pre-fix: "No style settings for this widget
            // yet." gave no hint about the per-side spacing toolbar
            // or section-level anchor/visibility. Per-kind / per-tab
            // copy tells the operator where to actually find the
            // setting they were looking for.
            <p className="px-1 text-sm leading-relaxed text-cream-50/60">
              {(() => {
                const isWidget = !isContainer
                if (activeTab === 'style') {
                  if (isWidget) {
                    return 'Use the per-side spacing controls on the block toolbar to adjust padding and margin for this block.'
                  }
                  return `No style settings for this ${kindNoun.toLowerCase()} yet.`
                }
                if (activeTab === 'advanced') {
                  if (isWidget) {
                    return 'Anchor links and visibility are configured on the parent section, not the individual block.'
                  }
                  return `No advanced settings for this ${kindNoun.toLowerCase()} yet.`
                }
                return `No ${activeTab} settings for this ${kindNoun.toLowerCase()} yet.`
              })()}
            </p>
          ) : (
            <ZodForm
              shapes={activeShapes}
              value={data}
              onChange={handleSetData}
            />
          )}
        </div>
      </fieldset>

      {/* Sticky save bar — premium pill state indicator. On the dark
         drawer, the Save CTA leans on copper (the brand accent) so it
         reads as the primary action without competing with the white
         pill the old design used.
         Layout: `flex-wrap` + per-item `whitespace-nowrap` so when the
         drawer is pulled down to MIN width the row reflows to two
         lines instead of breaking "SAVE\nCHANGES" / "NO\nCHANGES\nYET".
         `ml-auto` on the status pill still right-aligns it within its
         wrap row, so a wrapped status sits flush right on its own
         line — preserves the "actions on the left, state on the
         right" reading order at every width. */}
      <footer className="sticky bottom-0 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-cream-50/12 bg-near-black/95 px-6 py-4 backdrop-blur-md">
        <button
          type="button"
          disabled={busy || !dirty || allShapes.length === 0}
          onClick={save}
          className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-copper-500 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black shadow-[0_8px_22px_-10px_rgba(184,115,51,0.55)] transition-all hover:bg-copper-400 hover:shadow-[0_10px_28px_-10px_rgba(184,115,51,0.65)] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          {busy ? (
            <>
              <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Check size={12} strokeWidth={2.4} />
              Save changes
            </>
          )}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={tryClose}
          className="shrink-0 whitespace-nowrap rounded-full border border-cream-50/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:border-cream-50 disabled:opacity-50"
        >
          Close
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.16em]">
          {dirty ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-copper-300">
              <span className="inline-flex h-2 w-2 rounded-full bg-copper-400 animate-cavecms-pulse-copper" />
              Unsaved
            </span>
          ) : lastSavedAt !== null ? (
            // Post-save: show the "Saved" pill AND a persistent Undo
            // link. The page-level toast's "Undo" carries the same
            // affordance but auto-fades; the drawer's button is the
            // mouse-user fallback for when the toast already
            // dismissed. Click routes through runUndo + closes the
            // drawer (the form fields would otherwise hold the new
            // value the canvas just reverted from — re-open to see
            // the reverted state). Audit finding E6 (Chunk K).
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-copper-300">
                <Check size={11} strokeWidth={2.6} />
                Saved
              </span>
              <button
                type="button"
                // Disabled while a save is in flight — `runUndo` would
                // otherwise fire the inverse PATCH while the forward
                // save's `inFlightRef` is still set in the
                // UndoStackProvider, and the resulting double-flight
                // would race the optimistic-state dispatches. The
                // post-save state can't actually appear with busy=true
                // (lastSavedAt is set INSIDE the save success path
                // AFTER busy is reset), but the guard is defensive
                // for any future code path that flips busy back on.
                disabled={busy}
                onClick={() => {
                  void runUndo()
                  onClose()
                }}
                className="inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-copper-200/80 underline decoration-copper-200/40 underline-offset-2 transition-colors hover:bg-cream-50/5 hover:text-copper-100 hover:decoration-copper-200/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-300/50 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Undo the last save"
              >
                Undo
              </button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-cream-50/50">
              <CloudOff size={11} strokeWidth={2} />
              No changes yet
            </span>
          )}
        </div>
      </footer>
      {confirmClose && (
        <ConfirmModal
          ariaLabel="Discard unsaved changes?"
          title="Discard your changes?"
          description={`You have unsaved edits to this ${kindNoun.toLowerCase()}. Closing now drops them — there is no undo.`}
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          destructive
          onCancel={() => setConfirmClose(false)}
          onConfirm={discardAndClose}
        />
      )}
    </Drawer>
  )
}
