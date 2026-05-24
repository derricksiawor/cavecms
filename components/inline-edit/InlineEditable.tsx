'use client'

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { sanitizeRichText } from '@/lib/cms/sanitize-shared'
import { useToast } from './Toast'
import {
  setFieldValue,
  type InlineEditKind,
} from '@/lib/cms/inlineEditableFields'
import {
  useEffectiveVersions,
  useInlineEditDispatch,
} from './InlineEditContext'
import { useSlashCommand } from './SlashCommandProvider'
import { emitSaveBegin, emitSaveEnd } from './SaveStatusIndicator'

const AUTOSAVE_MS = 800

type AnyTag = 'div' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote' | 'span'

// Runtime tag allowlist — narrows the polymorphic `as` prop at the
// DOM emission boundary so a hostile (or accidentally-typed) caller
// can't push e.g. `'script'` through and have React render it.
// h5/h6 added in Chunk F for the Heading widget — its level field
// covers the full h1..h6 range.
const ALLOWED_TAGS: ReadonlySet<AnyTag> = new Set<AnyTag>([
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'span',
])

export interface InlineEditableProps {
  blockId: number
  blockVersion: number
  pageId: number
  pageVersion: number
  /** Full widget data object — the changed field is merged on save.
   *  Accepts `unknown` rather than the narrower `Record<string, unknown>`
   *  so typed `BlockData<T>` payloads pass through without 49 unsafe
   *  `as unknown as Record<string, unknown>` casts at every block-renderer
   *  call site. `setFieldValue` internally narrows `unknown` correctly
   *  via the field-path walker — the cast was buying nothing. */
  initialData: unknown
  /** Field path inside initialData this editor writes. Top-level keys
   *  (`'text'`) and nested paths (`'image.alt'`) are both accepted; for
   *  array-indexed paths (`'items[].title'`) the caller passes the
   *  index per `[]` marker via `arrayIndices`. The merge step uses
   *  `setFieldValue` so untouched siblings stay reference-stable. */
  field: string
  /** Indices for array segments in `field`. One entry per `[]` marker
   *  in path order. Empty for top-level + nested-scalar paths. */
  arrayIndices?: readonly number[]
  /** 'plain' strips paste-to-text; 'richtext' allows DOMPurify allowlist. */
  kind: InlineEditKind
  /** Initial value of the field. Written to the contentEditable post-mount. */
  initialValue: string
  /** Tailwind classes applied to the contentEditable wrapper. */
  className?: string
  /** Element type — 'p' for quote, 'h2' for cta title, 'div' for text body. */
  as?: AnyTag
  /** Faint placeholder shown when the editor is empty (data-placeholder). */
  placeholder?: string
  /** Inline style passthrough (caller may add e.g. text-align). */
  style?: CSSProperties
}

/**
 * In-place text/rich-text editor mounted directly on the public-page
 * editor surface. Wraps a single scalar field of a widget block. The
 * server (PATCH /api/cms/blocks/[id]) remains the trust boundary —
 * parseAndSanitize re-validates every payload.
 *
 * Save triggers (any of):
 *   - 800 ms debounce after last keystroke
 *   - blur
 *   - Cmd / Ctrl + Enter
 *
 * Esc reverts to the last server-confirmed value and blurs.
 *
 * Version contract (matches PATCH /api/cms/blocks/[id]):
 *   - Optimistic bump on success — local state holds new (blockVersion,
 *     pageVersion); the next save sends those. A router.refresh fires
 *     in a transition so EditDrawer + sibling InlineEditable instances
 *     receive the fresh versions through their server props.
 *   - 409 → toast, set stale flag, router.refresh; further saves
 *     are blocked until the server's authoritative versions arrive.
 *   - 422 → toast + revert local DOM to last saved value.
 *
 * Sanitisation:
 *   - 'plain' fields: paste strips to text; rendered as textContent.
 *   - 'richtext' fields: paste strips to text (Word/Docs noise breaks
 *     the allowlist anyway); pre-save sanitizeRichText runs the SAME
 *     DOMPurify allowlist the server uses, so the editor never displays
 *     a tag the server would strip on persist.
 *
 * Caret survival across router.refresh:
 *   - The sync useEffect ONLY overwrites the DOM when the live content
 *     equals the last server-confirmed value (`savedValue`). When the
 *     operator has un-PATCHed typing in flight, the effect skips the
 *     write — caret AND draft survive the reconcile.
 */
