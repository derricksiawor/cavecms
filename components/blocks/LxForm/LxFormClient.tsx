'use client'

import { useRef, useState } from 'react'
import clsx from 'clsx'
import { HONEYPOT_FIELD } from '@/lib/leads/honeypot'
import { useRecaptchaForLead } from '@/lib/security/recaptchaClient'
import type { BlockData } from '@/lib/cms/block-registry'

type Field = BlockData<'lx_form'>['fields'][number]

// Inputs are TONE-AWARE so text never collides with its background: on a dark
// section (onDark) the field is a translucent dark well with light text; on a
// light section it's the cream well with near-black text.
// onDark uses EXPLICIT white (not the `ivory` token — that token is
// theme-reactive and flips dark in dark-mode, which is exactly what caused the
// white-on-white field bug). White is theme-independent, so light text on the
// translucent-white well always reads.
const inputClassFor = (onDark: boolean) =>
  onDark
    ? 'w-full rounded-xl border border-white/25 bg-white/[0.06] px-4 py-3 font-sans text-sm text-white placeholder:text-white/45 transition-colors focus:border-white/60 focus:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20'
    : 'w-full rounded-xl border border-warm-stone/30 bg-cream-50/80 px-4 py-3 font-sans text-sm text-near-black placeholder:text-warm-stone/60 transition-colors focus:border-copper-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-copper-300/30'

export function LxFormClient({
  fields,
  submitLabel,
  successHeadline,
  successBody,
  formName,
  csrf,
  onDark = false,
}: {
  fields: Field[]
  submitLabel: string
  successHeadline?: string
  successBody?: string
  formName: string
  csrf: string
  onDark?: boolean
}) {
  const inputClass = inputClassFor(onDark)
  const labelClass = onDark ? 'text-white/70' : 'text-warm-stone'
  const formRef = useRef<HTMLFormElement>(null)
  const recaptcha = useRecaptchaForLead()
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')

  // Defense-in-depth: the schema now reserves HONEYPOT_FIELD, but a legacy
  // block saved before that guard could still carry a field with that name —
  // which would shadow the hidden anti-bot input in FormData. Drop it so it
  // can neither render nor clobber the honeypot.
  const safeFields = fields.filter((f) => f.name !== HONEYPOT_FIELD)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (status === 'sending') return
    setStatus('sending')
    try {
      const el = e.currentTarget
      const raw = new FormData(el)
      // Compose the payload (label:value for every field) + role mappings.
      const items: Array<{ label: string; value: string }> = []
      let _name = '', _email = '', _phone = ''
      for (const f of safeFields) {
        const v = String(raw.get(f.name) ?? '').trim()
        if (f.type === 'checkbox') {
          items.push({ label: f.label, value: raw.get(f.name) ? 'Yes' : 'No' })
        } else if (v) {
          items.push({ label: f.label, value: v })
        }
        if (v) {
          if (f.role === 'name') _name = v
          else if (f.role === 'email') _email = v
          else if (f.role === 'phone') _phone = v
        }
      }
      const fd = new FormData()
      fd.set('csrf', csrf)
      const hp = raw.get(HONEYPOT_FIELD)
      if (hp) fd.set(HONEYPOT_FIELD, String(hp))
      fd.set('_payload', JSON.stringify(items))
      fd.set('_formName', formName)
      if (_name) fd.set('_name', _name)
      if (_email) fd.set('_email', _email)
      if (_phone) fd.set('_phone', _phone)
      const rcToken = await recaptcha.getToken('lead')
      if (rcToken) fd.set('recaptcha', rcToken)
      const res = await fetch('/api/leads/form', { method: 'POST', body: fd })
      if (res.ok) {
        setStatus('done')
        el.reset()
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <div className={`rounded-2xl p-8 text-center ${onDark ? 'bg-white/[0.06] ring-1 ring-white/15' : 'bg-cream-50/80'}`}>
        <p className={`font-serif text-2xl font-semibold ${onDark ? 'text-white' : 'text-near-black'}`}>
          {successHeadline || 'Thank you'}
        </p>
        <p className={`mt-2 font-sans text-sm ${onDark ? 'text-white/70' : 'text-warm-stone'}`}>
          {successBody || 'Your message has been sent. We’ll be in touch soon.'}
        </p>
      </div>
    )
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="csrf" value={csrf} />
      <input
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />
      {safeFields.map((f) => (
        <label key={f.name} className="block">
          <span className={`mb-1.5 block font-sans text-xs font-semibold uppercase tracking-[0.16em] ${labelClass}`}>
            {f.label}
            {f.required && <span className="text-copper-500"> *</span>}
          </span>
          {f.type === 'textarea' ? (
            <textarea name={f.name} required={f.required} placeholder={f.placeholder} rows={4} className={clsx(inputClass, 'resize-y')} />
          ) : f.type === 'select' ? (
            <select name={f.name} required={f.required} className={inputClass} defaultValue="">
              <option value="" disabled>
                {f.placeholder || 'Select…'}
              </option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : f.type === 'checkbox' ? (
            <span className="flex items-center gap-2">
              <input type="checkbox" name={f.name} required={f.required} className="h-4 w-4 accent-copper-500" />
              <span className={`font-sans text-sm ${onDark ? 'text-white/85' : 'text-near-black'}`}>{f.placeholder || f.label}</span>
            </span>
          ) : (
            <input type={f.type} name={f.name} required={f.required} placeholder={f.placeholder} className={inputClass} />
          )}
        </label>
      ))}
      <button
        type="submit"
        disabled={status === 'sending'}
        className={clsx(
          'inline-flex w-fit items-center rounded-full px-7 py-3 font-sans text-xs font-semibold uppercase tracking-[0.2em] transition-colors disabled:opacity-50',
          // On a dark card a near-black button vanishes — use a white pill with
          // dark text for contrast; on a light section keep the dark pill.
          onDark
            ? 'bg-white text-near-black hover:bg-white/85'
            : 'bg-near-black text-cream-50 hover:bg-copper-700',
        )}
      >
        {status === 'sending' ? 'Sending…' : submitLabel}
      </button>
      {status === 'error' && (
        <p className="font-sans text-sm text-red-500">Something went wrong. Please try again.</p>
      )}
      <recaptcha.Widget />
    </form>
  )
}
