'use client'
import { useState, type FormEvent } from 'react'
import { HONEYPOT_FIELD } from '@/lib/leads/honeypot'
import { useRecaptchaForLead } from '@/lib/security/recaptchaClient'

// Client form for the footer newsletter signup. POSTs multipart
// form-data to /api/leads/newsletter (which always replies neutral
// 200 with `{ ok: true }` or `{ hint: 'session_expired' }`) and
// surfaces three end-states:
//
//   ok      → "Thanks — check your inbox" (confirmation email path)
//   expired → "Session expired, please refresh" — 15-min preCsrf TTL
//   error   → "Couldn't subscribe right now" — network or 5xx
//
// Mirrors the ContactForm pattern intentionally so a future
// pattern-change (e.g. a global submit-state primitive) refactors
// both call sites uniformly.
//
// Server-side rejections (honeypot, reCAPTCHA, rate-limit) all
// surface as neutral 200 with no body discriminator — the bot
// doesn't learn which guard fired. Real subscribers get the
// confirmation email; bot submissions don't.

const FETCH_TIMEOUT_MS = 30_000

export function NewsletterForm({
  csrf,
  ctaLabel = 'Subscribe',
}: {
  csrf: string
  ctaLabel?: string
}) {
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'idle' | 'ok' | 'expired' | 'error'>(
    'idle',
  )
  const recaptcha = useRecaptchaForLead()

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setState('idle')
    try {
      const fd = new FormData(e.currentTarget)
      const rcToken = await recaptcha.getToken('lead')
      if (rcToken) fd.set('recaptcha', rcToken)
      const res = await fetch('/api/leads/newsletter', {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        setState('error')
        return
      }
      const j = (await res.json()) as { hint?: string }
      setState(j.hint === 'session_expired' ? 'expired' : 'ok')
    } catch {
      setState('error')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'ok') {
    return (
      <p className="mt-6 text-sm text-cream-50/80">
        Thanks — check your inbox to confirm your subscription.
      </p>
    )
  }

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
      <input type="hidden" name="csrf" value={csrf} />
      {/* Honeypot — off-screen, out of tab order, hidden from assistive
         tech. Real visitors never touch it; bots filling-all-fields
         trigger the silent drop. */}
      <input
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />
      <label className="block">
        <span className="sr-only">Email address</span>
        <input
          name="email"
          type="email"
          required
          maxLength={180}
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          className="w-full bg-near-black border border-cream-50/20 px-3 py-2 rounded text-cream-50 placeholder:text-cream-50/40 focus:outline-none focus:border-copper-400"
        />
      </label>
      <recaptcha.Widget />
      <button
        type="submit"
        disabled={busy}
        className="bg-copper-600 hover:bg-copper-700 text-cream-50 text-sm font-medium px-5 py-3 min-h-[44px] rounded transition-colors w-fit disabled:opacity-50"
      >
        {busy ? 'Subscribing…' : ctaLabel}
      </button>
      {state === 'expired' && (
        <p className="text-xs text-cream-50/60">
          Your session expired — please refresh the page and try again.
        </p>
      )}
      {state === 'error' && (
        <p className="text-xs text-cream-50/60">
          Couldn&apos;t subscribe right now. Please try again in a moment.
        </p>
      )}
    </form>
  )
}
