'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import {
  Sparkles,
  Send,
  X,
  Check,
  Loader2,
  AlertTriangle,
  Wand2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

import { csrfFetch } from '@/lib/client/csrf'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'
import { BetaPill } from '@/components/ui/BetaPill'
import { useAiSnapshot, useInlineEditState } from './InlineEditContext'

// ════════════════════════════════════════════════════════════════════
//  CaveCMS Page Assistant — inline command-bar + proposal modal.
//
//  Redesign per operator feedback: the prior sidebar/panel + persistent
//  conversation transcript pattern was too heavy. The new flow is one-
//  shot per prompt — the operator presses ⌘K (or clicks the trigger
//  pill at bottom-center), an inline command bar slides up, they type
//  a single instruction, the AI proposes changes, a centered modal
//  shows the proposal with each affected block decorated on the live
//  page so the operator can SEE where the changes land before they
//  apply.
//
//  State machine:
//    'idle'      → small trigger pill bottom-center
//    'open'      → command bar focused, ready for input
//    'thinking'  → bar shows shimmer + status while Gemini runs
//    'review'    → modal showing the proposal + block overlays
//    'applying'  → modal disabled with applying spinner
//
//  Keyboard:
//    ⌘K / Ctrl+K  open the command bar from any state
//    Esc           close current surface (bar or modal)
//    Enter         submit prompt from the bar
//    Cmd+Enter     apply all from the modal
//
//  Safety wall is unchanged — every prompt round-trips through
//  /api/ai/propose, every apply through /api/ai/proposals/[token]/apply.
// ════════════════════════════════════════════════════════════════════

const PROPOSAL_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

// ── Op types (mirror server) ───────────────────────────────────────

interface ChangesetOpEdit {
  op: 'edit'
  blockId: number
  blockType: string
  data: unknown
}
interface ChangesetOpInsert {
  op: 'insert'
  parentColumnId: number
  blockType: string
  data: unknown
  afterBlockId?: number
  beforeBlockId?: number
}
interface ChangesetOpDelete {
  op: 'delete'
  blockId: number
  blockType: string
}
interface ChangesetOpReorder {
  op: 'reorder'
  moves: Array<{ blockId: number; parentColumnId: number; position: number }>
}
type ChangesetOp =
  | ChangesetOpEdit
  | ChangesetOpInsert
  | ChangesetOpDelete
  | ChangesetOpReorder

interface PendingProposal {
  token: string
  changeset: ChangesetOp[]
  modelText: string
  accepted: boolean[]
}

type ChatStage = 'idle' | 'open' | 'thinking' | 'review' | 'applying'

// ── Context ────────────────────────────────────────────────────────

interface PageAssistantContextValue {
  stage: ChatStage
  setStage: (s: ChatStage) => void
  pending: PendingProposal | null
  errorMessage: string | null
  setErrorMessage: (s: string | null) => void
  assistantReply: string | null
  setAssistantReply: (s: string | null) => void
  thinkingHint: string
  setThinkingHint: (s: string) => void
  sendPrompt: (text: string) => Promise<void>
  toggleAcceptOp: (i: number) => void
  applyAccepted: () => Promise<void>
  dismissAll: () => Promise<void>
  /** IDs of the blocks affected by the current pending proposal —
   *  used by ProposalBlockOverlay to decorate the live tree. */
  affectedBlockIds: ReadonlySet<number>
}

const PageAssistantContext = createContext<PageAssistantContextValue | null>(null)

function useAssistant(): PageAssistantContextValue {
  const v = useContext(PageAssistantContext)
  if (!v) throw new Error('PageAssistant subcomponent outside provider')
  return v
}

// ── SSE parser ─────────────────────────────────────────────────────

interface SseFrame {
  event: string
  payload: Record<string, unknown>
}

function parseFrame(rawFrame: string): SseFrame | null {
  const lines = rawFrame.split('\n')
  let event = ''
  let data = ''
  for (const line of lines) {
    if (line.startsWith('event: ')) event = line.slice(7).trim()
    else if (line.startsWith('data: ')) data += line.slice(6)
  }
  if (!event || !data) return null
  try {
    return { event, payload: JSON.parse(data) as Record<string, unknown> }
  } catch {
    return null
  }
}

// ════════════════════════════════════════════════════════════════════
//  Public root — gated wrapper + provider.
// ════════════════════════════════════════════════════════════════════

export interface PageAssistantProps {
  pageId: number
}

