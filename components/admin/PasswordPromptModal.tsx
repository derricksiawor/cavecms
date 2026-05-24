'use client'
import { useEffect, useRef, useState } from 'react'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'

// Custom password-prompt modal. Replaces window.prompt(), which:
//   - renders a plain text field (no masking on screen),
//   - doesn't trigger password managers,
//   - is read aloud by some screen readers as plain text,
//   - is explicitly banned by the project's project standards.
//
// Used by the step-up reauth flow on /admin/users and /admin/settings.
// The component takes an `open` prop and resolves either `onSubmit(pw)`
// with the typed value or `onCancel()` when the user dismisses.
export function PasswordPromptModal({
  open,
  title = 'Enter your password',
  description = 'For your security, please re-enter your password to continue.',
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: {
  open: boolean
  title?: string
  description?: string
  busy?: boolean
  error?: string | null
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const [pw, setPw] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Auto-focus the password field on open and reset state when the
  // modal closes so the next call doesn't pre-fill the field with
  // the prior attempt.
  useEffect(() => {
    if (open) {
      setPw('')
      // requestAnimationFrame so the focus happens after the modal
      // is actually painted (Safari otherwise focuses then steals).
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseScrollLock()
    }
  }, [open, onCancel])

  if (!open) return null

  function submit(e?: React.FormEvent) {
    e?.preventDefault()
    if (busy) return
    onSubmit(pw)
  }

  return (
    <>
      {/* Non-focusable backdrop. A <button> here would land as the
         first Tab stop and steal focus from the password field. */}
      <div
        aria-hidden="true"
        onClick={onCancel}
        className="fixed inset-0 z-40 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-prompt-title"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-warm-stone/20 bg-cream-50 p-8 shadow-2xl"
      >
        <p
          id="password-prompt-title"
          className="font-serif text-xl font-bold tracking-tight text-near-black"
        >
          {title}
        </p>
        <p className="mt-2 text-sm text-warm-stone">{description}</p>
        <form onSubmit={submit} className="mt-6">
          <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
            Password
            <input
              ref={inputRef}
              type="password"
              autoComplete="current-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              disabled={busy}
              className="mt-2 block w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black focus:border-copper-400 focus:outline-none"
            />
          </label>
          {error && (
            <p className="mt-3 text-xs font-medium text-copper-700">{error}</p>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || pw.length === 0}
              className="rounded-lg bg-near-black px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 transition-colors hover:bg-copper-700 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
