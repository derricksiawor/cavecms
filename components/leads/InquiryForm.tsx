'use client'
import { useRef, useState, type FormEvent } from 'react'
import { HONEYPOT_FIELD } from '@/lib/leads/honeypot'
import { useRecaptchaForLead } from '@/lib/security/recaptchaClient'

const FETCH_TIMEOUT_MS = 30_000

// Client form for the project-page inquiry section. POSTs to
// /api/leads/inquiry with the project_id baked into a hidden
// field. Same end-state pattern as ContactForm/BrochureForm:
// the visible result is "Thanks" regardless of server-side
// spam outcomes, except for explicit session_expired hint.
//
// `previewMode` short-circuits the submit handler — see
// BrochureForm for rationale.

export function InquiryForm({
  csrf,
  projectId,
  projectName,
  previewMode = false,
  fieldStyle = 'bordered',
}: {
  csrf: string
  projectId: number
  projectName: string
  previewMode?: boolean
  // Input treatment. 'bordered' (default) is the original look; 'filled'
  // swaps the visible border for a tinted fill so the inquiry form can
  // be aligned with the brochure form via section data.
  fieldStyle?: 'bordered' | 'filled'
}) {
  // Shared input/textarea classes. Bordered === original. Filled uses a
  // tinted surface with a transparent border (border kept for layout
  // stability + the focus ring).
  const fieldClass =
    fieldStyle === 'filled'
      ? 'mt-1 w-full rounded-lg border border-warm-stone/20 bg-warm-stone/15 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper-500'
      : 'mt-1 w-full border border-warm-stone/30 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper-500'
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'idle' | 'ok' | 'expired' | 'error'>(
    'idle',
  )
  // Sync ref guard against double-click — see BrochureForm.
  const busyRef = useRef(false)
  const recaptcha = useRecaptchaForLead()

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setState('idle')
    try {
      const fd = new FormData(e.currentTarget)
      const rcToken = await recaptcha.getToken('lead')
      if (rcToken) fd.set('recaptcha', rcToken)
      const res = await fetch('/api/leads/inquiry', {
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
      busyRef.current = false
    }
  }

  if (previewMode) {
    return (
      <div className="border border-copper-200 bg-cream-100 rounded p-6 text-center max-w-md mx-auto">
        <p className="font-medium text-near-black">Preview mode</p>
        <p className="text-sm text-warm-stone mt-1">
          The inquiry form is rendered for layout but does not submit while
          a preview token is active.
        </p>
      </div>
    )
  }

  if (state === 'ok') {
    return (
      <div className="border border-copper-200 bg-copper-50 rounded p-6 text-center max-w-md mx-auto">
        <p className="font-medium">
          Thanks — we&apos;ve received your inquiry about {projectName}.
        </p>
        <p className="text-sm text-warm-stone mt-1">
          A member of our sales team will reach out soon.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-xl mx-auto text-left">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="project_id" value={projectId} />
      <input
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input
            name="name"
            required
            maxLength={180}
            autoComplete="name"
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input
            name="email"
            type="email"
            required
            maxLength={180}
            autoComplete="email"
            inputMode="email"
            className={fieldClass}
          />
        </label>
      </div>
      <label className="block">
        <span className="text-sm font-medium">Phone (optional)</span>
        <input
          name="phone"
          type="tel"
          maxLength={40}
          autoComplete="tel"
          inputMode="tel"
          className={fieldClass}
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Message</span>
        <textarea
          name="message"
          required
          maxLength={4000}
          rows={4}
          className={fieldClass}
        />
      </label>
      <recaptcha.Widget />
      <button
        type="submit"
        disabled={busy}
        className="bg-copper-700 text-cream-50 px-6 py-2 rounded-full font-medium hover:bg-copper-800 transition disabled:opacity-50 w-full"
      >
        {busy ? 'Sending…' : 'Send inquiry'}
      </button>
      {state === 'expired' && (
        <p className="text-sm text-copper-700">
          Your session has expired. Please refresh the page and try again.
        </p>
      )}
      {state === 'error' && (
        <p className="text-sm text-red-700">
          Couldn&apos;t send right now. Please try again in a moment.
        </p>
      )}
    </form>
  )
}
