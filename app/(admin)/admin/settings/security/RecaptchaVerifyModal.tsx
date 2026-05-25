'use client'

import { useEffect, useRef, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'

// Live verify-keys handshake. The operator types siteKey + secretKey
// in the parent form; clicks "Test these keys"; this modal:
//
//   1. Loads grecaptcha (v2 OR v3, matching the form's version).
//   2. v3 — calls grecaptcha.execute() with action 'verify_keys' on
//      Verify-click; gets a token.
//      v2 — renders an inline checkbox; user solves the challenge;
//      token captured via the widget callback.
//   3. POSTs { version, siteKey, secretKey, token } to
//      /api/admin/security/verify-recaptcha. The server runs Google
//      siteverify with the TYPED secret and records a 5-minute
//      verification row keyed on (userId, hashes, version).
//   4. On success → onVerified() — the parent re-enables the
//      "Enable on admin login" toggle and removes the
//      verify-required save gate.
//
// 5-minute TTL matches requireFreshReauth's window. A fresh
// verification proves the EXACT keys being saved work end-to-end
// against the operator's session right now — wrong domain registration,
// rate-limit, secret typo, network-egress block all surface here, not
// after the operator has locked themselves out.

interface GrecaptchaApi {
  ready: (cb: () => void) => void
  execute?: (siteKey: string, opts: { action: string }) => Promise<string>
  render?: (
    container: HTMLElement,
    opts: {
      sitekey: string
      callback?: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    },
  ) => number
  reset?: (widgetId?: number) => void
}

const SCRIPT_ID = 'cavecms-recaptcha-verify'

// Read window.grecaptcha through `unknown` rather than augmenting the
// global type. Three separate modules (this one, LoginForm,
// recaptchaClient) all touch the same global with slightly different
// shapes; merging interfaces across all three causes "Subsequent
// property declarations must have the same type" conflicts.
function getGrecaptcha(): GrecaptchaApi | undefined {
  return (window as unknown as { grecaptcha?: GrecaptchaApi }).grecaptcha
}

function clearGrecaptcha(): void {
  delete (window as unknown as { grecaptcha?: GrecaptchaApi }).grecaptcha
}

function loadScript(url: string): void {
  if (document.getElementById(SCRIPT_ID)) {
    // If already loaded for a different version, remove + re-add so
    // the explicit-render flag matches the current version.
    document.getElementById(SCRIPT_ID)?.remove()
    if (getGrecaptcha()) clearGrecaptcha()
  }
  const s = document.createElement('script')
  s.id = SCRIPT_ID
  s.src = url
  s.async = true
  s.defer = true
  const nonceMeta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
  if (nonceMeta?.content) s.nonce = nonceMeta.content
  document.head.appendChild(s)
}

function waitForGrecaptcha(check: (g: GrecaptchaApi) => boolean): Promise<GrecaptchaApi> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      const g = getGrecaptcha()
      if (g && check(g)) {
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

export function RecaptchaVerifyModal({
  open,
  version,
  siteKey,
  secretKey,
  onClose,
  onVerified,
}: {
  open: boolean
  version: 'v2' | 'v3'
  siteKey: string
  secretKey: string
  onClose: () => void
  onVerified: () => void
}) {
  const [phase, setPhase] = useState<'ready' | 'loading' | 'executing' | 'submitting' | 'error'>('ready')
  const [err, setErr] = useState<string | null>(null)
  const v2ContainerRef = useRef<HTMLDivElement>(null)
  const v2TokenRef = useRef<string>('')
  const v2WidgetIdRef = useRef<number | null>(null)
  const v2ApiRef = useRef<GrecaptchaApi | null>(null)

  // Load + render whenever the modal opens or the version changes.
  useEffect(() => {
    if (!open) return
    setErr(null)
    setPhase('loading')
    v2TokenRef.current = ''
    v2WidgetIdRef.current = null

    const url =
      version === 'v3'
        ? `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`
        : 'https://www.google.com/recaptcha/api.js?render=explicit'
    loadScript(url)

    let cancelled = false
    waitForGrecaptcha((g) =>
      version === 'v3' ? typeof g.execute === 'function' : typeof g.render === 'function',
    )
      .then((g) => {
        if (cancelled) return
        if (version === 'v2') {
          v2ApiRef.current = g
          if (v2ContainerRef.current && g.render) {
            v2WidgetIdRef.current = g.render(v2ContainerRef.current, {
              sitekey: siteKey,
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
          }
        }
        setPhase('ready')
      })
      .catch(() => {
        if (cancelled) return
        setErr("Couldn't load reCAPTCHA. Check your network + site key are right.")
        setPhase('error')
      })

    return () => {
      cancelled = true
    }
  }, [open, version, siteKey])

  if (!open) return null

  async function handleVerify(): Promise<void> {
    setErr(null)
    setPhase('executing')
    try {
      let token = ''
      if (version === 'v3') {
        const g = getGrecaptcha()
        if (!g?.execute) throw new Error('grecaptcha_unavailable')
        token = await g.execute(siteKey, { action: 'verify_keys' })
      } else {
        token = v2TokenRef.current
        if (!token) {
          setErr('Please complete the challenge above first.')
          setPhase('ready')
          return
        }
      }
      setPhase('submitting')
      const r = await csrfFetch('/api/admin/security/verify-recaptcha', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, siteKey, secretKey, token }),
      })
      if (r.status === 200) {
        onVerified()
        return
      }
      const j = (await r.json().catch(() => null)) as { error?: string; reason?: string } | null
      // Map server-side reason codes to canonical, predefined strings.
      // NEVER render an arbitrary field from `j` — a future server-side
      // change that echoes the typed secret/key into an error path
      // would otherwise leak via the modal copy. Unknown reasons fall
      // through to the generic message.
      const REASON_MESSAGES: Record<string, string> = {
        low_score:
          "Your score was below the threshold. If you're sure the keys are right, lower the minimum score or try again.",
        wrong_action:
          "The keys responded but the action didn't match — double-check the site/secret keys belong to the same registration.",
        verify_failed:
          "Google rejected the keys. Double-check the site/secret pair and that this site's domain is registered in the reCAPTCHA admin.",
        verify_timeout:
          "Couldn't reach Google reCAPTCHA in time. Check your network / outbound firewall and try again.",
      }
      const reason = j?.reason ?? ''
      setErr(REASON_MESSAGES[reason] ?? 'Verification failed. Try again.')
      // Reset v2 widget so the operator can retry without reloading
      if (version === 'v2' && v2ApiRef.current?.reset && v2WidgetIdRef.current !== null) {
        v2ApiRef.current.reset(v2WidgetIdRef.current)
        v2TokenRef.current = ''
      }
      setPhase('error')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Verification error.')
      setPhase('error')
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rc-verify-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-cream-50 p-6 shadow-2xl">
        <h2
          id="rc-verify-title"
          className="font-serif text-xl font-bold tracking-tight text-near-black"
        >
          Test your reCAPTCHA keys
        </h2>
        <p className="mt-2 text-sm text-warm-stone">
          We&rsquo;ll run a live challenge using the keys you just typed. If it
          passes, the &ldquo;Enable on admin login&rdquo; toggle becomes
          saveable for the next 5 minutes.
        </p>

        {version === 'v2' && (
          <div className="mt-4 rounded-xl bg-cream-100 p-3">
            <div ref={v2ContainerRef} />
          </div>
        )}

        {err && (
          <p role="alert" className="mt-4 text-sm font-medium text-red-700">
            {err}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={handleVerify}
            disabled={phase === 'loading' || phase === 'executing' || phase === 'submitting'}
          >
            {phase === 'loading'
              ? 'Loading…'
              : phase === 'executing'
                ? 'Running challenge…'
                : phase === 'submitting'
                  ? 'Submitting…'
                  : 'Verify'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

