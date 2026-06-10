'use client'

import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/inline-edit/Toast'

// Self-service "Change password" card. The current-password field IS the
// security gate (verified server-side), so there's no separate step-up
// modal — one form, three fields. On success every OTHER session is signed
// out server-side; this device stays logged in via the re-issued cookie.

const MIN_LEN = 12

export function ChangePasswordForm() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < MIN_LEN
  const mismatch = confirm.length > 0 && next !== confirm
  const sameAsCurrent = next.length > 0 && next === current
  const canSubmit =
    !busy &&
    current.length > 0 &&
    next.length >= MIN_LEN &&
    next === confirm &&
    next !== current

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!canSubmit) return
    setBusy(true)
    try {
      const r = await csrfFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      if (r.ok) {
        setCurrent('')
        setNext('')
        setConfirm('')
        toast.success('Password changed. Other devices have been signed out.')
        return
      }
      const j = (await r.json().catch(() => null)) as { error?: string } | null
      // Specific, actionable copy per failure — never a generic "try again".
      if (r.status === 401 || j?.error === 'invalid_current_password') {
        setError('Your current password is incorrect.')
      } else if (j?.error === 'same_password') {
        setError('Your new password must be different from your current one.')
      } else if (j?.error === 'password_too_short') {
        setError(`Your new password must be at least ${MIN_LEN} characters.`)
      } else if (r.status === 429) {
        setError('Too many attempts. Wait a few minutes and try again.')
      } else {
        setError("We couldn't change your password. Please try again.")
      }
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-8 rounded-2xl border border-warm-stone/20 bg-cream-50 p-6 sm:p-8"
    >
      <h2 className="font-serif text-2xl font-bold tracking-tight text-near-black">
        Change your password
      </h2>
      <p className="mt-1.5 text-sm text-warm-stone">
        Enter your current password, then choose a new one (at least {MIN_LEN} characters).
        Changing it signs you out everywhere else.
      </p>

      <div className="mt-6 space-y-5">
        <div>
          <label
            htmlFor="cp-current"
            className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
          >
            Current password
          </label>
          <Input
            id="cp-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="mt-2"
          />
        </div>

        <div>
          <label
            htmlFor="cp-new"
            className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
          >
            New password
          </label>
          <Input
            id="cp-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="mt-2"
            aria-invalid={tooShort || sameAsCurrent}
          />
          {tooShort && (
            <p className="mt-1.5 text-xs text-red-700">
              At least {MIN_LEN} characters.
            </p>
          )}
          {sameAsCurrent && !tooShort && (
            <p className="mt-1.5 text-xs text-red-700">
              Must be different from your current password.
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="cp-confirm"
            className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
          >
            Confirm new password
          </label>
          <Input
            id="cp-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-2"
            aria-invalid={mismatch}
          />
          {mismatch && (
            <p className="mt-1.5 text-xs text-red-700">Passwords don&rsquo;t match.</p>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-xl border border-red-300/60 bg-red-50/50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="mt-7">
        <Button type="submit" disabled={!canSubmit}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </form>
  )
}
