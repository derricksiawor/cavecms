'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { mergeFieldValues } from '@/lib/ai/inlineEligibility'
import { mapServerError } from '@/lib/cms/errorCopy'
import { useInlineEditDispatch, useEffectiveVersions } from './InlineEditContext'
import { useToast } from './Toast'

// Page-scoped state machine for the inline AI sparkle.
//
// Lifecycle (per session — one block + one operator action):
//
//   idle → preparing → streaming → ready → applying → idle
//                          ↓        ↓        ↓
//                        error    error    error
//
// Why a dedicated context (not InlineEditContext):
//   - The preview overlay mechanism in InlineEditContext (set-preview)
//     is shared with the EditDrawer; mixing AI-session state into the
//     same reducer would couple two surfaces that have different
//     ownership models (drawer = synchronous form state, AI = async
//     SSE stream).
//   - The session needs an AbortController that the popover's
//     "Dismiss" / "Cancel" buttons can fire — that handle doesn't fit
//     a reducer cleanly.
//
// The session DOES write into InlineEditContext via set-preview during
// streaming so the block paints with the in-progress values. On
// Apply, the session dispatches block-saved with the freshly-merged
// data so the optimistic-state reconciler picks it up identically to
// a manual save.

export type SparkleIntent = 'rewrite' | 'translate' | 'suggest' | 'fillin'
export type SparkleStatus =
  | 'idle'
  | 'preparing'
  | 'streaming'
  | 'ready'
  | 'applying'
  | 'error'

export interface SparkleSuggestOption {
  option: string
  token: string
}

export interface SparkleSessionState {
  blockId: number
  blockType: string
  intent: SparkleIntent
  status: SparkleStatus
  /** Operator-controlled metadata so the popover header can show
   *  "Rewriting hero (punchier)" etc. */
  toneChip?: string
  language?: string
  freeText?: string
  /** Per-field partial values as the stream arrives. Keyed by the
   *  block's resolved field paths (e.g. 'title', 'items[0].label'). */
  partials: Map<string, string>
  /** Single-block proposal token (rewrite / translate / fillin).
   *  Cleared after Apply / Dismiss. Undefined during streaming or for
   *  the Suggest intent (which holds 3 tokens in `suggestOptions`). */
  token?: string
  /** Suggest-intent only — three { option, token } proposals to pick
   *  between. The chosen option's token is what gets applied. */
  suggestOptions?: SparkleSuggestOption[]
  /** Suggest-intent only — the block's primary field path the option
   *  replaces. */
  suggestPrimaryPath?: string
  /** Index of the currently-highlighted suggest option (driven by the
   *  popover's preview-on-hover behaviour). */
  suggestPreviewIndex?: number
  /** Fully-validated proposed block data for the rewrite/translate/
   *  fillin path. Surfaces from the SSE done event so Apply has the
   *  exact payload to commit + the preview overlay can read it. */
  proposedData?: unknown
  /** Error message displayed in the popover when status === 'error'. */
  errorMessage?: string
}

interface SparkleContextValue {
  session: SparkleSessionState | null
  /** Begin an SSE stream. Returns immediately after kicking off the
   *  fetch — the popover renders the streaming state from the
   *  session.status field as it transitions. */
  start: (args: StartArgs) => Promise<void>
  /** Apply the pending proposal. For Suggest, accepts the picked
   *  option's token (which the popover knows from `suggestOptions`).
   *  `pageVersion` is the editor's optimistic-lock cursor at click
   *  time — passed by the popover via `useEffectiveVersions` so
   *  saveBlock's pages-axis check has the freshest token (rather
   *  than reading a stale DOM dataset attribute). */
  apply: (args: { token?: string; pageVersion: number }) => Promise<void>
  /** Dismiss the pending proposal AND clear the live preview. Also
   *  called when the operator closes the popover without applying. */
  dismiss: () => Promise<void>
  /** Hovering over a Suggest option pushes a preview onto the block
   *  so the operator can see how each option reads in context.
   *  Passing `null` clears the hover preview (restores the
   *  currently-applied state on the block). */
  setSuggestPreview: (index: number | null) => void
}

