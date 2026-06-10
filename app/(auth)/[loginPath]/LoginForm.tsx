'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MotionConfig, motion } from 'framer-motion'
import { RecaptchaNotice } from '@/components/RecaptchaNotice'

// Shared `window.grecaptcha` global type — see
// lib/security/grecaptcha-global.d.ts for the single declaration.
import type { GrecaptchaShared } from '@/lib/security/grecaptcha-global'

type GrecaptchaV3Api = GrecaptchaShared & {
  execute: NonNullable<GrecaptchaShared['execute']>
}
type GrecaptchaV2Api = GrecaptchaShared & {
  render: NonNullable<GrecaptchaShared['render']>
  reset: NonNullable<GrecaptchaShared['reset']>
  getResponse: NonNullable<GrecaptchaShared['getResponse']>
}

const SCRIPT_ID_V3 = 'cavecms-recaptcha-v3'
const SCRIPT_ID_V2 = 'cavecms-recaptcha-v2'
const easeLuxury = [0.19, 0.91, 0.38, 0.98] as const

// Turn a whole-seconds wait into a human "about X minutes / X seconds"
// phrase for the lockout message. Rounds up to whole minutes once past 60s
// so the operator is never told to retry a few seconds early.
function formatRetry(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds))
  if (s < 60) return `about ${s} second${s === 1 ? '' : 's'}`
  const mins = Math.ceil(s / 60)
  return `about ${mins} minute${mins === 1 ? '' : 's'}`
}

