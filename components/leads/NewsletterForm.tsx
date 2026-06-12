'use client'
import { useState, type CSSProperties, type FormEvent } from 'react'
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

// Theme-aware class defaults — the dark 'obsidian' footer look, so the
// form is unchanged when rendered without an explicit footer theme. The
// SiteFooter passes the resolved FooterThemeClasses field/cta/muted so the
// input, button, and status copy track the operator's chosen footer theme
// (and the brand accent) instead of being hard-pinned to the dark palette.
const DEFAULT_FIELD_CLASS =
  'bg-ivory/5 border-ivory/20 text-ivory placeholder:text-ivory/40 focus:border-champagne'
const DEFAULT_CTA_CLASS = 'bg-champagne text-obsidian hover:bg-cream-50'
const DEFAULT_NOTICE_CLASS = 'text-ivory/70'

export function NewsletterForm({
  csrf,
  ctaLabel = 'Subscribe',
  fieldClass = DEFAULT_FIELD_CLASS,
  ctaClass = DEFAULT_CTA_CLASS,
  ctaStyle,
  noticeClass = DEFAULT_NOTICE_CLASS,
}: {
  csrf: string
  ctaLabel?: string
  /** Email <input> classes from the footer theme (bg/border/text/focus). */
  fieldClass?: string
  /** Submit button classes from the footer theme (accent fill). */
  ctaClass?: string
  /** Operator colour-override CSS vars for the Subscribe button (see
   *  ctaOverrideProps in lib/cms/headerTheme — rest/hover fill + text). */
  ctaStyle?: CSSProperties
  /** Status-copy colour from the footer theme (muted tier). */
  noticeClass?: string
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
      <p className={`mt-6 text-sm ${noticeClass}`}>
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
          className={`w-full border px-3 py-2 rounded focus:outline-none ${fieldClass}`}
        />
      </label>
      <recaptcha.Widget />
      <button
        type="submit"
        disabled={busy}
        className={`text-sm font-medium px-5 py-3 min-h-[44px] rounded transition-colors w-fit disabled:opacity-50 ${ctaClass}`}
        style={ctaStyle}
      >
        {busy ? 'Subscribing…' : ctaLabel}
      </button>
      {state === 'expired' && (
        <p className={`text-xs ${noticeClass}`}>
          Your session expired — please refresh the page and try again.
        </p>
      )}
      {state === 'error' && (
        <p className={`text-xs ${noticeClass}`}>
          Couldn&apos;t subscribe right now. Please try again in a moment.
        </p>
      )}
    </form>
  )
}
