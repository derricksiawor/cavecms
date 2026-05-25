'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Sparkles, Languages, Lightbulb, Pencil, X, Loader2 } from 'lucide-react'
import {
  getInlineFieldsForBlock,
  isMostlyEmpty,
  supportsSuggest,
} from '@/lib/ai/inlineEligibility'
import { useAiSparkleSession, type SparkleIntent } from './AiSparkleSessionContext'
import { useEffectiveVersions } from './InlineEditContext'
import { AISparkleRewriteCard } from './AISparkleRewriteCard'
import { AISparkleTranslateCard } from './AISparkleTranslateCard'
import { AISparkleSuggestCard } from './AISparkleSuggestCard'
import { AISparkleFillInCard } from './AISparkleFillInCard'

// Anchored floating popover. Lives in a portal so its overflow isn't
// clipped by the EditableBlock's outline. Position recomputed on
// mount + window resize + scroll. Falls back to a centred modal-style
// position on tiny viewports.

interface Props {
  anchor: HTMLElement | null
  onClose: () => void
  blockId: number
  blockType: string
  blockVersion: number
  pageId: number
  pageVersion: number
  currentData: unknown
}

interface TabSpec {
  key: SparkleIntent
  label: string
  icon: typeof Sparkles
}

const POPOVER_WIDTH = 380
const POPOVER_MARGIN = 8

