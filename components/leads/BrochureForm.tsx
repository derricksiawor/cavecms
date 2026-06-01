'use client'
import { useRef, useState, type FormEvent } from 'react'
import { HONEYPOT_FIELD } from '@/lib/leads/honeypot'
import { useRecaptchaForLead } from '@/lib/security/recaptchaClient'

const FETCH_TIMEOUT_MS = 30_000

// Client form for the project-page brochure section. POSTs to
// /api/leads/brochure with the project_id baked into a hidden
// field. On success the lead route signs a single-use download
// token and emails it; the visitor sees the same "check your
// inbox" message regardless of server-side spam outcomes.
//
// `previewMode` short-circuits the submit handler — the brochure
// page is rendered for admin QA in preview mode but has no CSRF
// nonce, so a real submit would silently succeed with neutralResponse
// and the admin would assume the flow works when no lead was inserted.
// Surfacing this explicitly prevents that confusion.

export function BrochureForm({
  csrf,
  projectId,
  projectName,
  previewMode = false,
  fieldStyle = 'bordered',
  fieldClassName,
}: {
  csrf: string
  projectId: number
  projectName: string
  previewMode?: boolean
  // Input treatment. 'bordered' (default) is the original look; 'filled'
  // swaps the visible border for a tinted fill. Lets the brochure form
  // be aligned with the inquiry form via section data.
  fieldStyle?: 'bordered' | 'filled'
  // Optional full override for the input class — a themed (e.g. dark)
  // section passes a legible field treatment. Unset → light default.
  fieldClassName?: string
}) {
  // Shared input classes — mirrors InquiryForm so the two can match.
  const fieldClass =
    fieldClassName ??
    (fieldStyle === 'filled'
      ? 'mt-1 w-full rounded-lg border border-warm-stone/20 bg-warm-stone/15 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper-500'
      : 'mt-1 w-full border border-warm-stone/30 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-copper-500')
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'idle' | 'ok' | 'expired' | 'error'>(
    'idle',
  )
  // Sync ref guard against double-click. setBusy(true) is async; if the
  // user double-clicks Submit, the second native event fires before the
  // disabled-attribute re-renders. The ref check is synchronous and
  // closes that window. Without this guard the server has no
  // (email, project_id) dedup so two leads land.
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
      const res = await fetch('/api/leads/brochure', {
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

  // Preview banner short-circuit — render a static notice instead of
  // the form so admin QA sees the visual placement without an inert
  // form leaking false-success states.
  if (previewMode) {
    return (
      <div className="border border-copper-200 bg-cream-100 rounded p-6 text-center max-w-md mx-auto">
        <p className="font-medium text-near-black">Preview mode</p>
        <p className="text-sm text-warm-stone mt-1">
          The brochure form is rendered for layout but does not submit while
          a preview token is active.
        </p>
      </div>
    )
  }

  if (state === 'ok') {
    return (
      <div className="border border-copper-200 bg-copper-50 rounded p-6 text-center">
        <p className="font-medium">
          Check your inbox for the {projectName} brochure.
        </p>
        <p className="text-sm text-warm-stone mt-1">
          The download link works once and expires in 7 days.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-md mx-auto text-left">
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
      <label className="block">
        <span className="text-sm font-medium">Name</span>
        <input
          name="name"
          required
          maxLength={180}
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
          className={fieldClass}
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Phone (optional)</span>
        <input
          name="phone"
          maxLength={40}
          className={fieldClass}
        />
      </label>
      <recaptcha.Widget />
      <button
        type="submit"
        disabled={busy}
        className="bg-copper-700 text-cream-50 px-6 py-2 rounded-full font-medium hover:bg-copper-800 transition disabled:opacity-50 w-full"
      >
        {busy ? 'Sending…' : `Email me the ${projectName} brochure`}
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