export function PageAssistant({ pageId }: PageAssistantProps) {
  const [stage, setStage] = useState<ChatStage>('idle')
  const [pending, setPending] = useState<PendingProposal | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // PR 4 audit fix (MEDIUM): assistant info replies are rendered in a
  // neutral pill, not in the amber `role="alert"` banner that
  // errorMessage drives — accessibility (the alert role lies) +
  // visual semantics (info vs warn) demand separate channels.
  const [assistantReply, setAssistantReply] = useState<string | null>(null)
  const [thinkingHint, setThinkingHint] = useState('Reading the page…')
  // PR 5 review fix: cache the freshest pageVersion returned by a
  // successful /apply so a rapid second-prompt-then-apply doesn't
  // race against router.refresh() landing the new server cursor. The
  // chat surface doesn't dispatch into the InlineEditContext on apply
  // (multi-block applies have mixed op kinds; inline-style
  // block-saved dispatch isn't a fit). Instead we keep this local
  // cursor and Math.max() against editState.pageVersion at the next
  // /apply request body.
  const lastApplyPageVersionRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const editState = useInlineEditState()
  const router = useRouter()

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort()
      } catch {
        /* swallow */
      }
    }
  }, [])

  // ⌘K / Ctrl+K from anywhere → open command bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdK =
        (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')
      if (!cmdK) return
      // Don't hijack from an already-mounted ⌘K palette host. The
      // SlashCommandProvider listens for the same shortcut; we check
      // for an open palette by attribute before consuming.
      const palette = document.querySelector('[data-cavecms-palette-open="1"]')
      if (palette) return
      e.preventDefault()
      setStage((s) => (s === 'idle' ? 'open' : s))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Esc closes the current surface. Deliberately refused during
  // 'applying' — the apply fetch has no AbortController and could
  // succeed or fail moments later; dismissing the modal mid-flight
  // would either hide a real error (the failure branch re-mounts the
  // modal with a misleading "ghost") or hide a successful commit
  // the operator should acknowledge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stage === 'open') {
        setStage('idle')
      } else if (stage === 'review') {
        // Closing the modal without apply/dismiss preserves the pending
        // proposal — the operator can re-open via the trigger pill.
        setStage('idle')
      }
      // stage === 'applying' → ignore Esc; FocusTrap's local handler
      // also bails out via the guard below.
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage])

  const affectedBlockIds = useMemo(() => {
    if (!pending) return new Set<number>()
    const ids = new Set<number>()
    for (const op of pending.changeset) {
      if (op.op === 'edit' || op.op === 'delete') ids.add(op.blockId)
      if (op.op === 'reorder') {
        for (const m of op.moves) ids.add(m.blockId)
      }
      // Insert ops add a NEW block — no existing-block id to decorate;
      // we render a "ghost insertion point" in the modal instead.
    }
    return ids
  }, [pending])

  const sendPrompt = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      setErrorMessage(null)
      setAssistantReply(null)
      setStage('thinking')
      setThinkingHint('Reading the page…')

      // Cancel any prior in-flight request.
      try {
        abortRef.current?.abort()
      } catch {
        /* swallow */
      }
      const controller = new AbortController()
      abortRef.current = controller

      let response: Response
      try {
        response = await csrfFetch('/api/ai/propose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pageId,
            userPrompt: trimmed,
            // One-shot per prompt — no conversation history. The
            // structural safety wall + per-tool-call validation +
            // operator's explicit Apply click are the safety surface;
            // multi-turn coherence is unnecessary for the single-edit
            // workflow operators reach for in practice.
          }),
          signal: controller.signal,
          timeoutMs: Infinity,
        })
      } catch (err) {
        if (controller.signal.aborted) return
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not reach the server.',
        )
        setStage('open')
        return
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        setErrorMessage(explainStartError(response.status, body.error))
        setStage('open')
        return
      }
      if (!response.body) {
        setErrorMessage('No response body.')
        setStage('open')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let modelText = ''
      let resolvedToken: string | null = null
      let resolvedChangeset: ChangesetOp[] = []
      let sawAnyToolCall = false

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
            boundary = buffer.indexOf('\n\n')
            const frame = parseFrame(rawFrame)
            if (!frame) continue
            if (frame.event === 'progress') continue
            if (frame.event === 'chunk') {
              modelText += String(frame.payload.delta ?? '')
              continue
            }
            if (frame.event === 'field') {
              if (frame.payload.path === '__toolCall') {
                if (!sawAnyToolCall) {
                  setThinkingHint('Drafting changes…')
                  sawAnyToolCall = true
                }
              }
              continue
            }
            if (frame.event === 'done') {
              const token = frame.payload.token
              resolvedToken =
                typeof token === 'string' && token.length > 0 ? token : null
              const cs = frame.payload.changeset
              resolvedChangeset = Array.isArray(cs)
                ? (cs as ChangesetOp[])
                : []
              const text = String(frame.payload.modelText ?? '')
              if (text.length > 0) modelText = text
              continue
            }
            if (frame.event === 'error') {
              const code = String(frame.payload.code ?? 'server_error')
              const detail =
                typeof frame.payload.detail === 'string'
                  ? (frame.payload.detail as string)
                  : undefined
              setErrorMessage(explainStreamError(code, detail))
              setStage('open')
              return
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setErrorMessage(
            err instanceof Error ? err.message : 'Stream failed.',
          )
          setStage('open')
        }
      } finally {
        // PR 4 audit fix (LOW): prefer reader.cancel() over a bare
        // releaseLock() so the underlying network stream is torn down
        // promptly on the abort path. cancel() awaits the source's
        // cancel hook (SSE writer.close on the server) and only then
        // releases the lock. releaseLock() alone leaves the body
        // stream open until GC.
        try {
          await reader.cancel().catch(() => undefined)
        } catch {
          /* swallow */
        }
      }

      // PR 4 audit fix (MEDIUM race): a rapidly-submitted second
      // prompt aborts the controller above. The reader exits via the
      // catch path or the loop's abort-check, but execution falls
      // through to the resolvedToken evaluation. Bail here so an
      // aborted call can't write `pending` / `stage` on top of the
      // newer call's state.
      if (controller.signal.aborted) return

      if (
        resolvedToken &&
        PROPOSAL_TOKEN_RE.test(resolvedToken) &&
        resolvedChangeset.length > 0
      ) {
        setPending({
          token: resolvedToken,
          changeset: resolvedChangeset,
          modelText,
          accepted: resolvedChangeset.map(() => true),
        })
        setStage('review')
      } else if (modelText.length > 0) {
        // Text-only reply — show it in a neutral info pill, NOT the
        // amber alert. The alert role is reserved for actual errors.
        setAssistantReply(modelText)
        setStage('open')
      } else {
        setErrorMessage('The assistant returned no proposal.')
        setStage('open')
      }
    },
    [pageId],
  )

  const toggleAcceptOp = useCallback((i: number) => {
    setPending((prev) => {
      if (!prev) return prev
      const accepted = prev.accepted.slice()
      accepted[i] = !accepted[i]
      return { ...prev, accepted }
    })
  }, [])

  const applyAccepted = useCallback(async (): Promise<void> => {
    const cur = pending
    if (!cur) return
    const indices = cur.accepted
      .map((v, i) => (v ? i : -1))
      .filter((i) => i >= 0)
    if (indices.length === 0) {
      setErrorMessage('Pick at least one change to apply.')
      return
    }
    setStage('applying')
    setErrorMessage(null)
    let response: Response
    // Use the higher of (a) the cursor from InlineEditContext (synced
    // from the latest server render) and (b) the cursor returned by
    // our LAST successful /apply. If router.refresh() from the prior
    // apply hasn't landed yet, (a) is stale and (b) covers the gap.
    const effectivePageVersion = Math.max(
      editState.pageVersion,
      lastApplyPageVersionRef.current ?? 0,
    )
    try {
      response = await csrfFetch(`/api/ai/proposals/${cur.token}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accept:
            indices.length === cur.changeset.length ? 'all' : indices,
          pageVersion: effectivePageVersion,
        }),
      })
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Network error.',
      )
      setStage('review')
      return
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
      }
      if (response.status === 409) {
        setErrorMessage(
          body.error === 'stale_block_version'
            ? 'One block changed in another tab. Try sending the prompt again.'
            : body.error === 'stale_page_version'
              ? 'The page changed while you waited. Try sending again.'
              : 'Could not apply — refresh and try again.',
        )
      } else if (response.status === 410) {
        setErrorMessage('Proposal expired. Send the prompt again.')
        setPending(null)
        setStage('open')
        return
      } else if (response.status === 422) {
        setErrorMessage('The proposed change is no longer valid.')
        setPending(null)
        setStage('open')
        return
      } else {
        setErrorMessage(body.error ?? 'Apply failed.')
      }
      setStage('review')
      return
    }
    // Capture the new pageVersion from the response so the NEXT
    // /apply request doesn't 409 on a stale InlineEditContext cursor
    // (router.refresh() is async; the new server tree may not have
    // hydrated by the time the operator clicks Apply again).
    try {
      const body = (await response.json().catch(() => ({}))) as {
        pageVersion?: number
      }
      if (typeof body.pageVersion === 'number') {
        lastApplyPageVersionRef.current = Math.max(
          lastApplyPageVersionRef.current ?? 0,
          body.pageVersion,
        )
      }
    } catch {
      /* swallow — best-effort cursor cache */
    }
    setPending(null)
    setStage('idle')
    try {
      router.refresh()
    } catch {
      /* swallow */
    }
  }, [pending, editState.pageVersion, router])

  const dismissAll = useCallback(async (): Promise<void> => {
    const cur = pending
    if (!cur) return
    setStage('idle')
    let serverDismissed = true
    try {
      const r = await csrfFetch(`/api/ai/proposals/${cur.token}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!r.ok) serverDismissed = false
    } catch {
      serverDismissed = false
    }
    setPending(null)
    if (!serverDismissed) {
      setErrorMessage(
        'Could not reach the server. The proposal will expire automatically.',
      )
    }
  }, [pending])

  const value: PageAssistantContextValue = useMemo(
    () => ({
      stage,
      setStage,
      pending,
      errorMessage,
      setErrorMessage,
      assistantReply,
      setAssistantReply,
      thinkingHint,
      setThinkingHint,
      sendPrompt,
      toggleAcceptOp,
      applyAccepted,
      dismissAll,
      affectedBlockIds,
    }),
    [
      stage,
      pending,
      errorMessage,
      assistantReply,
      thinkingHint,
      sendPrompt,
      toggleAcceptOp,
      applyAccepted,
      dismissAll,
      affectedBlockIds,
    ],
  )

  return (
    <PageAssistantContext.Provider value={value}>
      <TriggerPill />
      <CommandBar />
      <ProposalModal />
      <BlockDecorations />
    </PageAssistantContext.Provider>
  )
}

