'use client'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import clsx from 'clsx'

// Minimal toast system. Replaces the inline "Saved." text scattered
// across every editor. Three intents: success / error / info, all
// rendered with the copper-on-cream palette and a soft elevation.
//
// No new deps — a context provider plus a fixed-position stack in
// the bottom-right. Toasts auto-dismiss after 3.5 seconds; users can
// dismiss earlier via the close button.

/** Chunk J — optional action slot. Lets a success/info toast carry an
 *  inline button (e.g. "Undo") that the operator can click for ~5s
 *  before the toast auto-dismisses. After click, the toast dismisses
 *  immediately. The handler is held by reference in the toast item;
 *  the toast layer wraps it so a closure leak through the item ref
 *  doesn't outlive the toast (see ToastCard cleanup below). */
export interface ToastAction {
  label: string
  /** Called when the operator clicks the action button. The toast
   *  dismisses immediately AFTER the handler runs (synchronously). */
  onClick: () => void
}

export interface ToastItem {
  id: number
  intent: 'success' | 'error' | 'info'
  message: string
  /** Chunk J — optional. When present, renders an inline action button
   *  next to the message. */
  action?: ToastAction
  /** Per-call TTL override in ms. When omitted, plain toasts use
   *  TOAST_TTL_MS and action-bearing toasts use TOAST_ACTION_TTL_MS.
   *  Callers can pass a longer value for high-blast-radius verbs
   *  (e.g. section delete → 12_000) so the operator has more time to
   *  click Undo before the cascade becomes invisible. */
  durationMs?: number
}

interface ToastCtx {
  push: (
    intent: ToastItem['intent'],
    message: string,
    action?: ToastAction,
    durationMs?: number,
  ) => void
  success: (message: string, action?: ToastAction, durationMs?: number) => void
  error: (message: string, action?: ToastAction, durationMs?: number) => void
  info: (message: string, action?: ToastAction, durationMs?: number) => void
}

const Ctx = createContext<ToastCtx | null>(null)