interface StartArgs {
  blockId: number
  blockType: string
  blockVersion: number
  pageId: number
  pageVersion: number
  currentData: unknown
  intent: SparkleIntent
  toneChip?: string
  language?: string
  freeText?: string
}

const SparkleContext = createContext<SparkleContextValue | null>(null)

const PROD = process.env.NODE_ENV === 'production'

const NULL_SESSION: SparkleContextValue = {
  session: null,
  start: async () => {
    if (!PROD) {
      throw new Error('AiSparkleSession not mounted')
    }
  },
  apply: async () => {
    /* no-op outside provider */
    return
  },
  dismiss: async () => {
    /* no-op outside provider */
  },
  setSuggestPreview: () => {
    /* no-op outside provider */
  },
}

export function useAiSparkleSession(): SparkleContextValue {
  return useContext(SparkleContext) ?? NULL_SESSION
}

/** Read the active session ONLY if it targets the given blockId.
 *  Used by EditableBlock + the preview overlay to scope behaviour
 *  per block without re-rendering every block on every session
 *  state change (one session per page; only the matching block
 *  re-renders). */
export function useSparkleSessionFor(blockId: number): SparkleSessionState | null {
  const ctx = useContext(SparkleContext)
  if (!ctx?.session) return null
  return ctx.session.blockId === blockId ? ctx.session : null
}

/** Mounted inside EditableMain alongside InlineEditProvider. Owns the
 *  EventSource-style fetch loop + the Apply/Dismiss CSRF posts +
 *  pushes per-field partials onto InlineEditContext.set-preview so
 *  the live block paints the streaming output. */