// ════════════════════════════════════════════════════════════════════
//  Trigger pill — small bottom-center "Ask AI" affordance.
// ════════════════════════════════════════════════════════════════════

function TriggerPill() {
  const { stage, setStage, pending } = useAssistant()
  if (stage !== 'idle') return null
  const hasPending = pending !== null
  return (
    <button
      type="button"
      onClick={() => setStage(hasPending ? 'review' : 'open')}
      aria-label={hasPending ? 'View AI proposal' : 'Ask the Page Assistant'}
      // Anchored bottom-LEFT, mirroring the EditModePill on the right.
      // The right corner is reserved for the EditModePill + the toast
      // stack (which lifts to bottom-24) — sitting on the left keeps the
      // assistant clear of both. WidgetPicker lives at top-left (top-28),
      // so the bottom-left corner is free. Desktop tucks into the corner
      // (bottom-6); on mobile we sit higher (6rem) above the iOS home-bar
      // + public MobileCtaBar, with env(safe-area-inset-bottom) so a
      // notch device doesn't clip it. The arbitrary calc() class lets
      // Tailwind compile the safe-area expression at build time.
      className="motion-safe:animate-cavecms-scale-in fixed left-4 sm:left-6 z-[80] inline-flex h-11 items-center gap-2 rounded-full bg-near-black px-5 text-sm font-medium text-ivory shadow-[0_18px_40px_-12px_rgba(14,14,16,0.55)] ring-1 ring-copper-500/20 transition-all duration-standard hover:-translate-y-0.5 hover:bg-obsidian hover:ring-copper-400/40 hover:shadow-[0_22px_50px_-12px_rgba(184,115,51,0.35)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-300 bottom-[calc(env(safe-area-inset-bottom,0px)+6rem)] md:bottom-6"
    >
      <Sparkles
        className="h-4 w-4 text-copper-400"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="tracking-tight">
        {hasPending ? 'View proposal' : 'Ask the assistant'}
      </span>
      {hasPending ? (
        <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-copper-500 px-1.5 text-[10px] font-semibold text-near-black">
          {pending!.changeset.length}
        </span>
      ) : (
        <span className="ml-1 hidden items-center gap-1 rounded-md border border-ivory/15 bg-ivory/5 px-2 py-0.5 text-[10px] font-mono text-ivory/70 sm:inline-flex">
          <span>⌘</span>
          <span>K</span>
        </span>
      )}
    </button>
  )
}