export function InlineEditable(props: InlineEditableProps) {
  const router = useRouter()
  const toast = useToast()
  const dispatch = useInlineEditDispatch()
  const slashCommand = useSlashCommand()
  const editorRef = useRef<HTMLElement | null>(null)
  const [, startTransition] = useTransition()
  // Last value the server confirmed. Esc reverts to this; readValue
  // compares against this to decide whether to PATCH at all.
  const [savedValue, setSavedValue] = useState(props.initialValue)
  // Mirror state in a ref so `commit()`'s useCallback closure isn't
  // capturing a stale `savedValue` after a previous in-flight save
  // bumped state (review H2 — closure race).
  const savedValueRef = useRef(props.initialValue)
  // Current draft. Updated on every input; PATCHed on commit.
  const draftRef = useRef(props.initialValue)
  // Chunk B: (blockVersion, pageVersion) are lifted to InlineEditContext.
  // useEffectiveVersions returns the freshest cursor — a per-block
  // override set by the last save here OR by a sibling save (drawer,
  // peer InlineEditable). Falls back to props for the first render
  // before any override has landed. Read into a ref for commit()'s
  // closure since the hook value can change between renders.
  const versions = useEffectiveVersions(props.blockId, {
    blockVersion: props.blockVersion,
    pageVersion: props.pageVersion,
  })
  const versionsRef = useRef(versions)
  useEffect(() => {
    versionsRef.current = versions
  }, [versions])
  // Latest committed widget data — successive edits merge against the
  // most recent server-acknowledged shape so untouched sibling fields
  // (e.g. text.heading while editing text.body_richtext) aren't
  // clobbered with the value the parent component had at mount.
  //
  // Coerce `unknown` → object at the boundary. Block payloads are always
  // objects post-Zod parse; this defensive narrow handles the (currently
  // impossible) case where a malformed payload reaches here and prevents
  // a spread crash that would brick the editor.
  const dataRef = useRef<Record<string, unknown>>(
    props.initialData &&
      typeof props.initialData === 'object' &&
      !Array.isArray(props.initialData)
      ? { ...(props.initialData as Record<string, unknown>) }
      : {},
  )
  const [busy, setBusy] = useState(false)
  // After a 409 we're holding a stale version cursor until the
  // router.refresh-driven re-render arrives. Block further commits
  // in the gap — the next versions-change releases the gate. Avoids
  // the 409→retry storm flagged in review.
  //
  // Track BOTH axes — server-side 409 can be triggered by EITHER
  // stale_block_version OR stale_page_version (a sibling-block save
  // bumps pages.version while this row's block.version stays put).
  // Tracking only blockVersion would never release the gate when the
  // 409 was a pageVersion conflict because the row's blockVersion
  // wouldn't advance, freezing the operator out of this widget.
  const [stale, setStale] = useState(false)
  const staleVersionRef = useRef<{
    blockVersion: number
    pageVersion: number
  } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  // Mounted guard — `EditModeDndShell` does the same. A slow PATCH that
  // resolves AFTER an edit-mode toggle / route change would otherwise
  // call setState + fire `router.refresh` on a torn-down component.
  const mountedRef = useRef(true)

  // Always keep dataRef synced with the latest props.initialData so that
  // sibling fields (heading vs body_richtext on a `text` widget) updated
  // by a peer admin via the drawer don't get clobbered on our next save.
  // Our field is overlaid from the live draft so the operator's
  // in-progress typing isn't lost when the parent re-renders.
  // Deps narrow to the two values the merge depends on — without them
  // this effect was firing per render (every context dispatch) and
  // allocating a fresh data object each time. GC pressure per keystroke
  // on widgets with large payloads (gallery image arrays, long
  // rich-text bodies). The merge-with-draft is still correct: when
  // props.initialData changes (post-save propagation), the draft
  // overlay applies; in between, dataRef is stable.
  // Stable string fingerprint for the arrayIndices array. Callers pass
  // a fresh literal (`arrayIndices={[i]}`) each render, so depending on
  // the array reference identity re-fires effects/callbacks every parent
  // render — for a 20-row Accordion in edit mode that's 40 full-payload
  // shallow-clones per render. Stringifying gives a stable dep when the
  // indices haven't changed (the typical case during an edit session).
  const arrayIndicesKey = (props.arrayIndices ?? []).join(',')
  // Mirror into a ref so callbacks (commit) can read the live value
  // without depending on the identity-churning array directly.
  const arrayIndicesRef = useRef<readonly number[] | undefined>(props.arrayIndices)
  useEffect(() => {
    arrayIndicesRef.current = props.arrayIndices
  }, [props.arrayIndices])

  useEffect(() => {
    // setFieldValue handles top-level keys, nested paths, AND
    // array-indexed paths uniformly — passing `[]` for arrayIndices
    // when the path has no `[]` markers is a no-op walk.
    const baseObj: Record<string, unknown> =
      props.initialData &&
      typeof props.initialData === 'object' &&
      !Array.isArray(props.initialData)
        ? (props.initialData as Record<string, unknown>)
        : {}
    const merged = setFieldValue(
      { ...baseObj },
      props.field,
      draftRef.current,
      props.arrayIndices ?? [],
    )
    dataRef.current =
      merged && typeof merged === 'object' && !Array.isArray(merged)
        ? (merged as Record<string, unknown>)
        : { ...baseObj }
    // arrayIndicesKey is the stable signal; props.arrayIndices identity
    // can churn freely without re-firing this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialData, props.field, arrayIndicesKey])

  // Keep refs in lockstep with state so commit()'s closure sees fresh
  // values without re-creating itself per render.
  useEffect(() => {
    savedValueRef.current = savedValue
  }, [savedValue])

  // Sync DOM only when the server has sent us a value we haven't seen
  // AND the operator hasn't typed past their last-saved baseline. This
  // is the caret-survival guard: an operator who typed "Hello world"
  // and is mid-save sees props.initialValue=="Hello" briefly land
  // before their later save; without this guard the DOM would be
  // overwritten and the " world" suffix lost.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (props.initialValue === savedValueRef.current) return
    const live = props.kind === 'richtext' ? el.innerHTML : el.textContent ?? ''
    // Operator has un-PATCHed edits — keep them; their next save will
    // either succeed (and bump savedValue locally) or 409 (and we'll
    // resync after refresh via this same effect once they accept the
    // server's copy by typing more or by Esc-reverting).
    if (live !== savedValueRef.current) return
    if (props.kind === 'richtext') el.innerHTML = props.initialValue || ''
    else el.textContent = props.initialValue || ''
    draftRef.current = props.initialValue
    setSavedValue(props.initialValue)
  }, [props.initialValue, props.kind])

  // Stale-gate release. When EITHER the per-block cursor OR the page
  // cursor advances past what we 409'd on, the operator's next commit
  // is allowed through. Cross-axis release closes the lockout that
  // would otherwise pin the editor when the 409 was caused by a
  // sibling-block save bumping pages.version.
  useEffect(() => {
    if (!stale) return
    const captured = staleVersionRef.current
    if (captured === null) return
    if (
      versions.blockVersion > captured.blockVersion ||
      versions.pageVersion > captured.pageVersion
    ) {
      setStale(false)
      staleVersionRef.current = null
    }
  }, [stale, versions.blockVersion, versions.pageVersion])

  // Initial DOM seed — set after mount so React doesn't compete with
  // a `dangerouslySetInnerHTML`/`children` prop on every render diff
  // (which would otherwise reset caret position when the component
  // re-renders for any reason). The sync effect above handles all
  // subsequent updates.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (props.kind === 'richtext') {
      if (el.innerHTML !== props.initialValue) {
        el.innerHTML = props.initialValue || ''
      }
    } else if ((el.textContent ?? '') !== props.initialValue) {
      el.textContent = props.initialValue || ''
    }
    // Intentionally one-shot on mount. Subsequent updates go through
    // the value-sync effect above which respects the caret-guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lifecycle: clear any pending debounce + flip the mounted ref on
  // teardown so post-await callbacks short-circuit.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const readValue = useCallback((): string => {
    const el = editorRef.current
    if (!el) return draftRef.current
    if (props.kind === 'richtext') {
      // Chrome / Safari emit <div> for paragraph breaks when the
      // contenteditable's root is <div>. The DOMPurify allowlist
      // covers <p> + <br> only — without this normalisation, the
      // operator's paragraph breaks would collapse to concatenated
      // text on persist (M2 review finding). Map div→p (and the
      // empty <div><br></div> "blank line" idiom → <br>) BEFORE the
      // sanitiser runs.
      const normalized = el.innerHTML
        .replace(/<div>\s*<br\s*\/?>\s*<\/div>/gi, '<br>')
        .replace(/<div>/gi, '<p>')
        .replace(/<\/div>/gi, '</p>')
      // Run the SAME sanitiser the server will run — surfacing the
      // server's allowlist client-side so the operator never sees a
      // tag that would be stripped on persist.
      return sanitizeRichText(normalized)
    }
    // textContent collapses browser-inserted <br> into '\n'. Trim
    // trailing whitespace — operators don't intentionally type
    // trailing spaces in titles/quotes; a stray browser-inserted <br>
    // collapses to '\n' which we want gone.
    return (el.textContent ?? '').replace(/\s+$/u, '')
  }, [props.kind])

  const writeValue = useCallback(
    (v: string) => {
      const el = editorRef.current
      if (!el) return
      if (props.kind === 'richtext') {
        el.innerHTML = v
      } else {
        el.textContent = v
      }
    },
    [props.kind],
  )

  const commit = useCallback(
    async (reason: 'blur' | 'debounce' | 'shortcut'): Promise<void> => {
      // Clear any pending debounce — we're saving NOW.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      if (inFlightRef.current) return
      if (stale) return
      const next = readValue()
      if (next === savedValueRef.current) return
      // Don't autosave an empty intermediate. Triple-select + Delete +
      // retype hits the debounce window with an empty value before the
      // typed replacement lands. The server schema rejects empty
      // (heading/quote/button require .min(1)) and the operator sees
      // a red 400 in the console mid-edit. Skip the empty debounce
      // save — blur or shortcut commits still go through (the operator
      // explicitly chose to clear). Whitespace-only is treated the
      // same way: it's almost always an in-flight state.
      if (reason === 'debounce' && next.trim() === '' && savedValueRef.current.trim() !== '') {
        return
      }
      inFlightRef.current = true
      setBusy(true)
      // Save-status pill broadcast. id keys on block + field so rapid
      // saves on the same slot coalesce; saves on a different field of
      // the same block report as separate entries.
      const saveStatusId = `inline:${props.blockId}:${props.field}`
      emitSaveBegin(saveStatusId)
      let saveOk = false
      try {
        const v = versionsRef.current
        // Route through setFieldValue so nested + array-indexed paths
        // (image.alt, items[].title, images[].caption, cta.cta.text) write
        // at the actual target. The previous spread-overlay wrote the
        // dotted path as a literal top-level key, which Zod's
        // non-strict() per-widget schemas silently strip — net effect:
        // the operator's typing reached the server but never persisted
        // at the path the operator was editing. Top-level scalar paths
        // ('text', 'quote') still work because the helper short-circuits
        // to a flat assignment for those.
        const mergedRaw = setFieldValue(
          dataRef.current,
          props.field,
          next,
          arrayIndicesRef.current ?? [],
        )
        const mergedData =
          mergedRaw &&
          typeof mergedRaw === 'object' &&
          !Array.isArray(mergedRaw)
            ? (mergedRaw as Record<string, unknown>)
            : { ...dataRef.current, [props.field]: next }
        const res = await csrfFetch(`/api/cms/blocks/${props.blockId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pageId: props.pageId,
            blockVersion: v.blockVersion,
            pageVersion: v.pageVersion,
            data: mergedData,
          }),
        })
        if (!mountedRef.current) return
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string }
          if (!mountedRef.current) return
          if (res.status === 409) {
            toast.error(
              'Someone else changed this block. Refreshing to pull the latest.',
            )
            staleVersionRef.current = {
              blockVersion: v.blockVersion,
              pageVersion: v.pageVersion,
            }
            setStale(true)
            // 409 is the only path that still requires router.refresh —
            // we need the server's authoritative tree to recover. The
            // reconciliation effect in InlineEditContext will resync
            // overrides + previews once the props change lands.
            startTransition(() => router.refresh())
            return
          }
          if (res.status === 422) {
            toast.error(
              j.error ?? 'That value is invalid. Reverting your edit.',
            )
            writeValue(savedValueRef.current)
            draftRef.current = savedValueRef.current
            return
          }
          if (res.status === 404) {
            // F9 — another editor removed this block (or its parent
            // section) mid-edit. The operator's draft can't land on
            // the server; surface the loss directly and reset DOM +
            // refs so the next render starts clean instead of leaving
            // a contentEditable surface that no longer corresponds to
            // any persisted row. router.refresh pulls the new tree so
            // the wrapper unmounts on the next paint.
            toast.error(
              'This block was removed — your unsaved changes are lost.',
            )
            writeValue('')
            draftRef.current = ''
            setSavedValue('')
            startTransition(() => router.refresh())
            return
          }
          toast.error(j.error ?? "We couldn't save. Try again in a moment.")
          return
        }
        let parsed: { blockVersion: number; pageVersion: number }
        try {
          parsed = (await res.json()) as {
            blockVersion: number
            pageVersion: number
          }
        } catch {
          if (!mountedRef.current) return
          // Body parse failed but COMMIT succeeded server-side.
          // Surface a save toast so the operator knows the work
          // landed, then refresh to read fresh state — this is the
          // EXCEPTIONAL success path, not the steady-state one.
          toast.success('Saved. Reloading to sync.')
          startTransition(() => router.refresh())
          return
        }
        if (!mountedRef.current) return
        dataRef.current = mergedData
        setSavedValue(next)
        draftRef.current = next
        // Publish the saved state into the optimistic context — the
        // block-saved reducer updates the matched block's data +
        // version, bumps pageVersion, and sets the per-block
        // versionOverride so a sibling InlineEditable / drawer on
        // this block sees the freshest cursor on its NEXT commit
        // without a router.refresh round-trip.
        dispatch({
          type: 'block-saved',
          blockId: props.blockId,
          data: mergedData,
          blockVersion: parsed.blockVersion,
          pageVersion: parsed.pageVersion,
        })
        if (reason !== 'debounce') toast.success('Saved.')
        saveOk = true
      } catch (e) {
        if (!mountedRef.current) return
        if (e instanceof Error && e.name === 'AbortError') {
          toast.error('That took too long. Your text is still here — try again.')
        } else {
          toast.error("We can't reach the server right now.")
        }
      } finally {
        inFlightRef.current = false
        if (mountedRef.current) setBusy(false)
        emitSaveEnd(saveStatusId, saveOk)
      }
    },
    [
      dispatch,
      props.blockId,
      props.field,
      props.pageId,
      readValue,
      router,
      stale,
      toast,
      writeValue,
    ],
  )

  const onInput = useCallback(() => {
    draftRef.current = readValue()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void commit('debounce')
    }, AUTOSAVE_MS)
  }, [commit, readValue])

  const onBlur = useCallback(() => {
    void commit('blur')
  }, [commit])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      // Stop bubbling so EditableBlock's wrapper-level Enter/Space
      // shortcut (which opens the drawer) doesn't fire while the
      // operator types.
      e.stopPropagation()
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void commit('shortcut')
        editorRef.current?.blur()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        writeValue(savedValueRef.current)
        draftRef.current = savedValueRef.current
        if (debounceRef.current) {
          clearTimeout(debounceRef.current)
          debounceRef.current = null
        }
        editorRef.current?.blur()
        return
      }
      // Chunk I — slash-command trigger. Opens the caret-anchored
      // block picker when the operator types '/' AT THE START OF AN
      // EMPTY PARAGRAPH inside a richtext field. Notion heuristic:
      //   - richtext kind only (plain fields would conflict with
      //     legitimate '/' in slugs / dates / paths)
      //   - no modifier keys (Cmd+/ etc. stay reserved)
      //   - not in an IME composition (Japanese / Chinese / Korean
      //     input — typing '/' during composition is part of the IME
      //     buffer, NOT a slash gesture)
      //   - cursor's containing paragraph is empty (preserves '1/2',
      //     'TCP/IP', regex character classes, etc. in mid-text)
      //   - cursor is collapsed (no selection)
      if (
        props.kind === 'richtext' &&
        e.key === '/' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        // IME composition guard. e.nativeEvent.isComposing is the
        // canonical signal on modern browsers; keyCode === 229 is the
        // legacy fallback some IMEs still emit. Either being truthy
        // means the keystroke is part of a composition buffer.
        !e.nativeEvent.isComposing &&
        e.nativeEvent.keyCode !== 229
      ) {
        const el = editorRef.current
        if (el) {
          const sel = window.getSelection()
          // Cursor must be present + collapsed (no selected text) for
          // the trigger to fire. Selected text + '/' is the operator
          // typing-to-replace, not asking for the picker.
          if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
            const range = sel.getRangeAt(0)
            // Walk up to the containing paragraph. Chrome / Safari
            // contentEditable with a <div> root emit <div> as their
            // block wrapper for paragraph breaks (readValue normalises
            // <div> → <p> at save time — see lines 271-274). Firefox
            // emits <p>. The walk accepts EITHER tag when the element
            // is a direct child of the editable root so the / trigger
            // works for multi-paragraph richtext across browsers.
            let para: Element | null = null
            let node: Node | null = range.startContainer
            while (node && node !== el) {
              if (node instanceof HTMLElement) {
                if (node.tagName === 'P') {
                  para = node
                  break
                }
                if (
                  node.tagName === 'DIV' &&
                  node.parentElement === el
                ) {
                  para = node
                  break
                }
              }
              node = node.parentNode
            }
            const measureTarget = (para ?? el) as HTMLElement
            const paraIsEmpty = (measureTarget.textContent ?? '') === ''
            // Whole-widget emptiness — a multi-paragraph text widget
            // where ONLY the current paragraph is empty (operator hit
            // Enter after typing earlier content) MUST NOT trigger the
            // replaceSource source-delete. Without this check, a /-pick
            // on the trailing empty paragraph would soft-delete the
            // entire widget, destroying the operator's earlier text.
            // The check is on the editable root's textContent so it's
            // robust across <p>/<div> paragraph wrappers.
            const widgetIsEmpty = (el.textContent ?? '') === ''
            if (paraIsEmpty) {
              // Resolve the source block + parent + blockType by
              // walking up the DOM to the EditableBlock wrapper. The
              // attributes are set by EditableBlock + survive every
              // re-render (block id + parent id + block type are
              // stable for the widget's lifetime).
              const blockEl = el.closest(
                '[data-edit-block-id]',
              ) as HTMLElement | null
              if (blockEl) {
                const sourceBlockId = Number(blockEl.dataset.editBlockId)
                const sourceBlockType = blockEl.dataset.editBlockType ?? ''
                // Dev-time signal when EditableBlock omits the type
                // attribute — silent degradation of replaceSource source-
                // delete is worth surfacing rather than papering over.
                if (
                  sourceBlockType === '' &&
                  process.env.NODE_ENV !== 'production'
                ) {
                  console.warn(
                    '[InlineEditable] data-edit-block-type missing on EditableBlock wrapper — slash source-delete will not fire',
                  )
                }
                const parentRaw = blockEl.dataset.editParentId ?? ''
                // parentId mirrors the Number.isFinite guard on
                // sourceBlockId so a forged DOM attribute (browser
                // extension injecting non-numeric value) doesn't
                // send NaN over the wire — server would 400 the
                // payload but client-side filtering keeps the toast
                // copy meaningful instead of generic parse_error.
                let parentId: number | null = null
                if (parentRaw !== '') {
                  const n = Number(parentRaw)
                  if (Number.isFinite(n)) parentId = n
                }
                if (Number.isFinite(sourceBlockId)) {
                  // Caret rect — Range.getBoundingClientRect returns
                  // {0,0,0,0} for an empty container in Chrome.
                  // Safari returns {x:0, y:0, width:0, height:line-
                  // height} for an empty <p> (uses line-box even for
                  // collapsed range), so the fallback check must NOT
                  // require rect.x === 0 — drop that clause to let
                  // Safari's partial-empty rect take the fallback
                  // path.
                  let rect: DOMRect = range.getBoundingClientRect()
                  if (rect.width === 0 && rect.height === 0) {
                    rect = measureTarget.getBoundingClientRect()
                  }
                  e.preventDefault()
                  e.stopPropagation()
                  slashCommand.openInline({
                    coords: { x: rect.left, y: rect.bottom },
                    sourceBlockId,
                    sourceBlockType,
                    sourceWidgetIsEmpty: widgetIsEmpty,
                    pageId: props.pageId,
                    parentId,
                  })
                  return
                }
              }
            }
          }
        }
      }
      // Richtext newline normalisation. Browser default for plain
      // Enter in a contenteditable varies — Chrome/Safari emit <div>,
      // Firefox emits <br>. <div> is NOT in the DOMPurify allowlist
      // (parse.ts → sanitize-shared.ts), so a Chrome operator's
      // newlines would silently vanish on persist. Force the
      // consistent <p> / <br> pair instead.
      if (
        props.kind === 'richtext' &&
        e.key === 'Enter' &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        e.preventDefault()
        if (e.shiftKey) {
          document.execCommand('insertLineBreak')
        } else {
          document.execCommand('insertParagraph')
        }
        // execCommand doesn't always fire an `input` event in Safari.
        // Manually dispatch so onInput → debounce kicks in.
        editorRef.current?.dispatchEvent(
          new InputEvent('input', { bubbles: true }),
        )
      }
    },
    [commit, props.kind, props.pageId, slashCommand, writeValue],
  )

  // Drop — strip to plain text. Without this handler, the browser's
  // default `drop` on a contentEditable inserts the dragged HTML
  // payload directly into el.innerHTML. An operator dragging from a
  // hostile website / HTML file could land `<img onerror>` /
  // `<iframe src=javascript:>` directly in the live DOM. The next
  // sanitiser pass would clean it before persistence, but the
  // browser fires onerror on the DOM injection itself (operator
  // self-XSS). Mirroring onPaste's strip-to-text closes the vector
  // at the root.
  const onDrop = useCallback(
    (e: import('react').DragEvent<HTMLElement>) => {
      e.preventDefault()
      const dt = e.dataTransfer
      const text =
        dt.getData('text/plain') ||
        dt.getData('text/html').replace(/<[^>]*>/g, '')
      if (!text) return
      let ok = false
      try {
        ok = document.execCommand('insertText', false, text)
      } catch {
        ok = false
      }
      if (!ok) {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0)
          r.deleteContents()
          const node = document.createTextNode(text)
          r.insertNode(node)
          r.setStartAfter(node)
          r.collapse(true)
          sel.removeAllRanges()
          sel.addRange(r)
        } else {
          const el = editorRef.current
          if (el) el.textContent = (el.textContent ?? '') + text
        }
      }
      editorRef.current?.dispatchEvent(
        new InputEvent('input', { bubbles: true }),
      )
    },
    [],
  )

  // Paste — strip to plain text for BOTH kinds. Word/Docs paste noise
  // overruns DOMPurify's allowlist anyway. Falls back to Selection /
  // Range insertion if execCommand is unavailable on the current
  // surface (Safari Tech Preview has removed it from some contexts).
  const onPaste = useCallback((e: ClipboardEvent<HTMLElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    let ok = false
    try {
      ok = document.execCommand('insertText', false, text)
    } catch {
      ok = false
    }
    if (!ok) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0)
        r.deleteContents()
        const node = document.createTextNode(text)
        r.insertNode(node)
        // Move caret to the end of the inserted text.
        r.setStartAfter(node)
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
      } else {
        const el = editorRef.current
        if (el) el.textContent = (el.textContent ?? '') + text
      }
    }
    // Manually fire an input event so onInput → debounce runs even
    // when execCommand / Range insertion didn't bubble one.
    editorRef.current?.dispatchEvent(
      new InputEvent('input', { bubbles: true }),
    )
  }, [])

  // Clicks on the contentEditable surface must NOT bubble to
  // EditableBlock's onClick (which opens the drawer over the operator's
  // text). Same for the wrapping role="group" keydown shortcut.
  const stopBubble = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
  }, [])

  // Resolve the polymorphic tag through the allowlist. A future caller
  // bypassing TypeScript can't push `'script'` etc. through — falls
  // back to 'div' if the value isn't in ALLOWED_TAGS.
  const rawTag = props.as ?? 'div'
  const Tag: AnyTag = ALLOWED_TAGS.has(rawTag) ? rawTag : 'div'

  const editorClassName = clsx(
    // Caret + selection visuals — copper accent. caret-color is
    // a native CSS property; the named token resolves via the
    // global Tailwind theme (--color-copper-500 in app/globals.css).
    'caret-copper-500 selection:bg-copper-200/60',
    // Focus visuals — a subtle inset copper ring sits BENEATH the
    // EditableBlock hover ring. EditableBlock CSS detects
    // [data-inline-editing="true"]:focus and tones its outer ring
    // down so the two don't compete.
    'rounded-md outline-none transition-[box-shadow,background-color] duration-standard ease-standard focus:bg-cream-50/40 focus:shadow-[inset_0_0_0_2px_#a05a28]',
    // Empty-state placeholder. The :not(:focus):empty variant covers
    // the case where the browser has inserted a stray <br> (treated
    // as non-empty by :empty but invisible to the operator).
    "empty:before:content-[attr(data-placeholder)] empty:before:text-warm-stone/60 [&:not(:focus):empty]:before:content-[attr(data-placeholder)] [&:not(:focus):empty]:before:text-warm-stone/60",
    // Cursor affordance — text-cursor over the editable region.
    'cursor-text',
    props.className,
  )

  return createElement(Tag, {
    ref: editorRef,
    'data-inline-editing': 'true',
    'data-inline-edit-field': props.field,
    'data-inline-edit-block': String(props.blockId),
    'data-inline-edit-kind': props.kind,
    // contentEditable stays TRUE during in-flight saves so a fast
    // typist isn't dropping keystrokes during the network round-trip.
    // The inFlightRef guard inside commit() serialises overlapping
    // PATCHes; the next debounce after the in-flight resolves picks
    // up any deltas the operator typed during the save.
    contentEditable: true,
    suppressContentEditableWarning: true,
    role: 'textbox',
    'aria-multiline': props.kind === 'richtext' ? 'true' : 'false',
    'aria-busy': busy,
    'aria-label': `Edit ${props.field.replace(/_/g, ' ')}`,
    // Default spellCheck off — operator-typed CMS content (potentially
    // unpublished marketing copy, internal product names, PII pasted
    // in error) shouldn't leave the trust boundary via OS / cloud
    // spellcheck. Operators can re-enable per browser-context if
    // they want it.
    spellCheck: false,
    onInput,
    onBlur,
    onKeyDown,
    onPaste,
    onDrop,
    onClick: stopBubble,
    'data-placeholder': props.placeholder ?? '',
    style: props.style,
    className: editorClassName,
  })
}
