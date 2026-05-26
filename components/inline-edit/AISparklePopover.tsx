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
import { BetaPill } from '@/components/ui/BetaPill'
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
// Viewport breakpoint that flips us from "anchored floating popover"
// to "bottom-sheet". 640px matches Tailwind's `sm` breakpoint.
const MOBILE_BREAKPOINT_PX = 640

export function AISparklePopover(p: Props) {
  const ai = useAiSparkleSession()
  const session = ai.session
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Track viewport size client-side. Default false so SSR renders the
  // desktop affordance — the popover is portal-mounted to document.body
  // and only ever runs client-side anyway, so the initial false is just
  // a paint-flicker guard, not a layout commitment.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`)
    setIsMobile(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    // Safari < 14 doesn't have addEventListener on MediaQueryList; fall
    // back to addListener. Both are no-ops on the unmount path.
    try {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    } catch {
      const legacy = mql as MediaQueryList & {
        addListener: (l: (e: MediaQueryListEvent) => void) => void
        removeListener: (l: (e: MediaQueryListEvent) => void) => void
      }
      legacy.addListener(onChange)
      return () => legacy.removeListener(onChange)
    }
  }, [])

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
    // Skip anchor-positioning on mobile — the bottom-sheet branch uses
    // fixed-bottom CSS positioning and ignores `pos`.
    if (isMobile) {
      setPos({ top: 0, left: 0 })
      return
    }
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
  }, [p.anchor, isMobile])

  // Esc + click-outside dismiss. Dismiss path ALSO calls ai.dismiss()
  // so a half-finished session doesn't leave a phantom preview on
  // the block.
  //
  // PR 5 review fix: depend on stable values (blockId, onClose)
  // rather than the entire props object `p` — `p` is a fresh ref each
  // render, so a streaming session that flips state frequently would
  // otherwise remove + re-add three document listeners on every
  // re-render. Between those removes and re-adds a synchronous
  // third-party event could fire while no listener is bound, missing
  // a click-outside dismiss.
  const { blockId: pBlockId, onClose: pOnClose } = p
  const close = useCallback(() => {
    // If a session is in-flight or ready against THIS block, dismiss it
    // (cancels stream + cleans up pending tokens). Sessions targeting a
    // different block are untouched.
    if (session && session.blockId === pBlockId) {
      void ai.dismiss()
    }
    pOnClose()
  }, [ai, session, pBlockId, pOnClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    const onPress = (e: MouseEvent | TouchEvent) => {
      if (!popoverRef.current) return
      const target = e.target as Node
      if (popoverRef.current.contains(target)) return
      // Don't dismiss when clicking the anchor button — it has its
      // own toggle logic and would otherwise close + immediately
      // re-open on the same press.
      if (p.anchor && p.anchor.contains(target)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    // Listen for BOTH mousedown and touchstart so iOS Safari's
    // synthetic-event timing doesn't make the bottom-sheet dismiss
    // feel laggy. The handler is idempotent — same press fires
    // either path, and the popoverRef.contains check prevents double
    // dismiss on a single tap.
    document.addEventListener('mousedown', onPress)
    document.addEventListener('touchstart', onPress, { passive: true })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('touchstart', onPress)
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

  // Two layout shapes:
  //   - Desktop (≥ sm): anchored floating popover at computed pos.
  //   - Mobile (< sm): full-width bottom-sheet sliding up from the
  //     viewport edge. Same content; different chrome. The bottom
  //     sheet respects iOS safe-area-inset-bottom so the home-bar /
  //     notch don't eat the action row.
  const sharedClasses =
    'flex flex-col overflow-hidden bg-ivory shadow-[0_30px_80px_-20px_rgba(14,14,16,0.45)] ring-1 ring-obsidian/8 focus:outline-none'
  const desktopClasses =
    'motion-safe:animate-cavecms-scale-in fixed z-[60] w-[380px] rounded-2xl'
  const mobileClasses =
    'motion-safe:animate-cavecms-slide-up fixed inset-x-0 bottom-0 z-[60] w-full rounded-t-2xl pb-[env(safe-area-inset-bottom,0px)]'
  const desktopStyle: React.CSSProperties = {
    top: pos.top,
    left: pos.left,
    maxHeight: 480,
  }
  const mobileStyle: React.CSSProperties = {
    // Use ~75vh so there's a peek of the page behind the sheet —
    // makes it feel like a sheet, not a modal takeover.
    maxHeight: '75vh',
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
      className={`${sharedClasses} ${isMobile ? mobileClasses : desktopClasses}`}
      style={isMobile ? mobileStyle : desktopStyle}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Mobile drag handle — visual cue + tap target for the
          imagined swipe-to-dismiss (not wired yet — Esc + backdrop
          still drive close). Tiny copper stub. */}
      {isMobile && (
        <span
          aria-hidden="true"
          className="mx-auto mt-2 mb-1 h-1 w-10 flex-shrink-0 rounded-full bg-warm-stone/30"
        />
      )}
      {/* Top strip — slim copper accent + label + close. Replaces the
          heavy obsidian header. */}
      <header className="flex items-center justify-between gap-3 border-b border-obsidian/8 bg-ivory px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles
            size={13}
            strokeWidth={1.75}
            className="text-copper-500"
            aria-hidden="true"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-copper-600">
            Inline AI
          </p>
          <BetaPill feature="ai-sparkle" size="sm" dismissible />
          <span aria-hidden="true" className="text-[10px] text-warm-stone/40">
            ·
          </span>
          <p className="truncate text-[12px] font-medium tracking-tight text-warm-stone">
            {friendlyType}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          // sm:h-6 keeps the desktop chrome tight; the base h-11
          // ensures a 44px touch target on mobile, where the popover
          // is a bottom sheet and operators are reaching for it with
          // a thumb.
          className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-warm-stone transition-colors hover:bg-obsidian/5 hover:text-near-black focus-visible:bg-obsidian/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-6 sm:w-6"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {/* Tab chips — pill-shaped, copper-accented active state. Less
          visual weight than the prior full-width tab-bar. */}
      {!isReady && !isStreaming && !isError && (
        <div
          role="tablist"
          aria-label="AI affordances"
          className="flex flex-wrap gap-1.5 border-b border-obsidian/8 bg-ivory px-3 py-2.5"
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
                  // Larger touch target on mobile (h-10 = 40px ≈ Apple's
                  // 44pt recommended minimum given the chip's wider
                  // bounding box). Desktop keeps the tighter h-auto +
                  // py-1.5 sizing.
                  'inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 text-[11px] font-medium tracking-tight transition-all duration-standard motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 sm:h-auto sm:py-1.5',
                  isActive
                    ? 'bg-near-black text-ivory shadow-[0_6px_16px_-6px_rgba(14,14,16,0.35)]'
                    : 'bg-obsidian/5 text-warm-stone hover:bg-obsidian/10 hover:text-near-black',
                )}
              >
                <Active size={12} strokeWidth={1.75} aria-hidden="true" />
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
        className="flex flex-1 flex-col overflow-y-auto bg-ivory px-4 py-4 text-near-black"
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
        <footer className="border-t border-obsidian/8 bg-cream/40 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-warm-stone">
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
    <div className="flex flex-col items-center justify-center gap-5 py-10 text-center">
      <span
        aria-hidden="true"
        className="relative inline-flex h-10 w-10 items-center justify-center"
      >
        <span className="absolute inset-0 rounded-full bg-copper-500/15 motion-safe:animate-cavecms-pulse-copper" />
        <Sparkles
          size={18}
          strokeWidth={1.75}
          className="relative text-copper-500 motion-safe:animate-cavecms-shimmer"
        />
      </span>
      <div>
        <p className="text-sm font-semibold tracking-tight text-near-black">
          {label}…
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-warm-stone">
          Watch the block update live as the AI works.
        </p>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-8 items-center rounded-full px-4 text-[11px] font-medium tracking-tight text-warm-stone transition-colors hover:bg-obsidian/5 hover:text-near-black focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
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
    <div className="flex flex-col gap-4 motion-safe:animate-cavecms-fade-in">
      <div className="flex items-start gap-2.5 rounded-lg border border-copper-400/25 bg-copper-500/5 px-3 py-2.5">
        <Sparkles
          size={14}
          strokeWidth={1.75}
          className="mt-0.5 flex-shrink-0 text-copper-500"
          aria-hidden="true"
        />
        <div>
          <p className="text-[12px] font-semibold tracking-tight text-near-black">
            Proposed change ready
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-warm-stone">
            The block above shows the preview. Apply to commit or dismiss to revert.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          disabled={isApplying}
          className="inline-flex h-9 items-center rounded-md px-4 text-[12px] font-medium tracking-tight text-warm-stone transition-colors hover:bg-obsidian/5 hover:text-near-black disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={() => onApply()}
          disabled={isApplying}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-near-black px-4 text-[12px] font-semibold tracking-tight text-ivory shadow-[0_10px_24px_-10px_rgba(14,14,16,0.4)] transition-all duration-standard hover:bg-obsidian hover:shadow-[0_14px_28px_-10px_rgba(184,115,51,0.35)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
        >
          {isApplying ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles size={13} strokeWidth={1.75} className="text-copper-400" aria-hidden="true" />
          )}
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
    <div className="flex flex-col gap-3 py-6 text-center motion-safe:animate-cavecms-fade-in">
      <p className="text-[11px] font-semibold tracking-tight text-near-black">
        Something stopped us
      </p>
      <p className="text-[12px] leading-relaxed text-warm-stone">{message}</p>
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-8 items-center rounded-md bg-obsidian/5 px-4 text-[11px] font-medium tracking-tight text-near-black transition-colors hover:bg-obsidian/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