let nextId = 1
// Plain toasts disappear after 3.5s. Toasts that carry an inline
// action (e.g. "Undo" on a destructive verb) get a longer window so
// the operator has time to read AND click. Linear/Notion convention
// for actionable toasts is 8-10s. Audit finding E5 (Chunk K).
const TOAST_TTL_MS = 3_500
const TOAST_ACTION_TTL_MS = 8_000
// Error toasts hold the longest. They carry a failure the operator must
// read — and often ACT on (e.g. "update to an in-between version first, or
// re-install with the CLI"). At the 3.5s plain TTL an actionable error can
// vanish before it's read, which reads as "the popup flashed and was gone."
// Hover/focus still pause it; the close button still dismisses early.
const TOAST_ERROR_TTL_MS = 10_000
// Stack cap — drop the oldest when more than this many are visible
// at once. Without this, rapid mutation bursts (e.g. drag-reorder 20
// blocks in 8s with hover-pause active) stack toasts off-screen and
// hold one closure per toast. The cap preserves the most recent
// feedback signals. Post-agent-review A3 (Chunk K).
const TOAST_MAX_VISIBLE = 5
// Bounded growth of `dismissedRef` — over a multi-hour editor
// session, an uncapped Set would accumulate one entry per dismiss.
// 200 entries cover ~40s of dismiss history at 5 toasts/sec, well
// over the 8s orphan-timer window the Set protects against. Post-
// round-2 review NEW-2.
const DISMISSED_CAP = 200

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  // Track timers per-toast so dismiss-by-id clears the pending auto-dismiss
  // and a stale timer can't unmount the wrong toast.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  // Dismissed-id set — populated when dismiss runs, consulted by
  // resumeDismiss to avoid re-arming a timer for a toast that's
  // already been removed from items. Without this, the click→
  // dismiss→mouseleave sequence (click fires inside the toast, then
  // pointer naturally leaves the now-unmounting element) leaves
  // resumeDismiss to re-arm a timer that will fire on a dead id.
  // The timer's dismiss() is a filter no-op, so no observable
  // damage today — but the orphan timer holds the closure for the
  // full TTL, and the intent of the `has(id)` guard was inverted
  // relative to its comment. Post-agent-review R6 / D2 (Chunk K).
  //
  // Capped at DISMISSED_CAP via FIFO-drop (Set preserves insertion
  // order — `values().next().value` gives the oldest). With an
  // 8s orphan-timer window and typical mutation cadence < 5/sec,
  // a 200-entry cap covers ~40s of dismiss history — far more than
  // the orphan window needs. Post-round-2 review NEW-2.
  const dismissedRef = useRef<Set<number>>(new Set())
  const markDismissed = useCallback((id: number) => {
    dismissedRef.current.add(id)
    if (dismissedRef.current.size > DISMISSED_CAP) {
      const oldest = dismissedRef.current.values().next().value
      if (typeof oldest === 'number') dismissedRef.current.delete(oldest)
    }
  }, [])

  const dismiss = useCallback(
    (id: number) => {
      setItems((prev) => prev.filter((t) => t.id !== id))
      const t = timersRef.current.get(id)
      if (t) {
        clearTimeout(t)
        timersRef.current.delete(id)
      }
      markDismissed(id)
    },
    [markDismissed],
  )

  const push = useCallback(
    (
      intent: ToastItem['intent'],
      message: string,
      action?: ToastAction,
      durationMs?: number,
    ) => {
      const id = nextId++
      // Resolve the effective lifetime ONCE and bake it onto the item, so the
      // initial auto-dismiss timer AND any hover-pause/resume reuse the same
      // value. Precedence: explicit per-call durationMs → action-bearing →
      // error (longest, must be read) → plain default.
      const ttl =
        typeof durationMs === 'number' && durationMs > 0
          ? durationMs
          : action
            ? TOAST_ACTION_TTL_MS
            : intent === 'error'
              ? TOAST_ERROR_TTL_MS
              : TOAST_TTL_MS
      setItems((prev) => {
        const next = [...prev, { id, intent, message, action, durationMs: ttl }]
        if (next.length <= TOAST_MAX_VISIBLE) return next
        // Drop the oldest. Also cancel its timer so the spillover
        // doesn't fire dismiss on an id no longer in items.
        const overflow = next.slice(0, next.length - TOAST_MAX_VISIBLE)
        for (const o of overflow) {
          const t = timersRef.current.get(o.id)
          if (t) {
            clearTimeout(t)
            timersRef.current.delete(o.id)
          }
          markDismissed(o.id)
        }
        return next.slice(-TOAST_MAX_VISIBLE)
      })
      const t = setTimeout(() => dismiss(id), ttl)
      timersRef.current.set(id, t)
    },
    [dismiss, markDismissed],
  )

  // Hover-pause / focus-pause: the ToastCard calls these to suspend
  // its auto-dismiss timer while the pointer is over it (or while
  // anything inside it is keyboard-focused). On leave/blur the
  // remaining time restarts from scratch — simpler than tracking the
  // partial elapsed window, and the operator's "I want to read this"
  // gesture is what gates dismissal anyway.
  const pauseDismiss = useCallback((id: number) => {
    const t = timersRef.current.get(id)
    if (t) {
      clearTimeout(t)
      timersRef.current.delete(id)
    }
  }, [])
  const resumeDismiss = useCallback(
    (id: number, hasAction: boolean, durationMs: number | undefined) => {
      // Skip if the toast has been dismissed (e.g., via click) — the
      // mouseleave that fires after the click would otherwise re-arm
      // an orphan timer for a no-longer-rendered toast.
      if (dismissedRef.current.has(id)) return
      // Skip if a timer is still armed (defensive — pauseDismiss
      // should have cleared it, but if mouseleave fires without a
      // prior mouseenter we want a no-op rather than double-arm).
      if (timersRef.current.has(id)) return
      const ttl =
        typeof durationMs === 'number' && durationMs > 0
          ? durationMs
          : hasAction
            ? TOAST_ACTION_TTL_MS
            : TOAST_TTL_MS
      const t = setTimeout(() => dismiss(id), ttl)
      timersRef.current.set(id, t)
    },
    [dismiss],
  )

  // Stable callbacks for convenience. Each accepts the optional action
  // slot — callers omit it for the existing "Saved." style toasts and
  // pass it for the Chunk J inline-Undo flow. Third arg is an optional
  // per-call duration override (ms) for high-blast-radius verbs that
  // need a longer Undo window than the standard action TTL.
  const success = useCallback(
    (m: string, a?: ToastAction, durationMs?: number) =>
      push('success', m, a, durationMs),
    [push],
  )
  const error = useCallback(
    (m: string, a?: ToastAction, durationMs?: number) =>
      push('error', m, a, durationMs),
    [push],
  )
  const info = useCallback(
    (m: string, a?: ToastAction, durationMs?: number) =>
      push('info', m, a, durationMs),
    [push],
  )

  // Clean up any in-flight timers on unmount.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((t) => clearTimeout(t))
      timers.clear()
    }
  }, [])

  // Memoise the provider value — push/success/error/info are useCallback-
  // stable, so a fresh wrapper object per render would needlessly cascade
  // re-renders into every `useToast()` consumer (every save path,
  // SpacingToolbar, EditableBlock toolbar, etc).
  const api = useMemo(
    () => ({ push, success, error, info }),
    [push, success, error, info],
  )

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-6 right-6 z-[100] flex flex-col gap-3 max-w-[calc(100vw-3rem)]"
      >
        {items.map((t) => (
          <ToastCard
            key={t.id}
            item={t}
            onDismiss={() => dismiss(t.id)}
            onPause={() => pauseDismiss(t.id)}
            onResume={() => resumeDismiss(t.id, !!t.action, t.durationMs)}
          />
        ))}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ToastCtx {
  const c = useContext(Ctx)
  if (!c) {
    // Throwing in dev surfaces the missing provider immediately.
    // In production, return a no-op so a stray toast() call doesn't
    // crash the page. The lint passes on the typecheck side.
    if (process.env.NODE_ENV !== 'production') {
      throw new Error('useToast must be used within <ToastProvider>')
    }
    return {
      push: () => undefined,
      success: () => undefined,
      error: () => undefined,
      info: () => undefined,
    }
  }
  return c
}