export function AiSparkleSessionProvider({ children }: { children: ReactNode }) {
  const dispatch = useInlineEditDispatch()
  const toast = useToast()
  const [session, setSession] = useState<SparkleSessionState | null>(null)
  // Ref-mirror so callbacks created at provider mount can read the
  // freshest session state without listing it in every dep array.
  const sessionRef = useRef<SparkleSessionState | null>(null)
  sessionRef.current = session

  // AbortController fires from dismiss / close-popover paths to stop
  // the in-flight stream. Held in a ref so callbacks can grab it
  // without re-rendering on every key change.
  const abortRef = useRef<AbortController | null>(null)

  // Original data snapshot captured at start() time. After Dismiss
  // we clear the preview so the block reverts to this; for Suggest
  // we need it to compute per-option preview overlays on hover.
  const originalDataRef = useRef<unknown>(null)
  // pageId tracked so apply() can route its POST body without forcing
  // the popover to thread the id through every call.
  const pageIdRef = useRef<number | null>(null)

  const clearPreview = useCallback(
    (blockId: number) => {
      dispatch({ type: 'clear-preview', blockId })
    },
    [dispatch],
  )

  const start = useCallback(
    async (args: StartArgs): Promise<void> => {
      // Cancel any in-flight session first — clicking Sparkle on a
      // different block (or re-submitting on the same block) should
      // not leave a dangling SSE stream burning the operator's quota.
      if (abortRef.current) {
        try {
          abortRef.current.abort()
        } catch {
          /* swallow */
        }
      }
      if (sessionRef.current) {
        clearPreview(sessionRef.current.blockId)
      }
      originalDataRef.current = args.currentData
      pageIdRef.current = args.pageId
      const initial: SparkleSessionState = {
        blockId: args.blockId,
        blockType: args.blockType,
        intent: args.intent,
        status: 'preparing',
        toneChip: args.toneChip,
        language: args.language,
        freeText: args.freeText,
        partials: new Map(),
      }
      setSession(initial)
      const controller = new AbortController()
      abortRef.current = controller

      // CSRF on POST stream: csrfFetch will add the header AND retry
      // once on 403 with a fresh token (mirrors every other mutation
      // path). We disable the per-call timeout because SSE streams
      // are long-lived; the server-side timeout is the deadline.
      let response: Response
      try {
        response = await csrfFetch('/api/ai/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pageId: args.pageId,
            blockId: args.blockId,
            intent: args.intent,
            ...(args.toneChip ? { toneChip: args.toneChip } : {}),
            ...(args.language ? { language: args.language } : {}),
            ...(args.freeText && args.freeText.length > 0
              ? { freeText: args.freeText }
              : {}),
          }),
          signal: controller.signal,
          timeoutMs: Infinity,
        })
      } catch (err) {
        if (controller.signal.aborted) {
          // Operator clicked Dismiss / closed popover. Already cleared.
          return
        }
        setSession((s) =>
          s
            ? {
                ...s,
                status: 'error',
                errorMessage:
                  err instanceof Error ? err.message : 'Could not reach the server.',
              }
            : s,
        )
        return
      }

      if (!response.ok) {
        const errBody = (await response
          .json()
          .catch(() => ({}))) as { error?: string }
        setSession((s) =>
          s
            ? {
                ...s,
                status: 'error',
                errorMessage: explainSseStartError(response.status, errBody.error),
              }
            : s,
        )
        return
      }

      if (!response.body) {
        setSession((s) =>
          s ? { ...s, status: 'error', errorMessage: 'No response body.' } : s,
        )
        return
      }

      setSession((s) => (s ? { ...s, status: 'streaming' } : s))

      // ── SSE parser. Standard text/event-stream framing:
      //   event: <name>\n
      //   data: <json-line>\n
      //   \n
      // We accumulate bytes into a string buffer, split on the
      // double-newline boundary, parse each frame, dispatch.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          if (controller.signal.aborted) break
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const rawFrame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            handleFrame(rawFrame, args, dispatch)
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setSession((s) =>
            s
              ? {
                  ...s,
                  status: 'error',
                  errorMessage:
                    err instanceof Error ? err.message : 'Stream failed.',
                }
              : s,
          )
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {
          /* releaseLock throws when the reader is already canceled — ignore */
        }
      }

      function handleFrame(
        rawFrame: string,
        startArgs: StartArgs,
        dispatchInner: ReturnType<typeof useInlineEditDispatch>,
      ): void {
        const lines = rawFrame.split('\n')
        let event = ''
        let data = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        if (!event || !data) return
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(data) as Record<string, unknown>
        } catch {
          return
        }
        if (event === 'progress') {
          const stage = payload.stage as string | undefined
          if (stage === 'finalizing') {
            setSession((s) => (s ? { ...s, status: 'streaming' } : s))
          }
          return
        }
        if (event === 'field') {
          const path = String(payload.path ?? '')
          const value = String(payload.value ?? '')
          if (!path) return
          setSession((s) => {
            if (!s) return s
            const partials = new Map(s.partials)
            partials.set(path, value)
            // Push the merged data as a preview overlay so the live
            // block paints the streaming value. mergeFieldValues
            // produces a deep copy with the partials applied; the
            // reducer's shallow merge replaces top-level keys
            // wholesale (which is what we want — the merged shape
            // already carries all unchanged keys).
            const mergedData = mergeFieldValues(
              originalDataRef.current,
              Object.fromEntries(partials),
            )
            if (mergedData && typeof mergedData === 'object') {
              dispatchInner({
                type: 'set-preview',
                blockId: startArgs.blockId,
                data: mergedData as Record<string, unknown>,
              })
            }
            return { ...s, partials }
          })
          return
        }
        if (event === 'done') {
          const intent = payload.intent as SparkleIntent
          if (intent === 'suggest') {
            const options = payload.options as
              | Array<{ option: string; token: string }>
              | undefined
            const primaryPath = String(payload.primaryPath ?? '')
            if (!options || !primaryPath) return
            setSession((s) => {
              if (!s) return s
              // Clear the streaming preview before surfacing Suggest
              // options — the operator picks one then we re-preview
              // their choice on hover.
              clearPreview(startArgs.blockId)
              return {
                ...s,
                status: 'ready',
                suggestOptions: options,
                suggestPrimaryPath: primaryPath,
                proposedData: undefined,
                token: undefined,
              }
            })
            return
          }
          const token = String(payload.token ?? '')
          const proposedData = payload.proposedData
          if (!token) return
          setSession((s) =>
            s
              ? {
                  ...s,
                  status: 'ready',
                  token,
                  proposedData,
                }
              : s,
          )
          // Ensure the final preview matches the validated proposed
          // data exactly (the partials-driven preview was based on
          // unvalidated partial strings; the validated server payload
          // may differ slightly after DOMPurify).
          if (proposedData && typeof proposedData === 'object') {
            dispatchInner({
              type: 'set-preview',
              blockId: startArgs.blockId,
              data: proposedData as Record<string, unknown>,
            })
          }
          return
        }
        if (event === 'error') {
          const code = String(payload.code ?? 'server_error')
          const detail = typeof payload.detail === 'string' ? payload.detail : undefined
          setSession((s) =>
            s
              ? {
                  ...s,
                  status: 'error',
                  errorMessage: explainSseError(code, detail),
                }
              : s,
          )
          clearPreview(startArgs.blockId)
          return
        }
      }
    },
    [clearPreview, dispatch],
  )

  // ── Apply ───────────────────────────────────────────────────────
  // Fires the POST + on success dispatches block-saved through the
  // existing optimistic-state reconciler. Stale-version 409 leaves
  // the proposal pending so the operator can refresh + retry.
  const apply = useCallback(
    async (args: { token?: string; pageVersion: number }): Promise<void> => {
      const s = sessionRef.current
      if (!s) return
      const pageId = pageIdRef.current
      if (pageId === null) return
      const token = args.token ?? s.token
      if (!token) {
        toast.error('Nothing to apply.')
        return
      }
      setSession((cur) => (cur ? { ...cur, status: 'applying' } : cur))
      // pageVersion is the operator's freshest optimistic-lock cursor,
      // resolved by the popover via useEffectiveVersions(blockId, ...)
      // and passed in here. This is the input saveBlock's pages-axis
      // check compares against — passing 0 would guarantee a spurious
      // stale_page_version 409.
      const pageVersion = args.pageVersion
      let response: Response
      try {
        response = await csrfFetch(`/api/ai/proposals/${token}/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accept: 'all', pageVersion }),
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Network error.')
        setSession((cur) => (cur ? { ...cur, status: 'ready' } : cur))
        return
      }
      if (response.status === 409) {
        toast.error(
          'Someone else changed this block. Refresh to see the latest.',
        )
        setSession((cur) => (cur ? { ...cur, status: 'ready' } : cur))
        return
      }
      if (response.status === 410) {
        toast.error('Proposal expired — try again.')
        setSession(null)
        clearPreview(s.blockId)
        return
      }
      if (!response.ok) {
        const j = (await response.json().catch(() => ({}))) as { error?: string }
        toast.error(
          mapServerError(j.error, "We couldn't apply those suggestions. Try again in a moment."),
        )
        setSession((cur) => (cur ? { ...cur, status: 'ready' } : cur))
        return
      }
      const body = (await response.json().catch(() => ({}))) as {
        applied?: Array<{ blockId: number; blockVersion: number }>
        pageVersion?: number
      }
      const applied = body.applied?.[0]
      if (applied && body.pageVersion) {
        // For Suggest, the applied data is the chosen option merged
        // into the original; for the other intents, it's `proposedData`
        // we held from the done event. Push the right data shape so
        // the optimistic state reflects what the server committed.
        let appliedData: Record<string, unknown> | null = null
        if (s.intent === 'suggest' && s.suggestPrimaryPath) {
          const chosenOption = s.suggestOptions?.find((o) => o.token === token)
          if (chosenOption && originalDataRef.current) {
            const merged = mergeFieldValues(originalDataRef.current, {
              [s.suggestPrimaryPath]: chosenOption.option,
            })
            if (merged && typeof merged === 'object') {
              appliedData = merged as Record<string, unknown>
            }
          }
        } else if (s.proposedData && typeof s.proposedData === 'object') {
          appliedData = s.proposedData as Record<string, unknown>
        }
        if (appliedData) {
          dispatch({
            type: 'block-saved',
            blockId: applied.blockId,
            data: appliedData,
            blockVersion: applied.blockVersion,
            pageVersion: body.pageVersion,
          })
        }
      }
      toast.success('AI changes applied.')
      // For Suggest, the operator picked ONE option but we minted 3
      // proposal tokens up front. Best-effort dismiss the other two
      // so they don't strand as `pending` in audit until expiry.
      if (s.intent === 'suggest' && s.suggestOptions) {
        const siblingTokens = s.suggestOptions
          .map((o) => o.token)
          .filter((t) => t !== token)
        void Promise.allSettled(
          siblingTokens.map((tk) =>
            csrfFetch(`/api/ai/proposals/${tk}/dismiss`, { method: 'POST' }).catch(
              () => {
                /* best-effort */
              },
            ),
          ),
        )
      }
      clearPreview(s.blockId)
      setSession(null)
    },
    [dispatch, toast, clearPreview],
  )

  const dismiss = useCallback(async (): Promise<void> => {
    const s = sessionRef.current
    if (!s) return
    // Abort an in-flight stream first.
    if (abortRef.current) {
      try {
        abortRef.current.abort()
      } catch {
        /* swallow */
      }
    }
    clearPreview(s.blockId)
    // For Suggest with multiple pending tokens, dismiss each. For
    // single-token intents, dismiss the one. Best-effort — if a
    // dismiss request fails the proposal just ages out at its
    // 30-minute expiry; no user-facing impact.
    const tokensToDismiss: string[] = []
    if (s.token) tokensToDismiss.push(s.token)
    if (s.suggestOptions) {
      for (const opt of s.suggestOptions) tokensToDismiss.push(opt.token)
    }
    setSession(null)
    await Promise.allSettled(
      tokensToDismiss.map((tk) =>
        csrfFetch(`/api/ai/proposals/${tk}/dismiss`, { method: 'POST' }).catch(
          () => {
            /* best-effort */
          },
        ),
      ),
    )
  }, [clearPreview])

  const setSuggestPreview = useCallback(
    (index: number | null) => {
      const s = sessionRef.current
      if (!s) return
      if (!s.suggestOptions || !s.suggestPrimaryPath) return
      if (index === null) {
        clearPreview(s.blockId)
        setSession((cur) =>
          cur ? { ...cur, suggestPreviewIndex: undefined } : cur,
        )
        return
      }
      const option = s.suggestOptions[index]
      if (!option || !originalDataRef.current) return
      const merged = mergeFieldValues(originalDataRef.current, {
        [s.suggestPrimaryPath]: option.option,
      })
      if (merged && typeof merged === 'object') {
        dispatch({
          type: 'set-preview',
          blockId: s.blockId,
          data: merged as Record<string, unknown>,
        })
      }
      setSession((cur) => (cur ? { ...cur, suggestPreviewIndex: index } : cur))
    },
    [clearPreview, dispatch],
  )

  const value = useMemo<SparkleContextValue>(
    () => ({ session, start, apply, dismiss, setSuggestPreview }),
    [session, start, apply, dismiss, setSuggestPreview],
  )

  return <SparkleContext.Provider value={value}>{children}</SparkleContext.Provider>
}

// Map SSE start-failure HTTP statuses + error codes to operator copy.
function explainSseStartError(status: number, code?: string): string {
  if (code) return explainSseError(code)
  if (status === 401) return 'Sign in to use AI tools.'
  if (status === 403) return 'You don\'t have access to AI features.'
  if (status === 404) return 'This block no longer exists.'
  if (status === 422) return 'AI isn\'t set up — open Settings → AI Assistant.'
  if (status === 429) return 'Too many AI requests — wait a moment.'
  return 'Something went wrong starting the AI request.'
}

function explainSseError(code: string, detail?: string): string {
  switch (code) {
    case 'ai_not_configured':
    case 'ai_key_missing':
      return 'AI isn\'t set up — open Settings → AI Assistant.'
    case 'ai_disabled':
      return 'Inline AI is turned off in Settings.'
    case 'ai_key_decrypt_failed':
      return 'Stored AI key could not be read. Re-enter it in Settings.'
    case 'unauthorized':
      return 'Gemini rejected the API key.'
    case 'unknown_model':
      return 'The configured Gemini model is not available.'
    case 'rate_limited':
      return 'Gemini hit a rate limit. Try again in a moment.'
    case 'timeout':
      return 'Gemini took too long. Try a shorter instruction.'
    case 'network_error':
      return 'Could not reach Gemini.'
    case 'validation_failed':
      return 'The AI response didn\'t fit this block. Try a different instruction.'
    case 'not_eligible':
      return 'AI isn\'t available on this block type.'
    default:
      return detail ?? 'AI request failed.'
  }
}

// Suppress an unused-import lint flag — useEffectiveVersions is
// re-exported below for the popover's pageVersion read.
export { useEffectiveVersions }
