'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import { Move } from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import {
  parseColumnMeta,
  parseSectionMeta,
  parseWidgetMeta,
} from '@/lib/cms/blockMeta'
import type { SpacingMeta, SpacingValue } from '@/lib/cms/spacingClasses'
import type { BlockKind } from '@/lib/cms/blockMeta'
import {
  useEffectiveVersions,
  useInlineEditDispatch,
} from './InlineEditContext'
import { useRecordCommand } from './UndoStackProvider'
import { emitSaveBegin, emitSaveEnd } from './SaveStatusIndicator'
import { SpacingPopover } from './SpacingPopover'
import { SpacingOverlay } from './SpacingOverlay'

// Chunk E orchestrator. Owns the in-flight spacing draft, the 400ms
// debounced auto-save against /api/cms/blocks/[id], the optimistic
// preview overlay merge (so the canvas reflects the change instantly
// while the PATCH is in flight), and the rollback path on 409 /
// network error.
//
// Mounted by EditableSection / EditableColumn / EditableBlock. The
// trigger button sits INSIDE each parent's action-toolbar pill rather
// than as the spec's 4th floating element at -top-3. Rationale: the
// pill already groups related affordances with separators, the
// section-level chrome at -top-3 is already crowded by the grip
// handle (left-1/2) and the type-pill (left-6), and adding a 4th
// floating element on the same row would clip on narrow viewports.
// Operators find the spacing control in the same place they look for
// Settings — discoverability win.

// Local alias for the canonical BlockKind — kept so this file's many
// `Kind` references don't have to be renamed in one go.
type Kind = BlockKind

export interface SpacingToolbarProps {
  blockId: number
  kind: Kind
  /** Persisted meta blob from the server. Toolbar diffs its in-flight
   *  draft against this to build the next PATCH body. Re-syncs on
   *  `initialVersion` bumps (which fire after a successful save or
   *  any external sibling edit). */
  initialMeta: unknown
  initialVersion: number
  pageId: number
  initialPageVersion: number
  /** Element the overlay paints to. Typically the parent
   *  Editable* component's outer wrapper ref. */
  targetRef: React.RefObject<HTMLElement | null>
}

const KIND_LABEL: Record<Kind, 'Section' | 'Column' | 'Widget'> = {
  section: 'Section',
  column: 'Column',
  widget: 'Widget',
}

// Single source of truth for the 8 spacing axes. Used by every
// spreader below (pickSpacing, assignSpacing, the popover's per-side
// stepper grid) — a future tier addition only needs SPACING_TIERS in
// spacingTokens.ts; the 8-axis list itself is structurally fixed.
const SPACING_AXES = [
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
] as const satisfies ReadonlyArray<keyof SpacingMeta>

// Extracts JUST the SpacingMeta axes from a meta blob. The parsers
// already discriminate by kind, but the toolbar only cares about the
// spacing slice — the non-spacing keys (background, padding shorthand,
// width, columns) are preserved by merging back in buildNextMeta.
function extractSpacing(kind: Kind, meta: unknown): SpacingMeta {
  if (kind === 'section') return pickSpacing(parseSectionMeta(meta))
  if (kind === 'column') return pickSpacing(parseColumnMeta(meta))
  return parseWidgetMeta(meta)
}

// "Is this axis set?" predicate. Mirrors hasSpacingOverride in
// spacingClasses.ts — tier strings (including 'none') and numbers
// (including 0) are both real overrides; only `undefined` means
// "operator hasn't touched this side". A naive `if (v)` would silently
// drop numeric 0, which is a legitimate operator value (explicit zero
// padding via the px input).
function isAxisSet(v: SpacingValue | undefined): v is SpacingValue {
  return v !== undefined
}

function pickSpacing(p: SpacingMeta): SpacingMeta {
  // Only emit defined sides — undefined axes are omitted so a
  // downstream JSON.stringify doesn't store `"paddingTop": undefined`
  // (mysql2 would persist that as null rather than absent).
  const out: SpacingMeta = {}
  for (const k of SPACING_AXES) {
    const v = p[k]
    if (isAxisSet(v)) out[k] = v
  }
  return out
}

