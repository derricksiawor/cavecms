'use client'
import { useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'

export function LogoutButton() {
  const [busy, setBusy] = useState(false)
  async function onClick() {
    if (busy) return
    setBusy(true)
    try {
      // CSRF-wrapped — the logout route enforces requireCsrf. A failed
      // logout (network error, 401, 403) still must clear the local
      // session perception, so we redirect to '/' unconditionally. The
      // server-side cookie clear is best-effort.
      await csrfFetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
    } finally {
      window.location.href = '/'
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="text-[11px] font-semibold uppercase tracking-[0.24em] text-warm-stone transition-colors hover:text-near-black disabled:opacity-50"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