function ToastCard({
  item,
  onDismiss,
  onPause,
  onResume,
}: {
  item: ToastItem
  onDismiss: () => void
  onPause: () => void
  onResume: () => void
}) {
  return (
    <div
      role={item.intent === 'error' ? 'alert' : 'status'}
      // Hover + focus both pause the dismiss timer so a screen-
      // reader user reading the toast or a mouse user reaching for
      // Undo doesn't lose the toast mid-action. onMouseLeave +
      // onBlur restart it. Audit finding E5 (Chunk K).
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocusCapture={onPause}
      onBlurCapture={onResume}
      className={clsx(
        'pointer-events-auto flex items-start gap-3 rounded-2xl border bg-cream-50 px-4 py-3 shadow-[0_18px_40px_-20px_rgba(5,5,5,0.4)] backdrop-blur-sm animate-cavecms-toast-in min-w-[260px]',
        item.intent === 'success' && 'border-copper-300/60',
        item.intent === 'error' && 'border-red-400/60',
        item.intent === 'info' && 'border-warm-stone/30',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          item.intent === 'success' && 'bg-copper-500 text-cream-50',
          item.intent === 'error' && 'bg-red-500 text-cream-50',
          item.intent === 'info' && 'bg-warm-stone text-cream-50',
        )}
      >
        {item.intent === 'success' ? (
          <CheckMark />
        ) : item.intent === 'error' ? (
          <CrossMark />
        ) : (
          <InfoMark />
        )}
      </span>
      <p className="flex-1 text-sm leading-snug text-near-black">{item.message}</p>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            // Snapshot the handler before dismiss so a re-render that
            // unsets item.action between the operator's click and this
            // callback (extremely unlikely but defensive) doesn't crash.
            // The closure over `item.action` is fine here because the
            // toast is dismissed immediately after — no long-lived ref
            // to operator data survives.
            const handler = item.action?.onClick
            onDismiss()
            handler?.()
          }}
          className="inline-flex h-9 min-w-[44px] items-center rounded-lg border border-copper-300/60 bg-cream-50 px-3 text-xs font-semibold uppercase tracking-[0.18em] text-copper-600 transition-colors hover:bg-copper-50 hover:text-copper-700"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-warm-stone transition-colors hover:text-near-black"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="6" y1="18" x2="18" y2="6" />
        </svg>
      </button>
    </div>
  )
}

function CheckMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
function CrossMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  )
}
function InfoMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="12" y1="7" x2="12" y2="7.5" />
    </svg>
  )
}