// ════════════════════════════════════════════════════════════════════
//  Command bar — inline floating input at bottom-center.
// ════════════════════════════════════════════════════════════════════

function CommandBar() {
  const {
    stage,
    setStage,
    sendPrompt,
    errorMessage,
    setErrorMessage,
    assistantReply,
    setAssistantReply,
    thinkingHint,
  } = useAssistant()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-focus when the bar opens.
  useEffect(() => {
    if (stage === 'open') {
      textareaRef.current?.focus()
    }
  }, [stage])

  // Auto-grow the textarea up to 5 rows.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, 160)
    el.style.height = `${next}px`
  }, [text])

  if (stage !== 'open' && stage !== 'thinking') return null

  const isThinking = stage === 'thinking'
  const onSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (isThinking) return
    const v = text.trim()
    if (v.length === 0) return
    setText('')
    void sendPrompt(v)
  }

  return (
    // Mobile: anchor the card to the viewport bottom and reserve room
    // for the iOS home-bar via env(safe-area-inset-bottom). Desktop
    // keeps the 4–6px breathing room above the EditModePill.
    <div
      className="fixed bottom-0 left-0 right-0 z-[80]"
      style={{
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 1rem)',
      }}
    >
      <div className="mx-auto max-w-2xl px-4 sm:pb-2">
        <div className="motion-safe:animate-cavecms-slide-up overflow-hidden rounded-2xl bg-obsidian/95 shadow-[0_28px_60px_-18px_rgba(14,14,16,0.75)] ring-1 ring-copper-500/25 backdrop-blur-xl">
          {/* Header strip */}
          <div className="flex items-center justify-between border-b border-ivory/10 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-copper-400">
              <Sparkles className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              <span>Page Assistant</span>
              <BetaPill feature="ai-page-assistant" size="sm" dismissible />
            </div>
            <button
              type="button"
              onClick={() => {
                setErrorMessage(null)
                setAssistantReply(null)
                setStage('idle')
              }}
              aria-label="Close"
              // 44px tap target on mobile (matches the popover close)
              // and the slim 28px desktop chrome the bar was tuned for.
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ivory/55 transition-colors hover:bg-ivory/5 hover:text-ivory focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-7 sm:w-7"
            >
              <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>

          {/* Body */}
          <form onSubmit={onSubmit} className="px-4 py-3">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSubmit()
                }
              }}
              // Mobile gets 3 visible rows so a thumb-typed multi-
              // sentence prompt doesn't truncate before the operator
              // can read what they wrote. Desktop auto-grows from 1.
              rows={1}
              maxLength={2000}
              disabled={isThinking}
              placeholder={
                isThinking
                  ? thinkingHint
                  : 'Tell the assistant what to change on this page…'
              }
              className="block w-full resize-none bg-transparent text-base leading-snug text-ivory placeholder:text-ivory/40 focus:outline-none disabled:cursor-wait min-h-[3.5em] sm:min-h-0"
              aria-label="Prompt"
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-3 text-[11px] text-ivory/45">
                <span className="hidden items-center gap-1 sm:inline-flex">
                  <kbd className="rounded border border-ivory/15 bg-ivory/5 px-1.5 py-0.5 font-mono text-[10px] text-ivory/65">
                    Enter
                  </kbd>
                  to send
                </span>
                <span className="hidden items-center gap-1 sm:inline-flex">
                  <kbd className="rounded border border-ivory/15 bg-ivory/5 px-1.5 py-0.5 font-mono text-[10px] text-ivory/65">
                    Esc
                  </kbd>
                  to close
                </span>
                {!isThinking && text.length === 0 && (
                  <a
                    href="/admin/help#ai-assistant"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-ivory/55 underline-offset-2 transition-colors hover:text-copper-300 hover:underline focus:outline-none focus-visible:underline focus-visible:text-copper-300"
                  >
                    Learn more
                  </a>
                )}
              </div>
              <button
                type="submit"
                disabled={isThinking || text.trim().length === 0}
                aria-label="Send prompt"
                // Mobile: 44px tall, full chrome. Desktop: tighter
                // 36px chrome to keep the bar slim.
                className="inline-flex h-11 items-center gap-1.5 rounded-full bg-copper-500 px-5 text-xs font-semibold uppercase tracking-[0.12em] text-near-black transition-all duration-standard hover:bg-copper-400 disabled:cursor-not-allowed disabled:bg-ivory/10 disabled:text-ivory/35 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-300 sm:h-9 sm:px-4"
              >
                {isThinking ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    Working
                  </>
                ) : (
                  <>
                    Send
                    <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
            {errorMessage && !isThinking && (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
                  aria-hidden="true"
                />
                <span>{errorMessage}</span>
              </div>
            )}
            {assistantReply && !errorMessage && !isThinking && (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 flex items-start gap-2 rounded-lg border border-copper-400/25 bg-copper-500/5 px-3 py-2 text-[12px] leading-relaxed text-ivory/85"
              >
                <Sparkles
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-copper-400"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span>{assistantReply}</span>
              </div>
            )}
            {isThinking && (
              <div className="mt-3 flex items-center gap-2 text-[12px] text-ivory/55">
                <span
                  className="relative block h-1 w-32 overflow-hidden rounded-full bg-ivory/10"
                  aria-hidden="true"
                >
                  <span
                    className="motion-safe:animate-cavecms-shimmer absolute inset-0 -translate-x-full rounded-full bg-gradient-to-r from-transparent via-copper-400/80 to-transparent motion-reduce:animate-none"
                    style={{ backgroundSize: '200% 100%' }}
                  />
                </span>
                {thinkingHint}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
//  Proposal modal — centered popup showing proposed changes.
// ════════════════════════════════════════════════════════════════════

function ProposalModal() {
  const {
    stage,
    setStage,
    pending,
    errorMessage,
    toggleAcceptOp,
    applyAccepted,
    dismissAll,
  } = useAssistant()
  // Lock body scroll for the duration of the modal — without this, a
  // touch-drag on the mobile fullscreen sheet's backdrop scrolls the
  // underlying page and the page jumps when the modal closes. The
  // cooperative counter cleanly handles other modals stacking.
  const isOpen = stage === 'review' || stage === 'applying'
  useEffect(() => {
    if (!isOpen) return
    acquireScrollLock()
    return () => releaseScrollLock()
  }, [isOpen])
  if (!isOpen) return null
  if (!pending) return null

  const acceptedCount = pending.accepted.filter(Boolean).length
  const allAccepted = acceptedCount === pending.changeset.length
  const isApplying = stage === 'applying'

  // PR 4 audit fix (HIGH): refuse Esc + backdrop dismiss during apply.
  // The /apply fetch has no AbortController and the failure branch
  // re-mounts the modal — without this guard the operator can dismiss
  // the modal mid-flight then have it pop back with a misleading
  // error, or worse, dismiss a successful commit they should see.
  const guardedDismiss = isApplying ? () => undefined : () => setStage('idle')

  return createPortal(
    <FocusTrap onEscape={guardedDismiss}>
      <div
        className="fixed inset-0 z-[90] flex items-center justify-center p-4 sm:p-6"
        aria-modal="true"
        role="dialog"
        aria-label="AI proposal"
      >
        <button
          type="button"
          onClick={guardedDismiss}
          aria-label="Dismiss backdrop"
          tabIndex={-1}
          disabled={isApplying}
          className="motion-safe:animate-cavecms-fade-in absolute inset-0 cursor-default bg-obsidian/55 backdrop-blur-sm disabled:cursor-wait"
        />
        <div
          className="motion-safe:animate-cavecms-scale-in relative flex h-full max-h-[100vh] w-full flex-col overflow-hidden bg-ivory shadow-[0_40px_80px_-20px_rgba(14,14,16,0.6)] ring-1 ring-obsidian/10 sm:h-auto sm:max-h-[min(680px,calc(100vh-3rem))] sm:max-w-2xl sm:rounded-2xl"
          style={{
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-obsidian/8 px-6 pt-5 pb-4">
            <div>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.24em] text-copper-600">
                <Wand2 className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                Proposed changes
              </div>
              <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-near-black">
                {pending.changeset.length === 1
                  ? '1 change to review'
                  : `${pending.changeset.length} changes to review`}
              </h2>
              {pending.modelText.length > 0 && (
                <p className="mt-2 max-w-[42rem] text-[13px] leading-relaxed text-warm-stone">
                  {pending.modelText}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={guardedDismiss}
              disabled={isApplying}
              aria-label="Close"
              // PR 5 review fix: gated on isApplying to match the
              // Esc-handler + backdrop guards. The apply fetch has no
              // AbortController; clicking X mid-flight would hide a
              // successful commit OR pop a misleading error when the
              // failure branch re-mounts the modal.
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-warm-stone transition-colors hover:bg-obsidian/5 hover:text-near-black disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-8 sm:w-8"
            >
              <X className="h-5 w-5 sm:h-4 sm:w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>

          {/* Body — scrollable list of op cards */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <ul className="space-y-3">
              {pending.changeset.map((op, i) => (
                <li
                  key={proposalCardKey(op, i)}
                  // Stagger entry so cards cascade in rather than slam.
                  // 70ms per card; capped at 8 (delays beyond that
                  // start to feel laggy on a large changeset).
                  className="motion-safe:animate-cavecms-rise"
                  style={{ animationDelay: `${Math.min(i, 8) * 70}ms` }}
                >
                  <ProposalCard
                    index={i}
                    op={op}
                    accepted={pending.accepted[i] ?? false}
                    onToggle={() => toggleAcceptOp(i)}
                  />
                </li>
              ))}
            </ul>
            {errorMessage && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
                  aria-hidden="true"
                />
                <span>{errorMessage}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t border-obsidian/8 bg-cream/30 px-6 py-4">
            <button
              type="button"
              onClick={() => void dismissAll()}
              disabled={isApplying}
              className="inline-flex h-11 items-center rounded-md px-5 text-sm font-medium text-warm-stone transition-colors hover:bg-obsidian/5 hover:text-near-black disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-9 sm:px-4"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void applyAccepted()}
              disabled={isApplying || acceptedCount === 0}
              className="inline-flex h-11 items-center gap-2 rounded-md bg-near-black px-5 text-sm font-semibold tracking-tight text-ivory shadow-[0_14px_30px_-10px_rgba(14,14,16,0.4)] transition-all duration-standard hover:bg-obsidian hover:shadow-[0_18px_36px_-10px_rgba(184,115,51,0.35)] disabled:cursor-not-allowed disabled:bg-obsidian/40 disabled:shadow-none motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-10"
            >
              {isApplying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Applying…
                </>
              ) : (
                <>
                  <Check className="h-4 w-4 text-copper-400" strokeWidth={2} aria-hidden="true" />
                  {allAccepted
                    ? `Apply ${pending.changeset.length === 1 ? 'change' : 'all'}`
                    : `Apply ${acceptedCount}`}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body,
  )
}

// ── Per-op card inside the modal ───────────────────────────────────

function ProposalCard({
  op,
  accepted,
  onToggle,
}: {
  index: number
  op: ChangesetOp
  accepted: boolean
  onToggle: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const head = headForOp(op)
  return (
    <li
      className={
        'group rounded-xl border bg-white px-4 py-3 transition-all duration-standard ' +
        (accepted
          ? 'border-copper-400/40 shadow-[0_8px_24px_-12px_rgba(184,115,51,0.25)]'
          : 'border-obsidian/8 opacity-60')
      }
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggle}
          role="switch"
          aria-checked={accepted}
          aria-label={accepted ? 'Skip this change' : 'Include this change'}
          // The visual checkbox stays 20px so the card layout reads
          // the same on all viewports, but the touch target wraps a
          // larger invisible area on mobile via padding so a thumb
          // tap doesn't miss.
          className={
            'mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border transition-colors duration-standard motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-5 sm:w-5 ' +
            (accepted
              ? 'border-copper-500 bg-copper-500'
              : 'border-obsidian/20 bg-white hover:border-obsidian/40')
          }
        >
          {accepted && (
            <Check
              className="h-4 w-4 text-near-black sm:h-3 sm:w-3"
              strokeWidth={3}
              aria-hidden="true"
            />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={
                'inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-[0.14em] ' +
                opBadgeClass(op.op)
              }
            >
              {opLabel(op.op)}
            </span>
            <span className="text-sm font-semibold tracking-tight text-near-black">
              {head.title}
            </span>
          </div>
          {head.subtitle && (
            <p className="mt-1 text-[12px] text-warm-stone">
              {head.subtitle}
            </p>
          )}
          {head.preview && (
            <div className="mt-2 max-h-24 overflow-hidden rounded-md bg-cream/50 px-3 py-2 text-[12px] leading-relaxed text-near-black/85">
              {head.preview}
            </div>
          )}
          {head.details && (
            <button
              type="button"
              onClick={() => setExpanded((s) => !s)}
              className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-warm-stone transition-colors hover:text-near-black focus:outline-none"
            >
              {expanded ? (
                <ChevronUp className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              )}
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          )}
          {expanded && head.details && (
            <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-near-black px-3 py-2 text-[11px] leading-relaxed text-ivory/85">
              {head.details}
            </pre>
          )}
        </div>
      </div>
    </li>
  )
}

// ════════════════════════════════════════════════════════════════════
//  Block decorations — copper dashed outlines on the live page for
//  each block in the pending proposal. Mounts inside the existing
//  blocks via their data-block-id attribute (set by EditableBlock).
// ════════════════════════════════════════════════════════════════════

function BlockDecorations() {
  const { stage, affectedBlockIds, pending } = useAssistant()
  const [overlays, setOverlays] = useState<
    Array<{ blockId: number; rect: DOMRect; label: string }>
  >([])

  useLayoutEffect(() => {
    if (stage !== 'review' || !pending) {
      setOverlays([])
      return
    }
    const update = () => {
      const next: Array<{ blockId: number; rect: DOMRect; label: string }> = []
      for (const id of affectedBlockIds) {
        const el = document.querySelector(
          `[data-block-id="${id}"]`,
        ) as HTMLElement | null
        if (!el) continue
        const rect = el.getBoundingClientRect()
        const ops = pending.changeset.filter((o) => {
          if ((o.op === 'edit' || o.op === 'delete') && o.blockId === id) return true
          if (o.op === 'reorder' && o.moves.some((m) => m.blockId === id)) return true
          return false
        })
        const label = ops
          .map((o) => opLabel(o.op))
          .filter((v, i, a) => a.indexOf(v) === i)
          .join(' · ')
        next.push({ blockId: id, rect, label })
      }
      setOverlays(next)
    }
    update()
    // Re-measure on scroll/resize while the modal is open.
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    const observer = new ResizeObserver(update)
    observer.observe(document.body)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      observer.disconnect()
    }
  }, [stage, affectedBlockIds, pending])

  if (stage !== 'review' || overlays.length === 0) return null

  return createPortal(
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[70]"
    >
      {overlays.map((o) => (
        <div
          key={o.blockId}
          style={{
            left: o.rect.left,
            top: o.rect.top,
            width: o.rect.width,
            height: o.rect.height,
          }}
          className="motion-safe:animate-cavecms-fade-in absolute rounded-sm outline outline-2 outline-dashed outline-offset-2 outline-copper-400/80"
        >
          <span className="absolute -top-3 right-2 inline-flex items-center gap-1 rounded-full bg-copper-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-near-black shadow-[0_6px_16px_-4px_rgba(184,115,51,0.5)]">
            <Sparkles className="h-2.5 w-2.5" strokeWidth={2} aria-hidden="true" />
            {o.label}
          </span>
        </div>
      ))}
    </div>,
    document.body,
  )
}

// ════════════════════════════════════════════════════════════════════
//  Visibility gate — read the AI snapshot from InlineEditContext and
//  decide whether to mount the assistant. Skips render when chat is
//  disabled, no key on file, or no chat model picked. The parent
//  (EditableMain) already gates on edit-mode + admin/editor role.
// ════════════════════════════════════════════════════════════════════

export function PageAssistantIfEnabled({
  pageId,
}: PageAssistantProps) {
  const ai = useAiSnapshot()
  if (!ai) return null
  if (!ai.enabled) return null
  if (!ai.chatEnabled) return null
  if (!ai.keyOnFile) return null
  if (!ai.chatModel) return null
  return <PageAssistant pageId={pageId} />
}

// ════════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════════

interface OpHead {
  title: string
  subtitle?: string
  preview?: ReactNode
  details?: string
}

function headForOp(op: ChangesetOp): OpHead {
  if (op.op === 'edit') {
    const text = previewTextForData(op.data)
    return {
      title: `Edit ${op.blockType}`,
      subtitle: `Block #${op.blockId}`,
      preview: text,
      details: JSON.stringify(op.data, null, 2),
    }
  }
  if (op.op === 'insert') {
    const text = previewTextForData(op.data)
    return {
      title: `Insert ${op.blockType}`,
      subtitle: `into column #${op.parentColumnId}`,
      preview: text,
      details: JSON.stringify(op.data, null, 2),
    }
  }
  if (op.op === 'delete') {
    return {
      title: `Delete ${op.blockType}`,
      subtitle: `Block #${op.blockId} will be removed`,
    }
  }
  return {
    title: `Reorder ${op.moves.length} block${op.moves.length === 1 ? '' : 's'}`,
    subtitle: op.moves
      .map((m) => `#${m.blockId} → col #${m.parentColumnId} @${m.position}`)
      .join(' · '),
  }
}

function previewTextForData(data: unknown, max = 260): string {
  if (data === null || typeof data !== 'object') return ''
  const strings: string[] = []
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) return
    if (typeof v === 'string') {
      const trimmed = v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (trimmed.length > 0) strings.push(trimmed)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    if (typeof v === 'object' && v !== null) {
      for (const val of Object.values(v as Record<string, unknown>)) {
        walk(val, depth + 1)
      }
    }
  }
  walk(data, 0)
  const joined = strings.join(' · ')
  if (joined.length <= max) return joined
  return joined.slice(0, max - 1) + '…'
}

function opLabel(op: ChangesetOp['op']): string {
  switch (op) {
    case 'edit':
      return 'Edit'
    case 'insert':
      return 'Insert'
    case 'delete':
      return 'Delete'
    case 'reorder':
      return 'Reorder'
  }
}

function opBadgeClass(op: ChangesetOp['op']): string {
  switch (op) {
    case 'edit':
      return 'bg-copper-100 text-copper-700'
    case 'insert':
      return 'bg-emerald-100 text-emerald-700'
    case 'delete':
      return 'bg-rose-100 text-rose-700'
    case 'reorder':
      return 'bg-warm-stone/15 text-warm-stone'
  }
}

function proposalCardKey(op: ChangesetOp, index: number): string {
  switch (op.op) {
    case 'edit':
    case 'delete':
      return `${op.op}-${op.blockId}-${index}`
    case 'insert':
      return `${op.op}-${op.parentColumnId}-${index}`
    case 'reorder':
      return `${op.op}-${op.moves.map((m) => m.blockId).join('.')}-${index}`
  }
}

function explainStartError(status: number, code: string | undefined): string {
  if (status === 401 || status === 403)
    return 'You need to sign back in to use the assistant.'
  if (status === 429)
    return code === 'chat_already_in_flight'
      ? 'A previous prompt is still running. Hold on a moment.'
      : "You're sending prompts too quickly. Wait a moment and try again."
  if (code === 'invalid_request') return 'That prompt looked malformed.'
  if (code === 'ai_disabled') return 'The assistant is currently turned off.'
  if (code === 'ai_not_configured' || code === 'ai_key_missing')
    return 'AI is not configured. Open Settings → AI to set a key.'
  return 'Could not start the assistant. Try again.'
}

function explainStreamError(code: string, detail?: string): string {
  if (code === 'timeout')
    return 'The assistant took too long to respond. Try a shorter prompt.'
  if (code === 'rate_limited')
    return "Gemini's rate limit kicked in. Wait a moment and try again."
  if (code === 'unauthorized')
    return 'Gemini rejected the saved key. Re-test the connection in Settings → AI.'
  if (code === 'unknown_model')
    return 'The configured model is unavailable. Pick a different one in Settings → AI.'
  if (code === 'ai_disabled') return 'The assistant is currently turned off.'
  if (code === 'ai_not_configured' || code === 'ai_key_missing')
    return 'AI is not configured. Open Settings → AI to set a key.'
  if (code === 'ai_key_decrypt_failed')
    return 'Could not decrypt the saved key. Re-save it in Settings → AI.'
  if (code === 'validation_failed')
    return 'The assistant returned something invalid. Try a different instruction.'
  return detail ?? 'The assistant ran into a problem. Try again.'
}

// ════════════════════════════════════════════════════════════════════
//  Focus-trap utility — keeps Tab focus inside the modal while open.
// ════════════════════════════════════════════════════════════════════

function FocusTrap({
  children,
  onEscape,
}: {
  children: ReactNode
  onEscape: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const root = ref.current
    if (!root) return
    const focusables = root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusables[0]?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onEscape()
        return
      }
      if (e.key !== 'Tab') return
      const list = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (list.length === 0) return
      const first = list[0]!
      const last = list[list.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previouslyFocused?.focus?.()
    }
  }, [onEscape])
  return <div ref={ref}>{children}</div>
}