export function AISparklePopover(p: Props) {
  const ai = useAiSparkleSession()
  const session = ai.session
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // Tabs available for this block.
  const tabs: TabSpec[] = useMemo(() => {
    const out: TabSpec[] = [
      { key: 'rewrite', label: 'Rewrite', icon: Pencil },
      { key: 'translate', label: 'Translate', icon: Languages },
    ]
    if (supportsSuggest(p.blockType)) {
      out.push({ key: 'suggest', label: 'Suggest', icon: Lightbulb })
    }
    out.push({ key: 'fillin', label: 'Fill in', icon: Sparkles })
    return out
  }, [p.blockType])

  // Pick the default tab based on the block state. Fresh-empty
  // blocks default to Fill in so the operator's first sparkle click
  // does the most useful thing without an extra tap.
  const defaultTab: SparkleIntent = useMemo(() => {
    if (tabs.some((t) => t.key === 'fillin') && isMostlyEmpty(p.blockType, p.currentData)) {
      return 'fillin'
    }
    return 'rewrite'
  }, [p.blockType, p.currentData, tabs])

  const [activeTab, setActiveTab] = useState<SparkleIntent>(defaultTab)

  // When the streaming session lands on this block, switch the active
  // tab to whatever intent kicked off the request — so closing + re-
  // opening the popover doesn't lose context.
  useEffect(() => {
    if (session && session.blockId === p.blockId) {
      setActiveTab(session.intent)
    }
  }, [session, p.blockId])

  // Position the popover beneath the anchor button (the toolbar's
  // sparkle). Falls back to a centred position on very narrow
  // viewports where the natural anchor placement would clip off-
  // screen.
  useLayoutEffect(() => {
    if (!p.anchor) return
    const compute = () => {
      const rect = p.anchor!.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2
      // Keep inside viewport horizontally.
      if (left + POPOVER_WIDTH + POPOVER_MARGIN > viewportWidth) {
        left = viewportWidth - POPOVER_WIDTH - POPOVER_MARGIN
      }
      if (left < POPOVER_MARGIN) left = POPOVER_MARGIN
      // Open below the anchor; if there isn't room, open above.
      const popoverMaxHeight = 480
      let top = rect.bottom + POPOVER_MARGIN
      if (top + popoverMaxHeight + POPOVER_MARGIN > viewportHeight) {
        top = Math.max(POPOVER_MARGIN, rect.top - popoverMaxHeight - POPOVER_MARGIN)
      }
      setPos({ top, left })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [p.anchor])

  // Esc + click-outside dismiss. Dismiss path ALSO calls ai.dismiss()
  // so a half-finished session doesn't leave a phantom preview on
  // the block.
  const close = useCallback(() => {
    // If a session is in-flight or ready against THIS block, dismiss it
    // (cancels stream + cleans up pending tokens). Sessions targeting a
    // different block are untouched.
    if (session && session.blockId === p.blockId) {
      void ai.dismiss()
    }
    p.onClose()
  }, [ai, session, p])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current) return
      const target = e.target as Node
      if (popoverRef.current.contains(target)) return
      // Don't dismiss when clicking the anchor button — it has its
      // own toggle logic and would otherwise close + immediately
      // re-open on the same click.
      if (p.anchor && p.anchor.contains(target)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [close, p.anchor])

  // Auto-focus the popover container on mount for keyboard nav.
  useEffect(() => {
    popoverRef.current?.focus()
  }, [])

  // Resolve the FRESHEST page-version cursor from InlineEditContext —
  // updates instantly after any sibling save (the context's version-
  // overrides map holds the post-save cursor), so an Apply right after
  // a sibling block edit doesn't 409 on stale_page_version. Falls back
  // to the prop the popover was opened with.
  const versions = useEffectiveVersions(p.blockId, {
    blockVersion: p.blockVersion,
    pageVersion: p.pageVersion,
  })

  if (typeof document === 'undefined' || !pos) return null

  const fields = getInlineFieldsForBlock(p.blockType)
  const friendlyType = p.blockType.replace(/_/g, ' ')
  const isStreaming =
    session?.blockId === p.blockId &&
    (session.status === 'preparing' || session.status === 'streaming')
  const isReady = session?.blockId === p.blockId && session.status === 'ready'
  const isApplying = session?.blockId === p.blockId && session.status === 'applying'
  const isError = session?.blockId === p.blockId && session.status === 'error'

  const handleStart = (intent: SparkleIntent, opts: Record<string, unknown>) => {
    void ai.start({
      blockId: p.blockId,
      blockType: p.blockType,
      blockVersion: p.blockVersion,
      pageId: p.pageId,
      pageVersion: p.pageVersion,
      currentData: p.currentData,
      intent,
      ...opts,
    })
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Ask AI to edit this ${friendlyType} block`}
      tabIndex={-1}
      // High z so it floats above the EditableBlock toolbar AND the
      // OutlinePanel. EditDrawer sits at z-50; we go higher (z-[60])
      // so a sparkle pop while the drawer is open is reachable.
      className="fixed z-[60] flex w-[380px] flex-col overflow-hidden rounded-2xl bg-cream-50 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.35)] ring-1 ring-warm-stone/20 focus:outline-none"
      style={{ top: pos.top, left: pos.left, maxHeight: 480 }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header — block type + close button. */}
      <header className="flex items-center justify-between gap-3 border-b border-warm-stone/15 bg-obsidian px-4 py-3 text-cream-50">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-copper-300" aria-hidden="true" />
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-copper-200">
            Ask AI
          </p>
          <span aria-hidden="true" className="text-[10px] text-cream-50/40">
            ·
          </span>
          <p className="text-[12px] font-medium tracking-tight text-cream-50/90">
            {friendlyType}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-cream-50/80 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:bg-cream-50/10 focus-visible:outline-none"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {/* Tab bar — pill-shaped, copper-accented underline on active. */}
      {!isReady && !isStreaming && !isError && (
        <div
          role="tablist"
          aria-label="AI affordances"
          className="flex border-b border-warm-stone/15 bg-cream-50"
        >
          {tabs.map((t) => {
            const Active = t.icon
            const isActive = t.key === activeTab
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`ai-sparkle-tab-${t.key}`}
                onClick={() => setActiveTab(t.key)}
                className={clsx(
                  'flex-1 inline-flex items-center justify-center gap-1.5 py-3 text-[11px] font-medium uppercase tracking-[0.16em] transition-colors',
                  isActive
                    ? 'text-copper-700 border-b-2 border-copper-500'
                    : 'text-warm-stone hover:text-near-black hover:bg-cream-100/60 border-b-2 border-transparent',
                )}
              >
                <Active size={13} aria-hidden="true" />
                {t.label}
              </button>
            )
          })}
        </div>
      )}

      {/* Body — tab content OR streaming-status panel OR ready panel. */}
      <div
        id={`ai-sparkle-tab-${activeTab}`}
        role="tabpanel"
        className="flex flex-1 flex-col overflow-y-auto bg-cream-50 px-4 py-4 text-near-black"
        aria-live="polite"
      >
        {isStreaming ? (
          <StreamingPanel intent={session!.intent} onCancel={() => void ai.dismiss()} />
        ) : isReady ? (
          <ReadyPanel
            onApply={(token) =>
              void ai.apply({ token, pageVersion: versions.pageVersion })
            }
            onDismiss={() => void ai.dismiss()}
            isApplying={isApplying}
          />
        ) : isError ? (
          <ErrorPanel
            message={session?.errorMessage ?? 'Something went wrong.'}
            onRetry={() => void ai.dismiss()}
          />
        ) : activeTab === 'rewrite' ? (
          <AISparkleRewriteCard
            onSubmit={(toneChip, freeText) =>
              handleStart('rewrite', { toneChip, freeText })
            }
          />
        ) : activeTab === 'translate' ? (
          <AISparkleTranslateCard
            onSubmit={(language, freeText) =>
              handleStart('translate', { language, freeText })
            }
          />
        ) : activeTab === 'suggest' ? (
          <AISparkleSuggestCard
            onSubmit={(freeText) => handleStart('suggest', { freeText })}
          />
        ) : (
          <AISparkleFillInCard
            onSubmit={(freeText) => handleStart('fillin', { freeText })}
          />
        )}
      </div>

      {/* Footer status — only when there's a tab visible AND the
          block carries multiple eligible fields, surface the field
          list so the operator knows what's being rewritten. */}
      {!isStreaming && !isReady && !isError && fields.length > 1 && (
        <footer className="border-t border-warm-stone/15 bg-cream-100/60 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-warm-stone">
          {fields.length} editable fields
        </footer>
      )}
    </div>,
    document.body,
  )
}

function StreamingPanel({
  intent,
  onCancel,
}: {
  intent: SparkleIntent
  onCancel: () => void
}) {
  const label =
    intent === 'translate'
      ? 'Translating'
      : intent === 'suggest'
        ? 'Drafting options'
        : intent === 'fillin'
          ? 'Filling in'
          : 'Rewriting'
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8 text-center">
      <Loader2
        size={32}
        className="text-copper-500 animate-spin"
        aria-hidden="true"
      />
      <div>
        <p className="text-sm font-semibold text-near-black">
          {label}…
        </p>
        <p className="mt-1 text-[11px] text-warm-stone">
          Watch the block update live as the AI works.
        </p>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-full bg-cream-100 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone hover:bg-cream-200 hover:text-near-black transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}

function ReadyPanel({
  onApply,
  onDismiss,
  isApplying,
}: {
  onApply: (token?: string) => void
  onDismiss: () => void
  isApplying: boolean
}) {
  // For Suggest, the operator picks an option from the SuggestCard
  // which itself owns the Apply CTA per-option. For the other intents
  // we render a single Apply/Dismiss pair.
  const ai = useAiSparkleSession()
  const session = ai.session
  if (session?.intent === 'suggest') {
    return (
      <SuggestReadyPanel onApply={onApply} onDismiss={onDismiss} isApplying={isApplying} />
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700">
          Ready to apply
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-warm-stone">
          The block above shows the proposed change. Apply to commit it or
          dismiss to revert.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onDismiss}
          disabled={isApplying}
          className="rounded-full bg-transparent px-5 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-warm-stone hover:bg-cream-100 hover:text-near-black transition-colors disabled:opacity-60"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={() => onApply()}
          disabled={isApplying}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-copper-500 px-5 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-cream-50 hover:bg-copper-600 transition-colors disabled:opacity-60"
        >
          {isApplying ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : null}
          Apply
        </button>
      </div>
    </div>
  )
}

function SuggestReadyPanel({
  onApply,
  onDismiss,
  isApplying,
}: {
  onApply: (token?: string) => void
  onDismiss: () => void
  isApplying: boolean
}) {
  const ai = useAiSparkleSession()
  const session = ai.session
  const options = session?.suggestOptions ?? []
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700">
          Pick one
        </p>
        <p className="mt-1 text-[11px] text-warm-stone">
          Hover to preview on the block.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {options.map((opt, idx) => (
          <li key={opt.token}>
            <button
              type="button"
              onClick={() => onApply(opt.token)}
              onMouseEnter={() => ai.setSuggestPreview(idx)}
              onMouseLeave={() => ai.setSuggestPreview(null)}
              onFocus={() => ai.setSuggestPreview(idx)}
              onBlur={() => ai.setSuggestPreview(null)}
              disabled={isApplying}
              className="w-full rounded-xl bg-cream-100 px-4 py-3 text-left text-[13px] leading-relaxed text-near-black ring-1 ring-warm-stone/15 transition-colors hover:bg-copper-50 hover:ring-copper-300/40 focus-visible:bg-copper-50 focus-visible:ring-copper-300 focus-visible:outline-none disabled:opacity-60"
            >
              {opt.option}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          disabled={isApplying}
          className="rounded-full bg-transparent px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-warm-stone hover:bg-cream-100 hover:text-near-black transition-colors disabled:opacity-60"
        >
          None of these
        </button>
      </div>
    </div>
  )
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col gap-3 py-6 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-red-700">
        Something stopped us
      </p>
      <p className="text-[12px] leading-relaxed text-warm-stone">{message}</p>
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-cream-100 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-near-black hover:bg-cream-200 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
