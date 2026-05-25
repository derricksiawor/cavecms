'use client'

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, Loader2, AlertCircle } from 'lucide-react'

// Global save-status pill. Any save flow in the editor dispatches:
//
//   window.dispatchEvent(new CustomEvent('cavecms:save-begin', {
//     detail: { id: 'unique-string' }
//   }))
//   window.dispatchEvent(new CustomEvent('cavecms:save-end', {
//     detail: { id: 'unique-string', ok: true | false }
//   }))
//
// The indicator tracks a Set of in-flight ids and renders:
//   - "Saving…" with a spinning dot while the Set is non-empty
//   - "Saved" with a check after the LAST in-flight save lands ok=true
//     (3-second display then fades to idle)
//   - "Couldn't save" with a warning if the last save landed ok=false
//     (sticky for 6 seconds — operator must see + retry)
//
// Why window events (vs a React context): zero coupling, zero provider
// wiring, callable from any file in the editor without prop drilling.
// SSR-safe because the indicator's effects gate on `typeof window`.
// Multiple in-flight saves coalesce naturally into one "Saving…" state.

type Phase = 'idle' | 'saving' | 'saved' | 'error'

const SAVED_FADE_MS = 3_000
const ERROR_FADE_MS = 6_000

export function SaveStatusIndicator() {
  const [phase, setPhase] = useState<Phase>('idle')
  // In-flight save ids → enqueue timestamp. Map (not Set) so a periodic
  // sweep can drop entries older than STUCK_SAVE_MS — an orphaned
  // `save-begin` without a matching `save-end` (handler crash mid-save,
  // browser extension intercepting the event, etc.) would otherwise pin
  // the pill at "Saving…" forever, signalling to the operator that
  // navigating away will lose work when in fact nothing's in flight.
  const inFlightRef = useRef<Map<string, number>>(new Map())
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const clearFade = () => {
      if (fadeTimerRef.current !== null) {
        clearTimeout(fadeTimerRef.current)
        fadeTimerRef.current = null
      }
    }

    const onBegin = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>
      const id = ce.detail?.id
      if (!id) return
      inFlightRef.current.set(id, Date.now())
      clearFade()
      setPhase('saving')
    }

    const onEnd = (e: Event) => {
      const ce = e as CustomEvent<{ id: string; ok: boolean }>
      const id = ce.detail?.id
      if (!id) return
      inFlightRef.current.delete(id)
      // Wait for the queue to drain — multiple concurrent saves
      // coalesce into one "Saving…" → final landing state.
      if (inFlightRef.current.size > 0) return
      clearFade()
      if (ce.detail.ok) {
        setPhase('saved')
        fadeTimerRef.current = setTimeout(() => {
          setPhase('idle')
          fadeTimerRef.current = null
        }, SAVED_FADE_MS)
      } else {
        setPhase('error')
        fadeTimerRef.current = setTimeout(() => {
          setPhase('idle')
          fadeTimerRef.current = null
        }, ERROR_FADE_MS)
      }
    }

    // Stuck-save sweep. Any inflight entry older than the budget is
    // presumed lost — drop it, log structured, and settle the pill so
    // the operator isn't told "Saving…" forever for work that quietly
    // failed.
    const STUCK_SAVE_MS = 60_000
    const SWEEP_INTERVAL_MS = 5_000
    const sweep = setInterval(() => {
      const now = Date.now()
      let dropped = false
      for (const [id, ts] of inFlightRef.current) {
        if (now - ts > STUCK_SAVE_MS) {
          inFlightRef.current.delete(id)
          dropped = true
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'save_status_stuck_swept',
              id,
              ageMs: now - ts,
            }),
          )
        }
      }
      if (dropped && inFlightRef.current.size === 0) {
        // We can't know the outcome — surface as ERROR rather than
        // SAVED so the operator sees something needs attention.
        clearFade()
        setPhase('error')
        fadeTimerRef.current = setTimeout(() => {
          setPhase('idle')
          fadeTimerRef.current = null
        }, ERROR_FADE_MS)
      }
    }, SWEEP_INTERVAL_MS)

    window.addEventListener('cavecms:save-begin', onBegin as EventListener)
    window.addEventListener('cavecms:save-end', onEnd as EventListener)
    return () => {
      clearInterval(sweep)
      window.removeEventListener('cavecms:save-begin', onBegin as EventListener)
      window.removeEventListener('cavecms:save-end', onEnd as EventListener)
      clearFade()
    }
  }, [])

  if (phase === 'idle') return null

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={clsx(
        'pointer-events-none fixed bottom-24 right-6 z-30',
        'flex items-center gap-2 rounded-full px-4 py-2 shadow-[0_18px_40px_-20px_rgba(5,5,5,0.45)]',
        'text-xs font-semibold tracking-wide',
        'animate-cavecms-toast-in',
        phase === 'saving' && 'bg-obsidian/95 text-ivory/95',
        phase === 'saved' && 'bg-obsidian/95 text-champagne',
        phase === 'error' && 'bg-red-600 text-cream-50',
      )}
    >
      {phase === 'saving' && (
        <>
          <Loader2
            aria-hidden="true"
            size={14}
            className="animate-spin text-copper-300"
          />
          <span>Saving…</span>
        </>
      )}
      {phase === 'saved' && (
        <>
          <Check
            aria-hidden="true"
            size={14}
            strokeWidth={2.6}
            className="text-champagne"
          />
          <span>Saved</span>
        </>
      )}
      {phase === 'error' && (
        <>
          <AlertCircle aria-hidden="true" size={14} strokeWidth={2.4} />
          <span>Couldn’t save — try again</span>
        </>
      )}
    </div>
  )
}

// Tiny helpers so save flows can fire begin/end with one import. The
// id should be stable per save call (e.g., `spacing:${blockId}`,
// `inline:${blockId}:${field}`) so overlapping saves on the SAME slot
// don't double-count.
export function emitSaveBegin(id: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('cavecms:save-begin', { detail: { id } }),
  )
}

export function emitSaveEnd(id: string, ok: boolean): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('cavecms:save-end', { detail: { id, ok } }),
  )
}
