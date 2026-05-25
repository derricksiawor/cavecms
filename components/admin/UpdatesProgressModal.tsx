'use client'
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, XCircle, RefreshCcw, AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/Button'
import type { UpdateState, UpdateStatus } from '@/lib/updates/statusFile'
import {
  UPDATE_POLL_FAST_MS,
  UPDATE_POLL_SLOW_MS,
  UPDATE_RECONNECT_MAX_RETRIES,
  UPDATE_STATUS_FETCH_TIMEOUT_MS,
  UPDATE_TOTAL_STEPS,
} from '@/lib/updates/constants'

// Live progress modal driven by polling /api/admin/updates/status.
//
// State-aware polling cadence (read off REFS, not state — the
// setTimeout chain doesn't re-mount per render, so closure-captured
// state would always be stale):
//   preflight | updating  → every UPDATE_POLL_SLOW_MS
//   restarting + network errors → every UPDATE_POLL_FAST_MS
//   completed | failed | rolled_back | idle → stop polling
//
// Restart resilience: while the new Next.js process is being reloaded,
// /api/admin/updates/status may briefly return 502/network errors for
// 5-15 s. We swallow up to UPDATE_RECONNECT_MAX_RETRIES consecutive
// errors (~90 s at fast cadence) before treating the update as failed.

const STEP_LABELS = [
  'Getting ready',
  'Downloading the new version',
  'Preparing your data',
  'Building your site',
  'Restarting',
  'Making sure everything works',
]

const TERMINAL: ReadonlySet<UpdateState> = new Set<UpdateState>([
  'idle',
  'completed',
  'failed',
  'rolled_back',
])

