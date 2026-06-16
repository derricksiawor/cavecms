'use client'

import { useEffect, useState } from 'react'
import { KeyRound, Eye, EyeOff } from 'lucide-react'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'

const MIN_LEN = 12

// Admin-sets-a-user's-password modal. Stacked, centered, flush — new
// password + confirm with an eye toggle and a 12-char floor; the Save
// button stays disabled until the form is valid. Mirrors the house
// modal chrome (ConfirmModal) so it feels native.
export function SetPasswordModal({
  open,
  email,
  busy,
  onSubmit,
  onCancel,
}: {
  open: boolean
  email: string
  busy: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)

  // Reset fields whenever the modal opens for a (possibly different) user.
  useEffect(() => {
    if (open) {
      setPw('')
      setConfirm('')
      setShow(false)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseScrollLock()
    }
  }, [open, busy, onCancel])

  if (!open) return null

  const tooShort = pw.length < MIN_LEN
  const mismatch = confirm.length > 0 && pw !== confirm
  const valid = !tooShort && pw === confirm

  const fieldClasses =
    'h-12 w-full rounded-xl border border-warm-stone/30 bg-white px-4 pr-12 text-sm text-near-black outline-none transition-all hover:border-warm-stone/50 focus:border-copper-400 focus:ring-2 focus:ring-copper-300/40'

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!busy) onCancel()
        }}
        className="fixed inset-0 z-40 cursor-default bg-near-black/45 backdrop-blur-[3px] animate-cavecms-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="setpw-title"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50 shadow-[0_40px_80px_-30px_rgba(5,5,5,0.55)] animate-cavecms-fade-in"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (valid && !busy) onSubmit(pw)
          }}
          className="relative px-8 pt-9 pb-7 sm:px-10"
        >
          <div className="relative flex flex-col items-center text-center">
            <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-full bg-cream-50 text-copper-700 ring-1 ring-warm-stone/25">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-full bg-copper-300/30 blur-xl"
              />
              <KeyRound size={26} strokeWidth={1.8} className="relative" />
            </span>
            <p
              id="setpw-title"
              className="mt-5 font-serif text-2xl font-bold tracking-tight text-near-black"
            >
              Set a new password
            </p>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-warm-stone">
              You are setting a new password for{' '}
              <span className="font-medium text-near-black">{email}</span>. They
              will sign in with it right away. Their current sessions will end.
            </p>
          </div>

          <div className="mt-8 space-y-4 text-left">
            <div className="space-y-2">
              <label
                htmlFor="setpw-new"
                className="block text-[11px] font-semibold uppercase tracking-[0.22em] text-near-black"
              >
                New password
              </label>
              <div className="relative">
                <input
                  id="setpw-new"
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  disabled={busy}
                  className={fieldClasses}
                />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-warm-stone/70 transition-colors hover:text-copper-600"
                >
                  {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
              <p className="text-xs font-medium tracking-wide text-warm-stone/80">
                At least {MIN_LEN} characters.
              </p>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="setpw-confirm"
                className="block text-[11px] font-semibold uppercase tracking-[0.22em] text-near-black"
              >
                Confirm password
              </label>
              <input
                id="setpw-confirm"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                className={fieldClasses}
              />
              {mismatch && (
                <p className="text-xs font-medium tracking-wide text-copper-700">
                  The two passwords don’t match yet.
                </p>
              )}
            </div>
          </div>

          <div className="mt-8 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="inline-flex w-fit items-center justify-center rounded-full border border-warm-stone/30 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !valid}
              className="inline-flex w-fit items-center justify-center rounded-full bg-near-black px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_18px_40px_-22px_rgba(5,5,5,0.55)] transition-all hover:bg-copper-700 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Set password'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
