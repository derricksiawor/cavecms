'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'

// Shared step-up reauth hook. Used by /admin/users and /admin/settings
// — both surfaces prompt for the operator's password before every
// admin-only mutation. Extracted from the byte-for-byte duplicate
// scaffolds previously inlined in UsersTable and SettingsForm.
//
// Contract: `ensureReauth()` returns true when the server confirmed
// reauth (cookie was set), false when the user dismissed the prompt
// OR a non-recoverable error occurred. The returned `modalProps` is
// spread into <PasswordPromptModal /> in the consumer.
//
// 401 path: the modal stays open with an "Incorrect password" error
// and the operator can retype. The loop (NOT recursion) bounds the
// stack depth even under a flaky network that 401s many times.
//
// Unmount safety: a pending askPassword resolver is settled with null
// on unmount via the useEffect cleanup, so a route change while the
// modal is open won't leak a hanging Promise / retained closure.

export type ReauthFatalReason = 'rate_limited' | 'http' | null

export interface PasswordModalProps {
  open: boolean
  busy: boolean
  error: string | null
  title?: string
  onSubmit: (pw: string) => void
  onCancel: () => void
}

export interface UsePasswordReauth {
  modalProps: PasswordModalProps
  ensureReauth: () => Promise<boolean>
  fatal: ReauthFatalReason
  clearFatal: () => void
}

export function usePasswordReauth(title?: string): UsePasswordReauth {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fatal, setFatal] = useState<ReauthFatalReason>(null)
  const pendingRef = useRef<((pw: string | null) => void) | null>(null)
  // Set by onCancel while busy=true so the in-flight POST's resolution
  // path knows the operator already withdrew consent. Aborting the
  // fetch itself wouldn't help — the server may have already set the
  // reauth cookie before the response reached the client. The right
  // behavior is to honour the cookie (it's now valid for 5 min) BUT
  // not fire the mutation the operator just changed their mind on.
  const cancelledRef = useRef(false)

  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        pendingRef.current(null)
        pendingRef.current = null
      }
    }
  }, [])

  const askPassword = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      pendingRef.current = resolve
      cancelledRef.current = false
      setBusy(false)
      // Preserve the error so a 401 retry message stays visible until
      // the operator submits the next attempt — the previous version
      // cleared it on re-open, defeating the "retype" intent.
      setOpen(true)
    })
  }, [])

  const settle = useCallback((pw: string | null) => {
    const resolve = pendingRef.current
    pendingRef.current = null
    setOpen(false)
    setBusy(false)
    setError(null)
    resolve?.(pw)
  }, [])

  const ensureReauth = useCallback(async (): Promise<boolean> => {
    // Loop (not recursion) so a flaky network that 401s repeatedly
    // doesn't grow the stack. Bounded by the user clicking Cancel
    // (askPassword resolves null → return false).
    for (;;) {
      const pw = await askPassword()
      if (pw == null) return false
      setBusy(true)
      const r = await csrfFetch('/api/auth/reauth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      })
      // If the operator dismissed the modal while the network was
      // in-flight, respect their cancellation even on success — the
      // server may have set the reauth cookie, but they don't want
      // the follow-up mutation to land.
      if (cancelledRef.current) {
        cancelledRef.current = false
        setBusy(false)
        setOpen(false)
        return false
      }
      if (r.status === 401) {
        // Stay open; bump error. Loop iterates to re-ask.
        setBusy(false)
        setError('Incorrect password.')
        continue
      }
      if (r.status === 429) {
        setFatal('rate_limited')
        setOpen(false)
        setBusy(false)
        return false
      }
      if (!r.ok) {
        setFatal('http')
        setOpen(false)
        setBusy(false)
        return false
      }
      // Success — close and return.
      settle(pw)
      return true
    }
  }, [askPassword, settle])

  const onSubmit = useCallback((pw: string) => {
    const resolve = pendingRef.current
    pendingRef.current = null
    resolve?.(pw)
  }, [])

  // Two distinct cancel paths:
  //  - busy=false: the modal is sitting waiting for input; settle the
  //    pending askPassword Promise with null and the ensureReauth loop
  //    returns false.
  //  - busy=true: a reauth POST is in-flight (pendingRef already
  //    cleared by onSubmit). Set cancelledRef so the network resolver
  //    knows to abort the follow-up mutation.
  const onCancel = useCallback(() => {
    if (busy) {
      cancelledRef.current = true
      setOpen(false)
      return
    }
    settle(null)
  }, [busy, settle])

  const clearFatal = useCallback(() => setFatal(null), [])

  return {
    modalProps: { open, busy, error, title, onSubmit, onCancel },
    ensureReauth,
    fatal,
    clearFatal,
  }
}
