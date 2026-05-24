'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

// Debounced auto-save. Caller supplies a stable `save()` that does
// whatever PATCH it needs (the network call, the version handshake,
// the toast on 409 — all owned by the caller). This hook only
// schedules the call: it waits `debounceMs` after each `value`
// change, then fires once. Cmd/Ctrl+S anywhere force-flushes.
//
// The hook is intentionally state-only. It does NOT compare values —
// the caller's `dirty` flag is the single source of truth for
// whether there's work to do. That keeps deep-equality concerns out
// of here and lets each editor define dirty in whatever shape fits.
//
// Failure handling
// ----------------
// `save()` returning `{ ok: false }` increments a consecutive-failure
// counter. After `MAX_CONSECUTIVE_FAILURES` we stop firing auto-save
// for this editor session — the operator must use the manual Save
// button. Otherwise a stale-version 409 (or persistent 500, or
// offline browser) would hammer the API on every keystroke. The
// caller can also call `resetFailures()` after a successful manual
// save / refresh to re-enable auto-save.
//
// Returns a status the caller can render in the StickySaveBar:
//   idle    — nothing to save
//   pending — change observed, debounce timer ticking
//   saving  — PATCH in flight
//   saved   — PATCH succeeded; lastSavedAt updated
//   error   — last attempt failed; caller usually surfaces a toast
//   paused  — too many consecutive failures, auto-save disabled

export type AutoSaveStatus =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'error'
  | 'paused'

const MAX_CONSECUTIVE_FAILURES = 3

export function useAutoSave({
  dirty,
  enabled = true,
  debounceMs = 900,
  save,
}: {
  dirty: boolean
  enabled?: boolean
  debounceMs?: number
  save: () => Promise<{ ok: boolean }>
}): {
  status: AutoSaveStatus
  lastSavedAt: number | null
  flush: () => void
  resetFailures: () => void
} {
  const [status, setStatus] = useState<AutoSaveStatus>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef(false)
  const pendingRef = useRef(false)
  const failuresRef = useRef(0)
  // Latest-state refs so the dirty-watcher effect can read fresh
  // values without taking them as dependencies (deps would re-arm
  // the timer on every status flip, defeating the debounce).
  const statusRef = useRef<AutoSaveStatus>('idle')
  const lastSavedRef = useRef<number | null>(null)
  const dirtyRef = useRef(dirty)
  statusRef.current = status
  lastSavedRef.current = lastSavedAt
  dirtyRef.current = dirty
  const saveRef = useRef(save)
  saveRef.current = save

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const run = useCallback(async () => {
    if (inFlightRef.current) {
      pendingRef.current = true
      return
    }
    inFlightRef.current = true
    setStatus('saving')
    let errored = false
    try {
      const r = await saveRef.current()
      if (r.ok) {
        failuresRef.current = 0
        setStatus('saved')
        setLastSavedAt(Date.now())
      } else {
        errored = true
        failuresRef.current += 1
        setStatus(
          failuresRef.current >= MAX_CONSECUTIVE_FAILURES ? 'paused' : 'error',
        )
      }
    } catch {
      errored = true
      failuresRef.current += 1
      setStatus(
        failuresRef.current >= MAX_CONSECUTIVE_FAILURES ? 'paused' : 'error',
      )
    } finally {
      inFlightRef.current = false
      if (
        pendingRef.current &&
        failuresRef.current < MAX_CONSECUTIVE_FAILURES
      ) {
        pendingRef.current = false
        // Defer the coalesced retry by `debounceMs` after an error so
        // a transient failure doesn't immediately re-fire and a
        // permanent failure doesn't hammer the API. On success, fire
        // straight away — the queued change is fresh.
        if (errored) {
          clearTimer()
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            void run()
          }, debounceMs)
        } else {
          void run()
        }
      }
    }
  }, [debounceMs])

  // Schedule on dirty.
  useEffect(() => {
    if (!enabled) return
    if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) return
    if (!dirty) {
      clearTimer()
      if (statusRef.current === 'pending') {
        setStatus(lastSavedRef.current != null ? 'saved' : 'idle')
      }
      return
    }
    setStatus('pending')
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void run()
    }, debounceMs)
    return clearTimer
  }, [dirty, enabled, debounceMs, run])

  // Cmd/Ctrl+S anywhere force-flushes — but only if there's
  // something dirty. Bound once per editor mount and reads `dirty`
  // from a ref so the listener doesn't re-bind on every status flip.
  // `e.code === 'KeyS'` checks the PHYSICAL key, so non-US keyboard
  // layouts (Dvorak, Colemak, AZERTY) still trigger.
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code !== 'KeyS' && e.key.toLowerCase() !== 's') return
      if (!dirtyRef.current) return
      if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) return
      e.preventDefault()
      clearTimer()
      void run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, run])

  const flush = useCallback(() => {
    clearTimer()
    if (dirtyRef.current && failuresRef.current < MAX_CONSECUTIVE_FAILURES) {
      void run()
    }
  }, [run])

  const resetFailures = useCallback(() => {
    failuresRef.current = 0
    if (statusRef.current === 'paused') {
      setStatus(lastSavedRef.current != null ? 'saved' : 'idle')
    }
  }, [])

  return { status, lastSavedAt, flush, resetFailures }
}

// A tiny human-readable relative-time helper for the "Saved · 3s ago"
// pill. Falls back gracefully if Intl.RelativeTimeFormat is missing.
export function formatRelativeSince(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}
