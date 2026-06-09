'use client'
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, XCircle, RefreshCcw, AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/Button'
import {
  BACKUP_POLL_FAST_MS,
  BACKUP_POLL_SLOW_MS,
  BACKUP_RECONNECT_MAX_RETRIES,
  BACKUP_STATUS_FETCH_TIMEOUT_MS,
} from '@/lib/backups/constants'

// Generic live-progress modal for the backup + restore flows. Polls
// /api/admin/backups/status?kind=<kind> off REFS (same stale-closure-safe
// cadence pattern as UpdatesProgressModal) and renders the luxury progress UI.
// Backup + restore differ only in copy + step labels + which states count as
// success/failure — passed in via props.

export interface PhaseStatus {
  state: string
  step: number
  totalSteps: number
  startedAt: string
  updatedAt: string
  stepLabel?: string
  error?: string
  log?: string
  archiveLabel?: string
}

export interface PhaseCopy {
  ariaLabel: string
  inProgressEyebrow: (step: number, total: number) => string
  inProgressTitle: string
  inProgressSubtitle: string
  successEyebrow: string
  successTitle: string
  successSubtitle: string
  restartRequiredEyebrow: string
  restartRequiredTitle: string
  restartRequiredSubtitle: string
  failedTitle: string
  failedSubtitle: string
  rolledBackTitle: string
  rolledBackSubtitle: string
  /** Primary button on the success (non-restart) terminal. */
  successButtonLabel: string
  /** 'reload' reloads the page; 'close' just closes. */
  successButtonAction: 'reload' | 'close'
}

