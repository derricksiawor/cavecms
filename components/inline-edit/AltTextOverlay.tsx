'use client'

// Inline alt-text editor mounted ON the image element in edit mode.
// A small "ALT" pill anchors at the image's bottom-left; clicking the
// pill opens a single-line input pre-loaded with the current alt
// value. Blur / Enter commits the change via PATCH /api/cms/blocks/[id]
// (same trust boundary as InlineEditable). Esc reverts.
//
// Why a dedicated overlay (vs. running InlineEditable on the <img>'s
// alt attribute): contentEditable on a void element is non-functional,
// the operator needs an explicit affordance to surface the alt slot,
// and accessibility audits routinely flag images with missing alt —
// the pill's "ALT: missing" state surfaces that gap in copper-red so
// the operator sees the work item without opening the drawer.
//
// CONSUMER CONTRACT
// ─────────────────
// 1. The CALLER'S CONTAINER MUST BE `position: relative`. The overlay
//    positions absolutely against the nearest positioned ancestor.
// 2. Mount one AltTextOverlay per image. For gallery widgets, render
//    one per item, passing the per-item `arrayIndices`.
// 3. The component reuses InlineEditContext for version cursors +
//    sibling-save propagation — so it MUST sit inside the
//    InlineEditProvider tree (i.e. inside EditableMain's editor branch).
// 4. Pass the FULL persisted widget data (initialData) so the merge
//    step preserves untouched sibling fields.
//
// Example (consumer):
//
//   <div className="relative">
//     <MediaImg media={m} alt={data.image.alt} ... />
//     <AltTextOverlay
//       blockId={blockId}
//       blockVersion={blockVersion}
//       pageId={pageId}
//       pageVersion={pageVersion}
//       initialData={data}
//       field="image.alt"
//       initialValue={data.image.alt ?? ''}
//     />
//   </div>
//
// Or for a gallery item (per-index):
//
//   {data.images.map((img, i) => (
//     <div key={i} className="relative">
//       <MediaImg media={mediaMap.get(img.media_id)} alt={img.alt} ... />
//       <AltTextOverlay
//         blockId={blockId}
//         blockVersion={blockVersion}
//         pageId={pageId}
//         pageVersion={pageVersion}
//         initialData={data}
//         field="images[].alt"
//         arrayIndices={[i]}
//         initialValue={img.alt ?? ''}
//       />
//     </div>
//   ))}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
} from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { AlertCircle, Type } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { setFieldValue } from '@/lib/cms/inlineEditableFields'
import { mapServerError } from '@/lib/cms/errorCopy'
import {
  useEffectiveVersions,
  useInlineEditDispatch,
} from './InlineEditContext'
import { useToast } from './Toast'

export interface AltTextOverlayProps {
  blockId: number
  blockVersion: number
  pageId: number
  pageVersion: number
  /** Full widget data — merged + PATCHed so untouched sibling fields
   *  (caption, alignment, image.media_id, etc.) survive the save.
   *  Type unified to `unknown` to remove 49 unsafe casts at block-
   *  renderer call sites (matches InlineEditable's signature). */
  initialData: unknown
  /** Dotted path the overlay writes. Examples: 'image.alt' for the
   *  Image widget; 'images[].alt' for a Gallery item (caller passes
   *  the index in `arrayIndices`). */
  field: string
  /** Indices for `[]` segments in `field`, in path order. Empty for
   *  top-level + nested-scalar paths. */
  arrayIndices?: readonly number[]
  /** Current alt value at this path. Empty string + null both render
   *  the "ALT: missing" state. */
  initialValue: string
  /** Additional positioning classes appended to the default pill anchor
   *  (bottom-2 left-2). Most consumers leave this unset. */
  className?: string
}

/**
 * Inline alt-text affordance. Closed state renders a small pill; open
 * state renders an input above the pill, focused on mount, with Save /
 * Cancel keyboard semantics.
 *
 * State transitions:
 *   closed  → click pill / Enter on pill         → open  (input focused)
 *   open    → blur input / Enter                 → commit + closed
 *   open    → Esc                                → revert + closed
 *
 * Server contract: PATCH /api/cms/blocks/[id] with the merged data
 * (setFieldValue against the persisted shape). Reuses the same
 * optimistic-lock cursor machinery as InlineEditable — siblings see
 * the freshest (blockVersion, pageVersion) without a router refresh.
 */