export function UpdatesProgressModal({
  open,
  onClose,
  onCompleted,
}: {
  open: boolean
  onClose: () => void
  onCompleted?: () => void
}) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [networkErrorCount, setNetworkErrorCount] = useState(0)

  // Refs mirror the latest values so the setTimeout chain (which
  // captures its initial closure) can read live state. Without these,
  // the cadence-aware polling never adapts — it polls at SLOW_MS
  // forever regardless of state transitions.
  const statusRef = useRef<UpdateStatus | null>(null)
  const errorCountRef = useRef(0)
  const terminalRef = useRef(false)
  const completedFiredRef = useRef(false)

  // Keep refs in sync with state on every render.
  useEffect(() => {
    statusRef.current = status
  }, [status])
  useEffect(() => {
    errorCountRef.current = networkErrorCount
  }, [networkErrorCount])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    // Reset terminal flag and completed-fired flag at the start of
    // a fresh open (handles fast close→reopen sequences that React
    // may batch into a single render pass).
    terminalRef.current = false
    completedFiredRef.current = false

    async function tick() {
      if (cancelled || terminalRef.current) return
      try {
        const r = await fetch('/api/admin/updates/status', {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(UPDATE_STATUS_FETCH_TIMEOUT_MS),
        })
        if (cancelled) return
        if (!r.ok) throw new Error(`status_${r.status}`)
        const j = (await r.json()) as UpdateStatus
        setStatus(j)
        statusRef.current = j
        if (errorCountRef.current !== 0) {
          setNetworkErrorCount(0)
          errorCountRef.current = 0
        }
        if (j.state === 'completed' && !completedFiredRef.current) {
          completedFiredRef.current = true
          onCompleted?.()
        }
        if (TERMINAL.has(j.state)) {
          terminalRef.current = true
          return // stop polling
        }
      } catch {
        if (cancelled) return
        const next = errorCountRef.current + 1
        errorCountRef.current = next
        setNetworkErrorCount(next)
        if (next >= UPDATE_RECONNECT_MAX_RETRIES) {
          // The new process never came back. Treat as failed and
          // STOP the poll chain — otherwise we'd keep firing forever.
          const failed: UpdateStatus = {
            state: 'failed',
            step: 5,
            totalSteps: UPDATE_TOTAL_STEPS,
            startedAt: statusRef.current?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            error:
              'The application did not come back online after the restart.',
            ...(statusRef.current?.toSha ? { toSha: statusRef.current.toSha } : {}),
            ...(statusRef.current?.fromSha
              ? { fromSha: statusRef.current.fromSha }
              : {}),
          }
          setStatus(failed)
          statusRef.current = failed
          terminalRef.current = true
          return
        }
      }
      if (cancelled || terminalRef.current) return
      // State-aware cadence, read off LIVE refs.
      const cadenceMs =
        statusRef.current?.state === 'restarting' || errorCountRef.current > 0
          ? UPDATE_POLL_FAST_MS
          : UPDATE_POLL_SLOW_MS
      timer = setTimeout(tick, cadenceMs)
    }
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, onCompleted])

  // Reset on close so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setStatus(null)
      setNetworkErrorCount(0)
      statusRef.current = null
      errorCountRef.current = 0
      terminalRef.current = false
      completedFiredRef.current = false
    }
  }, [open])

  const state: UpdateState = status?.state ?? 'preflight'
  const step = status?.step ?? 0
  const totalSteps = status?.totalSteps ?? UPDATE_TOTAL_STEPS
  const progressPct = Math.min(100, Math.max(0, (step / totalSteps) * 100))
  const isFailed = state === 'failed' || state === 'rolled_back'
  const isCompleted = state === 'completed'
  const isReconnecting = state === 'restarting' || networkErrorCount > 0
  // `idle` arriving mid-restart means the status file was cleared
  // (manual ops, another tab, lock-stale) — neither success nor
  // failure, but the modal can't usefully continue. Show a recovery
  // CTA instead of pretending we're still working.
  //
  // The status route synthesizes idle for two cases: (a) no file at
  // all, (b) status file is a terminal state > 24 h old. Case (b)
  // means "old completion" not "current orphan", and an operator
  // shouldn't have been able to open the modal against it anyway.
  // We gate `isOrphaned` on a RECENT updatedAt (< 60 s) so case (b)
  // doesn't trip the "Update interrupted" copy.
  const isOrphaned =
    state === 'idle' &&
    status !== null &&
    Date.now() - Date.parse(status.updatedAt) < 60_000

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Update progress"
          className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/40 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <motion.div
            className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50 shadow-[0_40px_80px_-20px_rgba(15,15,15,0.45)]"
            initial={{ scale: 0.92, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.96, y: 8, opacity: 0 }}
            // Spring entrance — feels like the modal "settles" into
            // place rather than snapping.
            transition={{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7 }}
          >
        {/* Ambient copper glow */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-copper-300/30 blur-3xl"
        />

        <header className="relative px-8 pt-8 pb-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            CaveCMS
          </p>
          <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black">
            {isCompleted
              ? "You're on the new version"
              : isFailed
                ? state === 'rolled_back'
                  ? 'We put your site back the way it was'
                  : 'Something went wrong'
                : isOrphaned
                  ? 'Update interrupted'
                  : isReconnecting
                    ? 'Almost there — restarting…'
                    : 'Updating your site'}
          </h2>
          <p className="mt-2 text-sm text-warm-stone">
            {isCompleted
              ? 'Your site is now running the latest CaveCMS.'
              : isFailed && state === 'rolled_back'
                ? 'Your site is still online and running the previous version.'
                : isFailed
                  ? 'Your site is still online on the previous version. Nothing was lost.'
                  : isOrphaned
                    ? "We can't tell what happened. Refresh the page and check if your site is running normally."
                    : 'This usually takes about a minute. Keep this window open.'}
          </p>
        </header>

        {/* Progress bar */}
        <div className="relative px-8">
          <div className="h-2 w-full overflow-hidden rounded-full bg-warm-stone/15">
            <div
              className={`h-full transition-all duration-500 ease-out ${
                isFailed ? 'bg-red-500' : isCompleted ? 'bg-emerald-500' : 'bg-copper-500'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Steps */}
        <ol className="relative mt-6 max-h-[40vh] space-y-3 overflow-y-auto px-8 pb-2 text-sm">
          {STEP_LABELS.map((label, i) => {
            const stepIndex = i + 1
            const isDone = step > stepIndex || isCompleted
            const isCurrent = step === stepIndex && !isFailed && !isCompleted
            const isStepFailed = isFailed && step === stepIndex
            return (
              <li
                key={label}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-all ${
                  isCurrent
                    ? 'border-copper-400 bg-copper-50/50'
                    : isStepFailed
                      ? 'border-red-300 bg-red-50/40'
                      : isDone
                        ? 'border-emerald-200 bg-emerald-50/40'
                        : 'border-warm-stone/20 bg-cream-50/40'
                }`}
              >
                <span aria-hidden="true" className="mt-0.5 shrink-0">
                  {isDone && !isStepFailed ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                  ) : isCurrent ? (
                    <Loader2 className="h-5 w-5 animate-spin text-copper-600" />
                  ) : isStepFailed ? (
                    <XCircle className="h-5 w-5 text-red-600" />
                  ) : (
                    <span className="ml-1 inline-block h-3 w-3 rounded-full border border-warm-stone/40" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm font-medium ${
                      isCurrent || isDone || isStepFailed
                        ? 'text-near-black'
                        : 'text-warm-stone'
                    }`}
                  >
                    {label}
                  </p>
                  {isCurrent && status?.stepLabel && (
                    <p className="mt-0.5 text-xs text-warm-stone">{status.stepLabel}</p>
                  )}
                  {isStepFailed && status?.error && (
                    <p className="mt-1 text-xs text-red-700">{status.error}</p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>

        {isReconnecting && !isFailed && !isCompleted && !isOrphaned && (
          <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-copper-200 bg-copper-50/60 px-4 py-3 text-xs text-near-black">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-copper-600" />
            <p>
              Reconnecting… this usually takes 10–30 seconds. Keep this window
              open.
            </p>
          </div>
        )}

        {isFailed && state === 'rolled_back' && (
          <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-near-black">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <p>
              Your site is still online and running fine. If this keeps
              happening, contact support.
            </p>
          </div>
        )}

        <footer className="relative flex flex-wrap items-center justify-end gap-3 px-8 pt-6 pb-8">
          {isCompleted ? (
            <Button
              type="button"
              onClick={() => {
                window.location.reload()
              }}
            >
              <RefreshCcw className="h-4 w-4" />
              Reload now
            </Button>
          ) : isFailed || isOrphaned ? (
            <Button
              type="button"
              variant={isOrphaned ? 'primary' : 'ghost'}
              onClick={() => {
                if (isOrphaned) {
                  window.location.reload()
                } else {
                  onClose()
                }
              }}
            >
              {isOrphaned ? (
                <>
                  <RefreshCcw className="h-4 w-4" />
                  Refresh
                </>
              ) : (
                'Close'
              )}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              // Operator can close at any time during an active update.
              // The orchestrator runs detached from the browser, the
              // status file persists, and the modal will reopen with
              // the live state the next time they visit the dashboard.
              // We do NOT disable Close — gating it backed operators
              // into a corner during long restarts.
              title="Close — the update keeps running in the background."
            >
              Close
            </Button>
          )}
        </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
