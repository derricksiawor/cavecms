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
  'Switching to the new version',
  'Verifying the new version',
]

const TERMINAL: ReadonlySet<UpdateState> = new Set<UpdateState>([
  'idle',
  'completed',
  'restart_required',
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
  // `restart_required` (laptop/dev install) is a SUCCESS — the new version is
  // on disk, it just needs a manual process restart. Fold it into isCompleted
  // so all the success styling (emerald palette, check icon, steps-done, no
  // slow/reconnect warnings) applies; isRestartRequired then overrides only
  // the copy + footer to swap the misleading "Reload" button for restart
  // guidance.
  const isRestartRequired = state === 'restart_required'
  const isCompleted = state === 'completed' || isRestartRequired
  // Split the "restart in progress" phase (server is reachable, just
  // mid-handover via pm2 reload) from "actually lost contact with the
  // server" (fetch failing). The old combined flag rendered
  // "Reconnecting…" any time state=restarting — which was a lie
  // because pm2 reload is graceful and the existing worker keeps
  // serving until the new one is healthy.
  const isRestartPhase = state === 'restarting'
  const isReconnecting = networkErrorCount > 0
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

  // Hang-detection thresholds, per Agent B's UX audit. Each step has
  // an expected duration; if we sit beyond the threshold without
  // transitioning, surface a "this is taking longer than usual" note
  // so the operator doesn't read the spinner as "frozen". We never
  // auto-fail — the server-side stale-detection (15 min) is the
  // canonical timeout; this is purely cosmetic reassurance.
  const stepEnteredAt = useRef<number>(Date.now())
  const lastStepRef = useRef<number>(-1)
  if (lastStepRef.current !== step) {
    lastStepRef.current = step
    stepEnteredAt.current = Date.now()
  }
  const stepDurationMs = Date.now() - stepEnteredAt.current
  // Thresholds in seconds (soft, hard). Soft → mild amber sub-text;
  // hard → bolder amber row with "you can safely close this window".
  const STEP_THRESHOLDS: Record<number, [number, number]> = {
    1: [15, 45],
    2: [30, 90],
    3: [30, 90],
    4: [60, 150],
    5: [15, 30],
    6: [30, 90],
  }
  const [softMs, hardMs] = (
    STEP_THRESHOLDS[step] ?? [30, 90]
  ).map((s) => s * 1000) as [number, number]
  const isSoftSlow =
    !isCompleted && !isFailed && !isOrphaned && stepDurationMs > softMs
  const isHardSlow =
    !isCompleted && !isFailed && !isOrphaned && stepDurationMs > hardMs

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
          {/* Eyebrow carries the phase + state, with colour cue.
              Terminal states swap palette (emerald success, red
              failure, amber rollback/orphan); in-flight stays copper. */}
          <p
            className={`text-[10px] font-semibold uppercase tracking-[0.32em] ${
              isCompleted
                ? 'text-emerald-700'
                : state === 'failed'
                  ? 'text-red-700'
                  : state === 'rolled_back' || isOrphaned
                    ? 'text-amber-700'
                    : 'text-copper-600'
            }`}
          >
            {isRestartRequired
              ? 'Update installed'
              : isCompleted
                ? 'Update complete'
                : state === 'failed'
                  ? 'Update failed'
                  : state === 'rolled_back'
                    ? 'Rolled back safely'
                    : isOrphaned
                      ? 'Update interrupted'
                      : `Installing update · step ${Math.max(1, step)} of ${totalSteps}`}
          </p>
          {/* Hero icon on success — emerald check sits above the
              title for an unambiguous "done" signal. */}
          {isCompleted && (
            <div className="mt-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-7 w-7">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
          <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black">
            {isRestartRequired
              ? 'Restart to finish'
              : isCompleted
                ? 'Update successful'
                : state === 'failed'
                  ? 'Update failed'
                  : state === 'rolled_back'
                    ? 'Update reverted — your site is safe'
                    : isOrphaned
                      ? 'Update interrupted'
                      : 'Installing your update'}
          </h2>
          <p className="mt-2 text-sm text-warm-stone">
            {isRestartRequired
              ? 'The new version is installed on disk. Your site runs as a foreground process, so it can’t restart itself — stop the running CaveCMS process and start it again to load the new version.'
              : isCompleted
              ? 'CaveCMS is now on the latest version. Reload this page to see the changes.'
              : state === 'failed'
                ? 'Your site is still live on the previous version. Nothing was changed.'
                : state === 'rolled_back'
                  ? "The new version didn't pass health checks, so we restored your previous version automatically. Your site is live and unchanged."
                  : isOrphaned
                    ? "The installer cleared its status before finishing. Reload to see your site's current state."
                    : isRestartPhase
                      ? 'Switching to the new version. Your site may flicker briefly while the new processes start.'
                      : 'About a minute. Your site stays live on the current version until the new one is verified.'}
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
                  {/* Soft-slow indicator: the current step has been
                      running longer than its expected duration but not
                      yet long enough to warrant a recovery panel.
                      Subtle amber to flag "longer than usual" without
                      alarming the operator. */}
                  {isCurrent && isSoftSlow && !isHardSlow && (
                    <p className="mt-1 text-xs text-amber-700">
                      This is taking longer than usual — that&apos;s
                      normal for larger updates.
                    </p>
                  )}
                  {isStepFailed && status?.error && (
                    <p className="mt-1 text-xs text-red-700">{status.error}</p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>

        {/* "Reconnecting" — ONLY fires when we genuinely can't reach
            /api/admin/updates/status. The previous combined flag (state
            === 'restarting' OR networkErrorCount > 0) rendered the
            banner during the normal pm2-reload window when the existing
            worker was still serving requests fine. Now it only shows
            when status polling itself is failing, and the counter
            telegraphs the retry budget. */}
        {/* Hard-slow indicator — the current step has exceeded 2-3×
            its expected duration. Surface a heavier amber row that
            tells the operator they can safely close the window without
            affecting the update. The orchestrator runs detached; status
            persists; the modal re-opens with live state next visit. */}
        {isHardSlow && !isReconnecting && (
          <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-near-black">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <div>
              <p className="font-medium">
                Still working &mdash; this is unusual, but we&apos;re
                still waiting.
              </p>
              <p className="mt-0.5 text-warm-stone">
                Your site is still live on the previous version. You can
                safely close this window; the update keeps running in
                the background and we&apos;ll record the outcome in the
                audit log.
              </p>
            </div>
          </div>
        )}

        {isReconnecting && !isFailed && !isCompleted && !isOrphaned && (
          <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-near-black">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-700" />
            <div>
              <p className="font-medium">Lost contact with your server — retrying.</p>
              <p className="mt-0.5 text-warm-stone">
                Attempt {networkErrorCount} of {UPDATE_RECONNECT_MAX_RETRIES}. Usually clears within 10–30 seconds.
              </p>
            </div>
          </div>
        )}

        {/* Failure/rollback recovery panel — gives the operator
            actionable next steps instead of a vague apology. Three
            buttons: try again (re-runs the update), open audit log
            (closes modal + scrolls to history table), close (ghost,
            tertiary). Rendered between the step list and the footer
            so it's the dominant element when in a terminal failure
            state. */}
        {(isFailed || isOrphaned) && (
          <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-near-black">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
            <div className="flex-1">
              <p className="font-medium">
                {state === 'rolled_back'
                  ? 'Your site is on the previous version and serving traffic.'
                  : isOrphaned
                    ? "Your site is still up. Reload to check what version it's running."
                    : 'Your site is still on the previous version. Nothing was changed.'}
              </p>
              <p className="mt-0.5 text-warm-stone">
                {state === 'rolled_back'
                  ? 'You can try the update again, or check the audit log for the failed step.'
                  : 'Try again, or check the audit log to see exactly which step failed.'}
              </p>
            </div>
          </div>
        )}

        <footer className="relative flex flex-wrap items-center justify-end gap-3 px-8 pt-6 pb-8">
          {isRestartRequired ? (
            // A bare-node laptop install won't be on the new version until the
            // operator restarts it, so "Reload" would just re-show the old
            // version. Close + let them restart from their terminal.
            <Button type="button" onClick={onClose}>
              Got it
            </Button>
          ) : isCompleted ? (
            <Button
              type="button"
              onClick={() => {
                window.location.reload()
              }}
            >
              <RefreshCcw className="h-4 w-4" />
              Reload to see changes
            </Button>
          ) : isFailed || isOrphaned ? (
            <>
              {/* Three-button recovery row: Try again, Open audit log,
                  Close. Try again is the primary in this terminal
                  state — operator's first impulse should be "rerun
                  it" not "give up". Open audit log scrolls to the
                  history table so they can see exactly which step
                  failed across runs. */}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  onClose()
                  // Best-effort scroll into the history table.
                  window.location.hash = ''
                  setTimeout(() => {
                    const el = document.querySelector('[data-update-history]')
                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }, 0)
                }}
              >
                View audit log
              </Button>
              <Button
                type="button"
                variant="ghost"
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
                    Reload page
                  </>
                ) : (
                  'Close'
                )}
              </Button>
            </>
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
