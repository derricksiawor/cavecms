'use client'

import { useState, type FormEvent } from 'react'
import { MotionConfig, motion } from 'framer-motion'
import { Eye, EyeOff } from 'lucide-react'

const easeLuxury = [0.19, 0.91, 0.38, 0.98] as const

const MIN_LEN = 12

// Map the API's terse error codes to copy-friendly, market-safe sentences.
function messageFor(status: number, code: string | undefined): string {
  if (code === 'invalid_or_expired')
    return 'This link has expired or has already been used. Ask your administrator for a new one.'
  if (code === 'invalid_input')
    return `Your password must be at least ${MIN_LEN} characters.`
  if (status === 429)
    return 'Too many attempts. Please wait a moment, then try again.'
  return 'We couldn’t update your password. Please try again.'
}

const fieldClasses =
  'h-14 w-full rounded-xl bg-white border border-warm-stone/30 px-5 pr-14 text-base font-medium text-near-black tracking-wide placeholder:text-near-black/40 outline-none transition-all duration-standard hover:border-warm-stone/50 focus:border-copper-400 focus:ring-2 focus:ring-copper-500/30 focus:shadow-[0_8px_30px_-10px_rgba(184,115,51,0.25)]'

export function ResetForm({ token }: { token: string }) {
  const [err, setErr] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (submitting) return
    setErr(null)

    if (pw.length < MIN_LEN) {
      setErr(`Your password must be at least ${MIN_LEN} characters.`)
      return
    }
    if (pw !== confirm) {
      setErr('The two passwords don’t match.')
      return
    }

    setSubmitting(true)
    try {
      // No CSRF token: this endpoint is login-equivalent and CSRF-exempt —
      // the single-use secret token IS the credential.
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: pw }),
      })
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; next?: string; error?: string }
        | null

      if (res.ok && data?.ok && typeof data.next === 'string') {
        window.location.href = data.next
        return
      }
      setErr(messageFor(res.status, data?.error))
    } catch {
      setErr('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.8, ease: easeLuxury }}
        className="w-full max-w-md"
      >
        <div className="relative overflow-hidden bg-cream-50/90 backdrop-blur-sm px-10 py-12 sm:px-14 sm:py-16 shadow-[0_30px_80px_-30px_rgba(184,115,51,0.18)]">
          <div className="pointer-events-none absolute top-0 left-0 h-px w-16 bg-gradient-to-r from-copper-500 to-transparent" />
          <div className="pointer-events-none absolute bottom-0 right-0 h-px w-16 bg-gradient-to-l from-copper-500 to-transparent" />

          <motion.p
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.15, ease: easeLuxury }}
            className="text-xs font-semibold tracking-[0.32em] uppercase text-copper-600"
          >
            CaveCMS
          </motion.p>

          <motion.h1
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.25, ease: easeLuxury }}
            className="mt-4 font-serif text-3xl sm:text-4xl font-bold text-near-black tracking-tight leading-[1.05]"
          >
            Set a new password
          </motion.h1>

          <motion.p
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35, ease: easeLuxury }}
            className="mt-3 text-sm font-medium text-warm-stone tracking-wide"
          >
            Choose a new password for your account. This link can be used once.
          </motion.p>

          <motion.form
            onSubmit={handleSubmit}
            noValidate
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.45, ease: easeLuxury }}
            className="mt-10 space-y-6"
          >
            <div className="space-y-2">
              <label
                htmlFor="cavecms-new-password"
                className="block text-[11px] font-semibold tracking-[0.22em] uppercase text-near-black"
              >
                New password
              </label>
              <div className="relative">
                <input
                  id="cavecms-new-password"
                  name="new-password"
                  type={show ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  className={fieldClasses}
                />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-warm-stone/70 transition-colors hover:text-copper-600"
                >
                  {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
              <p className="text-xs font-medium text-warm-stone/80 tracking-wide">
                At least {MIN_LEN} characters.
              </p>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="cavecms-confirm-password"
                className="block text-[11px] font-semibold tracking-[0.22em] uppercase text-near-black"
              >
                Confirm password
              </label>
              <div className="relative">
                <input
                  id="cavecms-confirm-password"
                  name="confirm-password"
                  type={show ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={fieldClasses}
                />
              </div>
            </div>

            {err && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="text-sm font-medium text-copper-700"
              >
                {err}
              </motion.p>
            )}

            <div className="pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="group relative w-fit bg-near-black px-10 py-4 text-sm font-semibold tracking-[0.18em] uppercase text-cream-50 transition-all duration-standard hover:bg-copper-600 hover:shadow-[0_20px_50px_-15px_rgba(184,115,51,0.5)] hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-500 focus-visible:ring-offset-4 focus-visible:ring-offset-cream-50 disabled:opacity-60 disabled:cursor-wait"
              >
                <span className="relative z-10">
                  {submitting ? 'Saving…' : 'Save password'}
                </span>
              </button>
            </div>
          </motion.form>
        </div>
      </motion.div>
    </MotionConfig>
  )
}
