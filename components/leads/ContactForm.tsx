'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { HONEYPOT_FIELD } from '@/lib/leads/honeypot'
import { useRecaptchaForLead } from '@/lib/security/recaptchaClient'

// Draft-preservation key for the auto-reload-on-expired flow. Stored
// in sessionStorage so it survives the reload but doesn't persist
// across browser sessions (a visitor who closes the tab loses the
// draft, which matches the "session" semantics). Field excludes the
// CSRF nonce + honeypot — the reloaded page mints its own fresh
// nonce; the honeypot starts empty.
const DRAFT_KEY = 'lx-contact-form-draft'

// Reload-attempt counter. The auto-reload-on-expired flow exists to
// recover the visitor's session when the preCSRF nonce ages out. If
// the SECOND submit (after reload) also returns session_expired —
// indicating server clock skew, misconfigured TTL, or persistent
// backend issue — we MUST abort the loop to avoid trapping the
// visitor in a reload cycle. After 1 successful auto-reload, the
// counter blocks further attempts and the visitor sees a static
// "please refresh manually" panel.
const RELOAD_COUNT_KEY = 'lx-contact-form-reload-count'
const MAX_AUTO_RELOADS = 1
const RELOAD_COUNTER_TTL_MS = 60_000

type EnquiryType = 'enquiry' | 'tour' | 'brochure'

const PROJECTS: readonly string[] = []

type ReloadCounter = { count: number; ts: number }
function readReloadCounter(): number {
  if (typeof sessionStorage === 'undefined') return 0
  try {
    const raw = sessionStorage.getItem(RELOAD_COUNT_KEY)
    if (!raw) return 0
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ReloadCounter).count === 'number' &&
      typeof (parsed as ReloadCounter).ts === 'number'
    ) {
      const { count, ts } = parsed as ReloadCounter
      if (Date.now() - ts < RELOAD_COUNTER_TTL_MS) return count
    }
  } catch { /* malformed — treat as 0 */ }
  return 0
}
function writeReloadCounter(count: number): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(RELOAD_COUNT_KEY, JSON.stringify({ count, ts: Date.now() }))
  } catch { /* ignore — counter is best-effort */ }
}
function clearReloadCounter(): void {
  if (typeof sessionStorage === 'undefined') return
  try { sessionStorage.removeItem(RELOAD_COUNT_KEY) } catch { /* ignore */ }
}

function canPersistDraft(): boolean {
  if (typeof sessionStorage === 'undefined') return false
  try {
    sessionStorage.setItem('__lx_probe__', '1')
    sessionStorage.removeItem('__lx_probe__')
    return true
  } catch { return false }
}

const FETCH_TIMEOUT_MS = 30_000

// Per ~/.claude/CLAUDE.md "No borders/border lines": inputs are
// translucent fills that bump to a brighter fill on focus + add a
// champagne/copper ring for a11y focus indication.
//
// Surface-aware: the dark-theme tokens (ivory/champagne) read correctly
// against obsidian/near-black sections; the light-theme tokens
// (obsidian/copper-700) read correctly against ivory/cream/champagne
// sections. The wrapper renderer (`components/blocks/ContactForm/render`)
// passes `surface` from the ancestor section's meta via
// `isSectionSurfaceDark` — no template needs to declare a theme.
const INPUT_DARK =
  'w-full font-sans text-base font-medium text-ivory bg-ivory/8 rounded-xl px-4 py-3.5 transition-all duration-base ease-luxury placeholder:text-ivory/40 focus:outline-none focus:bg-ivory/15 focus:ring-2 focus:ring-champagne focus:ring-offset-0'
const INPUT_LIGHT =
  'w-full font-sans text-base font-medium text-obsidian bg-obsidian/8 rounded-xl px-4 py-3.5 transition-all duration-base ease-luxury placeholder:text-obsidian/40 focus:outline-none focus:bg-obsidian/12 focus:ring-2 focus:ring-copper-500 focus:ring-offset-0'

const LABEL_DARK =
  'font-sans text-xs font-semibold uppercase tracking-eyebrow text-champagne'
const LABEL_LIGHT =
  'font-sans text-xs font-semibold uppercase tracking-eyebrow text-copper-700'

// Native date/time pickers need an explicit color-scheme so their
// browser chrome (calendar grid + clock face) matches the form theme.
const DATE_TIME_EXTRA_DARK = '[color-scheme:dark]'
const DATE_TIME_EXTRA_LIGHT = '[color-scheme:light]'

export interface ContactFormProps {
  csrf: string
  submitLabel?: string
  /** Optional CMS block id this form was rendered FROM. When set, the
   *  lead submit handler looks up the block's `crmDestinations` and
   *  dispatches to those per-instance destinations instead of (or in
   *  addition to) the site-wide integrations_*.formSourceMap.contact
   *  default. Empty/0 → site-wide default only. */
  blockId?: number
  /** Resolved by the wrapper from the parent section's `bg` token
   *  (see ContactForm/render.tsx). Dark surfaces use ivory/champagne
   *  tokens; light surfaces use obsidian/copper. Default 'dark'
   *  preserves the historic behaviour for any direct caller that
   *  hasn't been migrated. */
  surface?: 'dark' | 'light'
}