export function PhaseProgressModal({
  open,
  onClose,
  onCompleted,
  kind,
  stepLabels,
  copy,
  successStates,
  failStates,
  awaitFresh,
}: {
  open: boolean
  onClose: () => void
  onCompleted?: () => void
  kind: 'backup' | 'restore'
  stepLabels: readonly string[]
  copy: PhaseCopy
  successStates: ReadonlySet<string>
  failStates: ReadonlySet<string>
  /**
   * Set when the modal opens OPTIMISTICALLY (before the create route has
   * confirmed the run started). The status file still holds the PREVIOUS
   * run's terminal snapshot at that moment — without this flag the first
   * poll would adopt it and flash "complete"/"failed" for a run that hasn't
   * begun. With it, polls ignore an UNCHANGED terminal snapshot and render
   * the step-0 "getting ready" state until a fresh status appears (the
   * create route seeds one before returning, so this window is sub-second).
   */
  awaitFresh?: boolean
}) {
  const [status, setStatus] = useState<PhaseStatus | null>(null)
  const [networkErrorCount, setNetworkErrorCount] = useState(0)
  const statusRef = useRef<PhaseStatus | null>(null)
  const errorCountRef = useRef(0)
  const terminalRef = useRef(false)
  const completedFiredRef = useRef(false)
  const staleBaselineRef = useRef<string | null>(null)
  const sawFreshRef = useRef(false)

  const TERMINAL = new Set<string>([...successStates, ...failStates, 'idle'])

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
    terminalRef.current = false
    completedFiredRef.current = false
    staleBaselineRef.current = null
    sawFreshRef.current = false

    async function tick() {
      if (cancelled || terminalRef.current) return
      try {
        const r = await fetch(`/api/admin/backups/status?kind=${kind}`, {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(BACKUP_STATUS_FETCH_TIMEOUT_MS),
        })
        if (cancelled) return
        if (!r.ok) throw new Error(`status_${r.status}`)
        const j = (await r.json()) as PhaseStatus
        if (awaitFresh && !sawFreshRef.current) {
          // Identity of a status snapshot — string compare, no clock math
          // (server timestamps vs client clock can skew).
          const key = `${j.state}|${j.startedAt}|${j.updatedAt}`
          if (staleBaselineRef.current === null) staleBaselineRef.current = key
          if (TERMINAL.has(j.state) && key === staleBaselineRef.current) {
            // Still the previous run's terminal snapshot — keep showing the
            // step-0 "getting ready" state and poll fast for the seed write.
            timer = setTimeout(tick, BACKUP_POLL_FAST_MS)
            return
          }
          sawFreshRef.current = true
        }
        setStatus(j)
        statusRef.current = j
        if (errorCountRef.current !== 0) {
          setNetworkErrorCount(0)
          errorCountRef.current = 0
        }
        if (successStates.has(j.state) && !completedFiredRef.current) {
          completedFiredRef.current = true
          onCompleted?.()
        }
        if (TERMINAL.has(j.state)) {
          terminalRef.current = true
          return
        }
      } catch {
        if (cancelled) return
        const next = errorCountRef.current + 1
        errorCountRef.current = next
        setNetworkErrorCount(next)
        if (next >= BACKUP_RECONNECT_MAX_RETRIES) {
          const failed: PhaseStatus = {
            state: 'failed',
            step: statusRef.current?.step ?? 0,
            totalSteps: statusRef.current?.totalSteps ?? stepLabels.length,
            startedAt: statusRef.current?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            error: 'The application did not come back online.',
          }
          setStatus(failed)
          statusRef.current = failed
          terminalRef.current = true
          return
        }
      }
      if (cancelled || terminalRef.current) return
      const cadenceMs =
        statusRef.current?.state === 'restarting' || errorCountRef.current > 0
          ? BACKUP_POLL_FAST_MS
          : BACKUP_POLL_SLOW_MS
      timer = setTimeout(tick, cadenceMs)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onCompleted, kind])

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

  const state = status?.state ?? 'running'
  const step = status?.step ?? 0
  const totalSteps = status?.totalSteps ?? stepLabels.length
  const progressPct = Math.min(100, Math.max(0, (step / totalSteps) * 100))
  const isFailed = failStates.has(state) && state !== 'rolled_back'
  const isRolledBack = state === 'rolled_back'
  const isRestartRequired = state === 'restart_required'
  const isSuccess = successStates.has(state)
  const isCompletedLook = isSuccess // emerald styling
  const isReconnecting = networkErrorCount > 0
  const isOrphaned =
    state === 'idle' && status !== null && Date.now() - Date.parse(status.updatedAt) < 60_000

  const eyebrow = isRestartRequired
    ? copy.restartRequiredEyebrow
    : isSuccess
      ? copy.successEyebrow
      : isFailed
        ? copy.failedTitle
        : isRolledBack
          ? copy.rolledBackTitle
          : copy.inProgressEyebrow(Math.max(1, step), totalSteps)
  const title = isRestartRequired
    ? copy.restartRequiredTitle
    : isSuccess
      ? copy.successTitle
      : isFailed
        ? copy.failedTitle
        : isRolledBack
          ? copy.rolledBackTitle
          : copy.inProgressTitle
  const subtitle = isRestartRequired
    ? copy.restartRequiredSubtitle
    : isSuccess
      ? copy.successSubtitle
      : isFailed
        ? copy.failedSubtitle
        : isRolledBack
          ? copy.rolledBackSubtitle
          : copy.inProgressSubtitle

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={copy.ariaLabel}
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
            transition={{ type: 'spring', stiffness: 320, damping: 26, mass: 0.7 }}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-copper-300/30 blur-3xl"
            />

            <header className="relative px-8 pt-8 pb-6">
              <p
                className={`text-[10px] font-semibold uppercase tracking-[0.32em] ${
                  isCompletedLook
                    ? 'text-emerald-700'
                    : isFailed
                      ? 'text-red-700'
                      : isRolledBack || isOrphaned
                        ? 'text-amber-700'
                        : 'text-copper-600'
                }`}
              >
                {eyebrow}
              </p>
              {isCompletedLook && (
                <div className="mt-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                  <CheckCircle2 className="h-7 w-7" />
                </div>
              )}
              <h2 className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black">
                {title}
              </h2>
              <p className="mt-2 text-sm text-warm-stone">{subtitle}</p>
            </header>

            <div className="relative px-8">
              <div className="h-2 w-full overflow-hidden rounded-full bg-warm-stone/15">
                <div
                  className={`h-full transition-all duration-500 ease-out ${
                    isFailed ? 'bg-red-500' : isCompletedLook ? 'bg-emerald-500' : 'bg-copper-500'
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>

            <ol className="relative mt-6 max-h-[40vh] space-y-3 overflow-y-auto px-8 pb-2 text-sm">
              {stepLabels.map((label, i) => {
                const stepIndex = i + 1
                const isDone = step > stepIndex || isSuccess
                const isCurrent = step === stepIndex && !isFailed && !isSuccess && !isRolledBack
                const isStepFailed = (isFailed || isRolledBack) && step === stepIndex
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
                          isCurrent || isDone || isStepFailed ? 'text-near-black' : 'text-warm-stone'
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

            {/* 0024-style warnings ride in on the status `log` field. */}
            {!isFailed && status?.log && status.log.trim().length > 0 && (
              <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-near-black">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <p className="text-warm-stone">{status.log}</p>
              </div>
            )}

            {isReconnecting && !isFailed && !isSuccess && !isOrphaned && (
              <div className="relative mx-8 mt-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-xs text-near-black">
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-700" />
                <div>
                  <p className="font-medium">Lost contact with your server — retrying.</p>
                  <p className="mt-0.5 text-warm-stone">
                    Attempt {networkErrorCount} of {BACKUP_RECONNECT_MAX_RETRIES}. Usually clears within
                    10–30 seconds.
                  </p>
                </div>
              </div>
            )}

            <footer className="relative flex flex-wrap items-center justify-end gap-3 px-8 pt-6 pb-8">
              {isRestartRequired ? (
                <Button type="button" onClick={onClose}>
                  Got it
                </Button>
              ) : isSuccess ? (
                <Button
                  type="button"
                  onClick={() => {
                    if (copy.successButtonAction === 'reload') window.location.reload()
                    else onClose()
                  }}
                >
                  {copy.successButtonAction === 'reload' && <RefreshCcw className="h-4 w-4" />}
                  {copy.successButtonLabel}
                </Button>
              ) : isFailed || isRolledBack || isOrphaned ? (
                <Button type="button" variant="ghost" onClick={onClose}>
                  Close
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  title="Close — this keeps running in the background."
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