// Build the FULL next meta blob the server expects. Section/column
// must include the existing non-spacing keys (background, padding,
// columns, width) so the .strict() schema doesn't drop them. Widget
// only carries spacing meta.
function buildNextMeta(
  kind: Kind,
  initialMeta: unknown,
  spacing: SpacingMeta,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (kind === 'section') {
    const p = parseSectionMeta(initialMeta)
    out['columns'] = p.columns
    out['background'] = p.background
    out['padding'] = p.padding
  } else if (kind === 'column') {
    const p = parseColumnMeta(initialMeta)
    if (p.width !== undefined) out['width'] = p.width
  }
  for (const k of SPACING_AXES) {
    const v = spacing[k]
    if (isAxisSet(v)) out[k] = v
  }
  return out
}

const SAVE_DEBOUNCE_MS = 400

export function SpacingToolbar({
  blockId,
  kind,
  initialMeta,
  initialVersion,
  pageId,
  initialPageVersion,
  targetRef,
}: SpacingToolbarProps) {
  const router = useRouter()
  const dispatch = useInlineEditDispatch()
  const recordCommand = useRecordCommand()
  const versions = useEffectiveVersions(blockId, {
    blockVersion: initialVersion,
    pageVersion: initialPageVersion,
  })

  // In-flight spacing draft. Re-syncs to the persisted meta whenever
  // the row's version bumps (post-save reconciliation or sibling
  // edit). Memoising the extracted spacing prevents stable-reference
  // churn from triggering unnecessary draft resets.
  const persistedSpacing = useMemo(
    () => extractSpacing(kind, initialMeta),
    [kind, initialMeta],
  )
  const [draft, setDraft] = useState<SpacingMeta>(persistedSpacing)
  const lastSyncedVersionRef = useRef(initialVersion)
  useEffect(() => {
    if (initialVersion !== lastSyncedVersionRef.current) {
      lastSyncedVersionRef.current = initialVersion
      setDraft(persistedSpacing)
    }
  }, [initialVersion, persistedSpacing])

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // FRESHNESS REFS — H-C from review: a pending debounce timer
  // captures `doSave` at scheduleSave-time, which captures `versions`
  // + `initialMeta` + `persistedSpacing` at useCallback-build time.
  // After a sibling save bumps the page cursor, those values are
  // stale until the next render rebuilds the chain. The timer fires
  // with stale values → server 409 → operator's draft wiped. Refs
  // updated on every render hold the latest values so doSave can
  // re-read at fire-time.
  const versionsRef = useRef(versions)
  versionsRef.current = versions
  const initialMetaRef = useRef(initialMeta)
  initialMetaRef.current = initialMeta
  const persistedSpacingRef = useRef(persistedSpacing)
  persistedSpacingRef.current = persistedSpacing
  // Trigger ref + popover-close focus restore (H-A). Without this,
  // pressing Esc drops focus to body, the action-toolbar pill hides
  // (only visible on group-hover/focus-within), and keyboard users
  // lose their place.
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // Debounce + abort plumbing. The timer holds the pending save; the
  // AbortController is associated with the in-flight fetch so a newer
  // change can cancel it cleanly.
  const saveTimerRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Cleanup on unmount — cancel any pending debounce + abort the live
  // request so a navigation mid-save doesn't fire a stale dispatch
  // against an unmounted reducer slot.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      abortRef.current?.abort()
    }
  }, [])

  const doSave = useCallback(
    async (nextSpacing: SpacingMeta) => {
      // Read latest values from refs at FIRE time (H-C). The closure
      // captures only blockId/kind/pageId/dispatch which are stable.
      const liveVersions = versionsRef.current
      const liveInitialMeta = initialMetaRef.current
      const livePersistedSpacing = persistedSpacingRef.current
      // Cancel any in-flight save — the operator's latest click wins.
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setBusy(true)
      setErrorMessage(null)
      const nextMeta = buildNextMeta(kind, liveInitialMeta, nextSpacing)
      // Broadcast to the global save-status indicator. id keys on
      // blockId so rapid in-flight saves on the SAME block coalesce
      // (the indicator dedupes by id).
      const saveStatusId = `spacing:${blockId}`
      emitSaveBegin(saveStatusId)
      let saveOk = false
      try {
        const res = await csrfFetch(`/api/cms/blocks/${blockId}`, {
          method: 'PATCH',
          signal: ac.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pageId,
            blockVersion: liveVersions.blockVersion,
            pageVersion: liveVersions.pageVersion,
            meta: nextMeta,
          }),
        })
        if (!res.ok) {
          const status = res.status
          // 409 = stale version — server tree advanced (sibling save,
          // concurrent edit). Roll back the local draft to the latest
          // persisted state AND trigger router.refresh so the parent
          // re-renders with the authoritative server state. Without
          // the refresh, persistedSpacing remains stale and the
          // operator's next retry would 409 again. (H-D fix.)
          if (status === 409) {
            setErrorMessage(
              'Someone else changed this. The latest spacing has been re-fetched.',
            )
            setDraft(livePersistedSpacing)
            dispatch({ type: 'clear-preview', blockId })
            router.refresh()
            return
          }
          // 400 / 4xx other = client error (malformed payload).
          // 5xx = server side. Same UX: surface a hint, roll back.
          setErrorMessage("Couldn't save spacing. Try again.")
          setDraft(livePersistedSpacing)
          dispatch({ type: 'clear-preview', blockId })
          return
        }
        const j = (await res.json()) as {
          blockVersion: number
          pageVersion: number
        }
        // block-meta-saved replaces meta + version on the matched
        // block in state.blocks, bumps pageVersion, clears the
        // preview overlay (the persisted shape now matches), and
        // sets a versionOverrides entry so a sibling save sees the
        // freshest token immediately.
        dispatch({
          type: 'block-meta-saved',
          blockId,
          meta: nextMeta,
          blockVersion: j.blockVersion,
          pageVersion: j.pageVersion,
        })
        saveOk = true
        // ── Chunk J — record SPACING (edit-meta) on the undo stack ──
        // Forward: PATCH new meta with pre-save versions (deriveRebind
        // updates these on subsequent cycles). Inverse: PATCH the prior
        // meta with the post-save versions. Each stepper click records
        // one command — acceptable for V1; a coalesced "session" undo
        // (capture initial at open, single command at close) is Phase 2.
        const priorMeta = buildNextMeta(kind, liveInitialMeta, livePersistedSpacing)
        // Reset detection — the operator's Reset button clears all 8
        // axes in one gesture. Surfacing the SAME "Adjusted spacing"
        // toast for a Reset as for a single nudge is misleading: 8
        // axes just got wiped, the operator deserves to see that.
        // Detection: every axis in next is undefined AND at least one
        // axis was set before. isAxisSet mirrors the !== undefined
        // predicate used at the meta boundary.
        const nextAxesSet = SPACING_AXES.filter((k) => isAxisSet(nextSpacing[k])).length
        const priorAxesSet = SPACING_AXES.filter((k) => isAxisSet(livePersistedSpacing[k])).length
        const isReset = nextAxesSet === 0 && priorAxesSet > 0
        recordCommand({
          kind: 'edit-meta',
          label: isReset ? 'Reset spacing' : 'Adjusted spacing',
          timestamp: Date.now(),
          forward: {
            method: 'PATCH',
            path: `/api/cms/blocks/${blockId}`,
            body: {
              pageId,
              blockVersion: liveVersions.blockVersion,
              pageVersion: liveVersions.pageVersion,
              meta: nextMeta,
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
              meta: priorMeta,
            },
            expects: 200,
          },
          captures: {
            blockId,
            blockVersion: j.blockVersion,
            pageVersion: j.pageVersion,
          },
        })
      } catch (e) {
        // AbortError fires when a newer save supersedes this one OR
        // the component unmounts mid-flight. Silently return — the
        // newer save (or cleanup) will handle its own state.
        if (ac.signal.aborted) return
        setErrorMessage(
          e instanceof Error && e.name === 'AbortError'
            ? null
            : 'Network error. Try again.',
        )
        setDraft(persistedSpacingRef.current)
        dispatch({ type: 'clear-preview', blockId })
      } finally {
        if (!ac.signal.aborted) setBusy(false)
        // Emit end-of-save regardless of outcome, but only if we
        // weren't superseded by a newer save (which would have its
        // own begin/end pair). The abort path is intentionally
        // silent — the newer save's pair represents the operator's
        // intent.
        if (!ac.signal.aborted) emitSaveEnd(saveStatusId, saveOk)
      }
    },
    // Deps shrink to genuinely stable values now that the variable
    // ones live on refs. doSave identity now only flips when the
    // block/kind/page identity changes — never per render.
    [blockId, dispatch, kind, pageId, recordCommand, router],
  )

  const scheduleSave = useCallback(
    (nextSpacing: SpacingMeta) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null
        void doSave(nextSpacing)
      }, SAVE_DEBOUNCE_MS)
    },
    [doSave],
  )

  // Reducer now merges set-preview payloads (M-A fix in
  // InlineEditContext), so the toolbar dispatches only its OWN
  // spacing-shaped fields — no need to read state.previews here. The
  // drawer's preview keys persist through this dispatch; the spacing
  // keys are layered on top in the reducer.
  //
  // Reset semantics: when the operator clicks Reset, `next` is {}.
  // Emit explicit `undefined` for EVERY spacing axis so the merge
  // wipes any previously-set tier from the preview map. Without this,
  // `for ... if (v) ...` would skip the cleared axes, the reducer
  // would merge an empty object into the existing slot, and the
  // canvas would render the old spacing for the full 400ms debounce
  // window. parseWidgetMeta drops `undefined` tier values via
  // isSpacingTier so the downstream render correctly omits the axis.
  const handleChange = useCallback(
    (next: SpacingMeta) => {
      setDraft(next)
      const previewPayload: Record<string, unknown> = {}
      for (const k of SPACING_AXES) {
        // Emit the key unconditionally — `next[k]` is either the tier
        // string OR undefined. Undefined values overwrite stale tier
        // entries in the merged preview slot.
        previewPayload[k] = next[k]
      }
      dispatch({
        type: 'set-preview',
        blockId,
        data: previewPayload,
      })
      scheduleSave(next)
    },
    [blockId, dispatch, scheduleSave],
  )

  // closePopover — flush any pending save + restore focus to trigger.
  // H-A: focus restore. H-B: flush pending save so the operator's
  // last click isn't dropped if they close-then-navigate inside 400ms.
  const closePopover = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      // Flush the pending save synchronously so the in-flight gesture
      // lands. doSave is async — fire-and-forget; abort plumbing
      // handles a follow-up close-during-save correctly.
      void doSave(draft)
    }
    setOpen(false)
    setErrorMessage(null)
    // Restore focus on the next microtask so the popover's unmount
    // has settled (otherwise the focus call races with React's commit
    // and focus lands on body).
    queueMicrotask(() => {
      triggerRef.current?.focus()
    })
  }, [doSave, draft])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Edit ${KIND_LABEL[kind].toLowerCase()} spacing`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy}
        title={`Spacing (padding & margin)`}
        // Chunk H — stable selector for the context menu's widget
        // "Spacing" verb. The handler does a programmatic click() on
        // this trigger rather than lifting open-state to a controlled
        // pattern. Smaller surface area than reshaping the public API
        // of this toolbar; same end result (toolbar's existing toggle
        // logic flips open ↔ closed and brings up the popover).
        data-spacing-toolbar-trigger={blockId}
        onClick={(e) => {
          e.stopPropagation()
          if (open) {
            closePopover()
          } else {
            setOpen(true)
          }
        }}
        className={clsx(
          'inline-flex h-11 w-11 items-center justify-center rounded-full text-cream-50 transition-all hover:scale-105 focus-visible:scale-105 focus-visible:outline-none focus-visible:bg-copper-500 hover:bg-copper-500 motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100',
          open && 'bg-copper-500',
        )}
      >
        <Move size={15} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {open && (
        <>
          <SpacingPopover
            blockId={blockId}
            value={draft}
            onChange={handleChange}
            onClose={closePopover}
            errorMessage={errorMessage}
            kindLabel={KIND_LABEL[kind]}
          />
          <SpacingOverlay targetRef={targetRef} meta={draft} />
        </>
      )}
    </>
  )
}