export function ContactForm({
  csrf,
  submitLabel = 'Send message',
  blockId,
  surface = 'dark',
}: ContactFormProps) {
  const INPUT_BASE = surface === 'light' ? INPUT_LIGHT : INPUT_DARK
  const LABEL_TEXT = surface === 'light' ? LABEL_LIGHT : LABEL_DARK
  const DATE_TIME_EXTRA = surface === 'light' ? DATE_TIME_EXTRA_LIGHT : DATE_TIME_EXTRA_DARK
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'idle' | 'ok' | 'expired' | 'error'>('idle')
  const [reloadAborted, setReloadAborted] = useState(false)
  const [draftSaveFailed, setDraftSaveFailed] = useState(false)
  const [enquiryType, setEnquiryType] = useState<EnquiryType>('enquiry')

  // Minimum selectable date = today (prevent past tour requests).
  // Computed once at mount on the client; lazy initializer avoids
  // SSR/hydration mismatch since this is a 'use client' component.
  const [todayStr] = useState(() => new Date().toISOString().slice(0, 10))

  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const recaptcha = useRecaptchaForLead()

  // Restore draft saved before an auto-reload. The sessionStorage
  // entry is one-shot — read + remove so a navigate-away-and-back
  // doesn't keep prepopulating fields. enquiry_type is read from the
  // parsed object (not from the DOM) to synchronise React state
  // BEFORE the DOM values are applied, preventing a race where the
  // controlled select overwrites the restored DOM value on the next
  // render.
  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return
    let draft: string | null = null
    try {
      draft = sessionStorage.getItem(DRAFT_KEY)
      if (draft) sessionStorage.removeItem(DRAFT_KEY)
    } catch { return }
    if (!draft || !formRef.current) return
    try {
      const obj = JSON.parse(draft) as Record<string, string>
      // Sync enquiry type state first so conditional fields mount
      // before we try to set their DOM values.
      const draftEnquiry = obj['enquiry_type']
      if (draftEnquiry === 'tour' || draftEnquiry === 'brochure' || draftEnquiry === 'enquiry') {
        setEnquiryType(draftEnquiry)
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'enquiry_type') continue // handled via state above
        const el = formRef.current.elements.namedItem(k) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | null
        if (el && 'value' in el && typeof v === 'string') el.value = v
      }
    } catch { /* bad payload — ignore */ }
  }, [])

  // Auto-reload after state='expired'. Reload-budget guard prevents
  // an infinite reload loop caused by clock skew or misconfigured TTL.
  //
  // Resilience fix: keep the Submit button busy during the 2-second
  // window between expired-state and reload. Without this, the prior
  // submit's finally block cleared `busy=false`, the operator could
  // click Submit again, a second POST fires mid-flight, then the
  // reload cuts it — operator's data lost without feedback.
  useEffect(() => {
    if (state !== 'expired') return
    setBusy(true)
    if (!canPersistDraft()) setDraftSaveFailed(true)
    const reloadCount = readReloadCounter()
    if (reloadCount >= MAX_AUTO_RELOADS) {
      setReloadAborted(true)
      return
    }
    const id = window.setTimeout(() => {
      writeReloadCounter(reloadCount + 1)
      if (formRef.current) {
        try {
          const fd = new FormData(formRef.current)
          const obj: Record<string, string> = {}
          for (const [k, v] of fd.entries()) {
            if (k === 'csrf' || k === HONEYPOT_FIELD) continue
            if (typeof v === 'string') obj[k] = v
          }
          sessionStorage.setItem(DRAFT_KEY, JSON.stringify(obj))
        } catch { /* quota — still reload */ }
      }
      window.location.reload()
    }, 2000)
    return () => window.clearTimeout(id)
  }, [state])

  useEffect(() => {
    if (state !== 'ok') return
    clearReloadCounter()
  }, [state])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setState('idle')
    try {
      const fd = new FormData(e.currentTarget)
      const rcToken = await recaptcha.getToken('lead')
      if (rcToken) fd.set('recaptcha', rcToken)
      const res = await fetch('/api/leads/contact', {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) { setState('error'); return }
      const j = (await res.json()) as { hint?: string }
      if (j.hint === 'session_expired') { setState('expired'); return }
      router.push(`/thank-you-${enquiryType}`)
    } catch {
      setState('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-6">
      <input type="hidden" name="csrf" value={csrf} />
      {blockId ? <input type="hidden" name="block_id" value={String(blockId)} /> : null}
      {/* Honeypot — off-screen, out of tab order, hidden from
         assistive tech. Real visitors never touch it; bots
         filling-all-fields trigger the silent drop. */}
      <input
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] h-0 w-0 opacity-0"
      />

      {/* Row 1: Name + Email */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <label className="block">
          <span className={LABEL_TEXT}>Name</span>
          <input
            name="name"
            required
            maxLength={180}
            autoComplete="name"
            className={clsx(INPUT_BASE, 'mt-3')}
          />
        </label>
        <label className="block">
          <span className={LABEL_TEXT}>Email</span>
          <input
            name="email"
            type="email"
            required
            maxLength={180}
            autoComplete="email"
            inputMode="email"
            className={clsx(INPUT_BASE, 'mt-3')}
          />
        </label>
      </div>

      {/* Row 2: Phone + Enquiry Type */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <label className="block">
          <span className={LABEL_TEXT}>Phone</span>
          <input
            name="phone"
            type="tel"
            required
            maxLength={40}
            autoComplete="tel"
            inputMode="tel"
            className={clsx(INPUT_BASE, 'mt-3')}
          />
        </label>
        <label className="block">
          <span className={LABEL_TEXT}>I would like to</span>
          <div className="relative mt-3">
            <select
              name="enquiry_type"
              value={enquiryType}
              onChange={(e) => setEnquiryType(e.target.value as EnquiryType)}
              className={clsx(INPUT_BASE, 'appearance-none cursor-pointer pr-10')}
            >
              <option value="enquiry">Enquire</option>
              <option value="tour">Schedule a Tour</option>
              <option value="brochure">Download Brochure</option>
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-champagne"
            />
          </div>
        </label>
      </div>

      {/* Row 3a: Tour — date + time (shown for Schedule a Tour) */}
      <div className={clsx('grid grid-cols-1 md:grid-cols-2 gap-6', enquiryType !== 'tour' && 'hidden')}>
        <label className="block">
          <span className={LABEL_TEXT}>Preferred date</span>
          <input
            name="tour_date"
            type="date"
            min={todayStr}
            className={clsx(INPUT_BASE, 'mt-3', DATE_TIME_EXTRA)}
          />
        </label>
        <label className="block">
          <span className={LABEL_TEXT}>Preferred time</span>
          <input
            name="tour_time"
            type="time"
            className={clsx(INPUT_BASE, 'mt-3', DATE_TIME_EXTRA)}
          />
        </label>
      </div>

      {/* Row 3b: Brochure — project dropdown (shown for Download Brochure) */}
      <div className={enquiryType !== 'brochure' ? 'hidden' : undefined}>
        <label className="block">
          <span className={LABEL_TEXT}>Select a project</span>
          <div className="relative mt-3">
            <select
              name="brochure_project"
              required={enquiryType === 'brochure'}
              defaultValue=""
              className={clsx(INPUT_BASE, 'appearance-none cursor-pointer pr-10')}
            >
              <option value="" disabled>Choose a project…</option>
              {PROJECTS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <ChevronDown
              size={16}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-champagne"
            />
          </div>
        </label>
      </div>

      {/* Row 3c: Message (shown for Enquiry) */}
      <div className={enquiryType !== 'enquiry' ? 'hidden' : undefined}>
        <label className="block">
          <span className={LABEL_TEXT}>Message</span>
          <textarea
            name="message"
            required={enquiryType === 'enquiry'}
            maxLength={4000}
            rows={5}
            className={clsx(INPUT_BASE, 'mt-3 resize-y min-h-[140px]')}
          />
        </label>
      </div>

      {/* v2 checkbox widget; renders nothing for v3 or when disabled */}
      <recaptcha.Widget />

      <button
        type="submit"
        disabled={busy || reloadAborted}
        className="inline-flex items-center justify-center w-fit min-h-[44px] rounded-full bg-champagne text-obsidian px-10 py-4 font-sans text-base font-semibold tracking-tight shadow-lg shadow-champagne/30 lx-pulse-champagne transition-all duration-base ease-luxury hover:bg-antique-gold hover:text-ivory hover:shadow-antique-gold/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:animate-none"
      >
        {busy ? 'Sending…' : submitLabel}
      </button>

      {state === 'expired' && !reloadAborted && (
        <p className="font-sans text-sm font-medium text-champagne" role="status">
          {draftSaveFailed
            ? `Your session has expired. Refreshing the page — please copy your message first, in case it isn't preserved.`
            : 'Your session has expired. Refreshing the page now…'}
        </p>
      )}
      {state === 'expired' && reloadAborted && (
        <p className="font-sans text-sm font-medium text-champagne" role="status">
          We tried to recover your session automatically but it expired
          again. Please refresh the page manually and re-submit, or reach
          us via the channels above.
        </p>
      )}
      {state === 'error' && (
        <p className="font-sans text-sm font-medium text-champagne">
          Couldn&apos;t send right now. Please try again in a moment.
        </p>
      )}
    </form>
  )
}