export function AltTextOverlay(props: AltTextOverlayProps) {
  const router = useRouter()
  const toast = useToast()
  const dispatch = useInlineEditDispatch()
  const versions = useEffectiveVersions(props.blockId, {
    blockVersion: props.blockVersion,
    pageVersion: props.pageVersion,
  })
  const versionsRef = useRef(versions)
  useEffect(() => {
    versionsRef.current = versions
  }, [versions])

  // Last saved value — Esc reverts to this; pill empty-state is keyed
  // off it. Tracked in a ref + state so the open-state input's onBlur
  // closure sees the freshest baseline without re-creating itself.
  const [savedValue, setSavedValue] = useState<string>(props.initialValue)
  const savedValueRef = useRef(props.initialValue)
  useEffect(() => {
    savedValueRef.current = savedValue
  }, [savedValue])

  // Sync from props when the server's reconcile lands a new value
  // (sibling save via drawer, external paste, etc.) — but only when
  // the input isn't open (don't yank the operator's typing).
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string>(props.initialValue)
  useEffect(() => {
    if (open) return
    if (props.initialValue === savedValueRef.current) return
    setSavedValue(props.initialValue)
    setDraft(props.initialValue)
  }, [props.initialValue, open])

  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const inputRef = useRef<HTMLInputElement | null>(null)
  const pillRef = useRef<HTMLButtonElement | null>(null)
  // Debounce safety net. Without this, a tab/window switch or window
  // close BEFORE the input fires blur (Safari can skip blur on
  // visibility change in some configurations) loses the operator's
  // typing. The debounce mirrors InlineEditable's 800ms cadence so
  // the operator's last typed value commits even if the browser
  // never delivers a blur event.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<string>(props.initialValue)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Auto-focus the input on open + select all so the operator can
  // start typing a replacement immediately.
  useEffect(() => {
    if (!open) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [open])

  const commit = useCallback(
    async (next: string): Promise<void> => {
      if (busy) return
      const trimmed = next
      if (trimmed === savedValueRef.current) {
        setOpen(false)
        return
      }
      setBusy(true)
      try {
        // Coerce unknown → object at the boundary. Block payloads are
        // always objects post-Zod parse; the defensive narrow keeps a
        // malformed payload from crashing the spread.
        const baseObj: Record<string, unknown> =
          props.initialData &&
          typeof props.initialData === 'object' &&
          !Array.isArray(props.initialData)
            ? (props.initialData as Record<string, unknown>)
            : {}
        const merged = setFieldValue(
          { ...baseObj },
          props.field,
          trimmed,
          props.arrayIndices ?? [],
        )
        const mergedData =
          merged && typeof merged === 'object' && !Array.isArray(merged)
            ? (merged as Record<string, unknown>)
            : { ...baseObj, [props.field]: trimmed }
        const v = versionsRef.current
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
              'Someone else changed this image. Refreshing to pull the latest.',
            )
            startTransition(() => router.refresh())
            return
          }
          if (res.status === 422) {
            toast.error(
              mapServerError(
                j.error,
                "That description couldn't be saved — we put the previous one back.",
              ),
            )
            setDraft(savedValueRef.current)
            return
          }
          toast.error(
            mapServerError(
              j.error,
              "We couldn't save that description. Try again in a moment.",
            ),
          )
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
          toast.success('Alt text saved.')
          startTransition(() => router.refresh())
          return
        }
        if (!mountedRef.current) return
        setSavedValue(trimmed)
        setDraft(trimmed)
        setOpen(false)
        dispatch({
          type: 'block-saved',
          blockId: props.blockId,
          data: mergedData,
          blockVersion: parsed.blockVersion,
          pageVersion: parsed.pageVersion,
        })
        toast.success('Alt text saved.')
      } catch (e) {
        if (!mountedRef.current) return
        toast.error(
          e instanceof Error && e.name === 'AbortError'
            ? 'That took too long. Try again.'
            : "We can't reach the server right now.",
        )
      } finally {
        if (mountedRef.current) setBusy(false)
      }
    },
    [
      busy,
      dispatch,
      props.arrayIndices,
      props.blockId,
      props.field,
      props.initialData,
      props.pageId,
      router,
      toast,
    ],
  )

  const onPillClick = useCallback(() => {
    setDraft(savedValueRef.current)
    setOpen(true)
  }, [])

  const onInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        void commit(e.currentTarget.value)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDraft(savedValueRef.current)
        setOpen(false)
        // Restore focus to the pill so the operator can re-open
        // without reaching for the mouse.
        setTimeout(() => pillRef.current?.focus(), 0)
      }
    },
    [commit],
  )

  const onInputBlur = useCallback(() => {
    void commit(inputRef.current?.value ?? draft)
  }, [commit, draft])

  // Pill colouring: copper for present, urgent copper-red for missing.
  // Missing alt is the #1 a11y miss for editor surfaces — surface it
  // even when the drawer is closed.
  const isMissing = savedValue.trim() === ''

  // Stop bubble on the wrapper so click-to-edit gestures on the parent
  // image / EditableBlock don't open the drawer mid-alt-edit.
  const stopBubble = useCallback((e: { stopPropagation: () => void }) => {
    e.stopPropagation()
  }, [])

  return (
    <div
      className={clsx(
        'absolute bottom-2 left-2 z-10 pointer-events-auto',
        props.className,
      )}
      onClick={stopBubble}
      onMouseDown={stopBubble}
      onContextMenu={stopBubble}
    >
      {open ? (
        <div className="flex items-center gap-1 rounded-md bg-near-black/95 px-1.5 py-1 shadow-[0_18px_36px_-12px_rgba(5,5,5,0.55)] ring-1 ring-copper-500/60 backdrop-blur-sm">
          <span
            aria-hidden="true"
            className="text-[9px] font-semibold uppercase tracking-[0.22em] text-copper-200/90 pr-1"
          >
            Alt
          </span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              // Debounced safety-net commit — see debounceRef comment
              // above. Mirrors InlineEditable's 800ms cadence so a
              // missed-blur (tab switch, window close) still commits
              // the latest typing.
              if (debounceRef.current) clearTimeout(debounceRef.current)
              debounceRef.current = setTimeout(() => {
                if (!mountedRef.current) return
                void commit(draftRef.current)
              }, 800)
            }}
            onBlur={() => {
              if (debounceRef.current) {
                clearTimeout(debounceRef.current)
                debounceRef.current = null
              }
              onInputBlur()
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Describe this image"
            aria-label="Image alt text"
            aria-busy={busy}
            maxLength={500}
            spellCheck
            className="h-7 w-56 max-w-[60vw] rounded-sm bg-cream-50/10 px-2 text-[12px] text-cream-50 placeholder:text-cream-50/40 focus:bg-cream-50/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
          />
        </div>
      ) : (
        <button
          ref={pillRef}
          type="button"
          onClick={onPillClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onPillClick()
            }
          }}
          aria-label={
            isMissing
              ? 'Add alt text — currently missing'
              : `Edit alt text: ${savedValue}`
          }
          className={clsx(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400',
            isMissing
              ? 'bg-near-black/90 text-[#f5a285] ring-1 ring-[#c45434]/80 hover:bg-near-black hover:text-[#ffb89a]'
              : 'bg-near-black/85 text-copper-200 ring-1 ring-copper-500/60 hover:bg-near-black hover:text-copper-100',
          )}
        >
          {isMissing ? (
            <AlertCircle size={11} strokeWidth={2.4} aria-hidden="true" />
          ) : (
            <Type size={11} strokeWidth={2.4} aria-hidden="true" />
          )}
          <span>{isMissing ? 'Alt: missing' : 'Alt'}</span>
        </button>
      )}
    </div>
  )
}