function loadRecaptchaV3(siteKey: string): Promise<GrecaptchaV3Api> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no_window'))
    if (window.grecaptcha && typeof window.grecaptcha.execute === 'function') {
      return resolve(window.grecaptcha as GrecaptchaV3Api)
    }

    let script = document.getElementById(SCRIPT_ID_V3) as HTMLScriptElement | null
    if (!script) {
      script = document.createElement('script')
      script.id = SCRIPT_ID_V3
      script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`
      script.async = true
      script.defer = true
      const nonceMeta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
      if (nonceMeta?.content) script.nonce = nonceMeta.content
      document.head.appendChild(script)
    }

    const start = Date.now()
    const tick = (): void => {
      if (window.grecaptcha && typeof window.grecaptcha.ready === 'function' && typeof window.grecaptcha.execute === 'function') {
        window.grecaptcha.ready(() => {
          if (window.grecaptcha) resolve(window.grecaptcha as GrecaptchaV3Api)
          else reject(new Error('grecaptcha_unavailable'))
        })
        return
      }
      if (Date.now() - start > 8000) {
        reject(new Error('grecaptcha_load_timeout'))
        return
      }
      window.setTimeout(tick, 80)
    }
    tick()
  })
}

function loadRecaptchaV2(): Promise<GrecaptchaV2Api> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no_window'))
    // v2 widget is rendered explicitly (no `?render=siteKey` param);
    // we call grecaptcha.render() ourselves so the widget appears in
    // a specific container without auto-render side effects.
    const explicit = window.grecaptcha as GrecaptchaV2Api | undefined
    if (explicit && typeof explicit.render === 'function') return resolve(explicit)

    let script = document.getElementById(SCRIPT_ID_V2) as HTMLScriptElement | null
    if (!script) {
      script = document.createElement('script')
      script.id = SCRIPT_ID_V2
      script.src = 'https://www.google.com/recaptcha/api.js?render=explicit'
      script.async = true
      script.defer = true
      const nonceMeta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
      if (nonceMeta?.content) script.nonce = nonceMeta.content
      document.head.appendChild(script)
    }

    const start = Date.now()
    const tick = (): void => {
      const g = window.grecaptcha as GrecaptchaV2Api | undefined
      if (g && typeof g.render === 'function') {
        g.ready(() => resolve(g))
        return
      }
      if (Date.now() - start > 8000) {
        reject(new Error('grecaptcha_load_timeout'))
        return
      }
      window.setTimeout(tick, 80)
    }
    tick()
  })
}

export function LoginForm({
  csrf: initialCsrf,
  action,
  recaptchaSiteKey,
  recaptchaVersion,
}: {
  csrf: string
  action: string
  recaptchaSiteKey: string
  recaptchaVersion: 'v2' | 'v3'
}) {
  // The pre-CSRF nonce is single-use and consumed on every attempt, so the
  // server returns a fresh one in each failure response. Hold it in state and
  // swap it into the hidden field so a retry after a wrong password isn't sent
  // with a dead token (which used to 401 even with the correct password).
  const [csrf, setCsrf] = useState(initialCsrf)
  const [err, setErr] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // v3
  const v3ApiRef = useRef<GrecaptchaV3Api | null>(null)
  // v2
  const v2ApiRef = useRef<GrecaptchaV2Api | null>(null)
  const v2WidgetIdRef = useRef<number | null>(null)
  const v2ContainerRef = useRef<HTMLDivElement>(null)
  const v2TokenRef = useRef<string>('')

  useEffect(() => {
    if (!recaptchaSiteKey) return
    let cancelled = false
    if (recaptchaVersion === 'v3') {
      loadRecaptchaV3(recaptchaSiteKey)
        .then((api) => {
          if (!cancelled) v3ApiRef.current = api
        })
        .catch(() => {
          /* surfaced on submit as a generic 'verification unavailable' */
        })
    } else {
      loadRecaptchaV2()
        .then((api) => {
          if (cancelled || !v2ContainerRef.current) return
          v2ApiRef.current = api
          v2WidgetIdRef.current = api.render(v2ContainerRef.current, {
            sitekey: recaptchaSiteKey,
            callback: (token) => {
              v2TokenRef.current = token
            },
            'expired-callback': () => {
              v2TokenRef.current = ''
            },
            'error-callback': () => {
              v2TokenRef.current = ''
            },
          })
        })
        .catch(() => {
          /* surfaced on submit as generic */
        })
    }
    return () => {
      cancelled = true
    }
  }, [recaptchaSiteKey, recaptchaVersion])

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (submitting) return
    setErr(null)
    setSubmitting(true)
    try {
      const fd = new FormData(e.currentTarget)
      if (recaptchaSiteKey) {
        if (recaptchaVersion === 'v3') {
          let api = v3ApiRef.current
          if (!api) {
            api = await loadRecaptchaV3(recaptchaSiteKey).catch(() => null)
            if (api) v3ApiRef.current = api
          }
          if (!api) {
            setErr('Verification unavailable. Please refresh and try again.')
            return
          }
          try {
            const token = await api.execute(recaptchaSiteKey, { action: 'login' })
            fd.set('g-recaptcha-response', token)
          } catch {
            setErr('Verification failed. Please refresh and try again.')
            return
          }
        } else {
          // v2 — the widget has already populated v2TokenRef via its
          // callback. If empty, prompt the operator to check the box.
          const token = v2TokenRef.current
          if (!token) {
            setErr('Please complete the verification challenge above, then try again.')
            return
          }
          fd.set('g-recaptcha-response', token)
        }
      }
      const res = await fetch(action, { method: 'POST', body: fd, credentials: 'same-origin' })
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; next?: string; error?: string; locked?: boolean; retryAfter?: number; csrf?: string }
        | null
      // Swap in the fresh single-use pre-CSRF token for the next attempt. The
      // server sends one with every failure response; without this, a retry
      // after a wrong password reuses the consumed token and always 401s.
      if (typeof data?.csrf === 'string' && data.csrf) setCsrf(data.csrf)
      if (res.ok && data?.ok && typeof data.next === 'string') {
        window.location.href = data.next
        return
      }
      // v2 tokens are single-use — reset the widget so a retry doesn't
      // re-submit the consumed token.
      if (recaptchaVersion === 'v2' && v2ApiRef.current && v2WidgetIdRef.current !== null) {
        v2ApiRef.current.reset(v2WidgetIdRef.current)
        v2TokenRef.current = ''
      }
      // Lockout / rate-limit response (status 429 with locked:true). Tell the
      // operator how long to wait rather than the generic credential error.
      // Prefer the JSON retryAfter; fall back to the standard Retry-After
      // header. If neither is a usable number, show the server message as-is.
      if (res.status === 429 || data?.locked) {
        const headerRetry = Number(res.headers.get('retry-after'))
        const retry =
          typeof data?.retryAfter === 'number' && data.retryAfter > 0
            ? data.retryAfter
            : Number.isFinite(headerRetry) && headerRetry > 0
              ? headerRetry
              : null
        setErr(
          retry !== null
            ? `Too many failed attempts — try again in ${formatRetry(retry)}.`
            : (data?.error ?? 'Too many failed attempts. Please try again later.'),
        )
        return
      }
      setErr(data?.error ?? 'Sign in failed.')
    } catch {
      setErr('Network error.')
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
            Sign in
          </motion.h1>

          <motion.p
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.35, ease: easeLuxury }}
            className="mt-3 text-sm font-medium text-warm-stone tracking-wide"
          >
            Authorised personnel only.
          </motion.p>

          <motion.form
            onSubmit={handleSubmit}
            noValidate
            initial={false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.45, ease: easeLuxury }}
            className="mt-10 space-y-6"
          >
            <input type="hidden" name="csrf" value={csrf} />
            <input
              type="text"
              name="hp_token"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              readOnly
              defaultValue=""
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
            />

            <div className="space-y-2">
              <label
                htmlFor="cavecms-email"
                className="block text-[11px] font-semibold tracking-[0.22em] uppercase text-near-black"
              >
                Email
              </label>
              <input
                id="cavecms-email"
                name="email"
                type="email"
                required
                autoComplete="username"
                spellCheck={false}
                className="h-14 w-full rounded-xl bg-white border border-warm-stone/30 px-5 text-base font-medium text-near-black tracking-wide placeholder:text-near-black/40 outline-none transition-all duration-standard hover:border-warm-stone/50 focus:border-copper-400 focus:ring-2 focus:ring-copper-500/30 focus:shadow-[0_8px_30px_-10px_rgba(184,115,51,0.25)]"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="cavecms-password"
                className="block text-[11px] font-semibold tracking-[0.22em] uppercase text-near-black"
              >
                Password
              </label>
              <input
                id="cavecms-password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="h-14 w-full rounded-xl bg-white border border-warm-stone/30 px-5 text-base font-medium text-near-black tracking-wide placeholder:text-near-black/40 outline-none transition-all duration-standard hover:border-warm-stone/50 focus:border-copper-400 focus:ring-2 focus:ring-copper-500/30 focus:shadow-[0_8px_30px_-10px_rgba(184,115,51,0.25)]"
              />
            </div>

            {recaptchaSiteKey && recaptchaVersion === 'v2' && (
              <div className="pt-2">
                <div ref={v2ContainerRef} />
              </div>
            )}

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
                  {submitting ? 'Signing in…' : 'Sign in'}
                </span>
              </button>
            </div>

            {recaptchaSiteKey && recaptchaVersion === 'v3' && <RecaptchaNotice className="pt-6" />}
          </motion.form>
        </div>
      </motion.div>
    </MotionConfig>
  )
}
