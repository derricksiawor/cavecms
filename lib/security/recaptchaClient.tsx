// Client-side reCAPTCHA helper for the four public lead forms.
//
// Shape:
//   const r = useRecaptchaForLead()
//   ...
//   // (v2 only) render `<r.Widget />` somewhere in the form body
//   ...
//   // on submit:
//   const token = await r.getToken('lead')
//   if (token) fd.set('g-recaptcha-response', token)
//
// When reCAPTCHA is disabled or fetching the config fails, getToken
// returns null and Widget renders nothing — submission falls through
// without a token. The server side fails OPEN on missing tokens
// (lib/leads/spam.ts), so a misconfigured client doesn't drop real
// leads.

'use client'

import { useEffect, useRef, useState } from 'react'

// `window.grecaptcha` global type lives in lib/security/grecaptcha-global.d.ts
// — keep one declaration shared across login form, this hook, and the
// verify modal to avoid Next-minor breaks on interface-merge conflicts.
import type { GrecaptchaShared } from './grecaptcha-global'

// Local narrowings — both methods optional on the shared type.
type GrecaptchaV3 = GrecaptchaShared & {
  execute: NonNullable<GrecaptchaShared['execute']>
}
type GrecaptchaV2 = GrecaptchaShared & {
  render: NonNullable<GrecaptchaShared['render']>
  reset: NonNullable<GrecaptchaShared['reset']>
  getResponse: NonNullable<GrecaptchaShared['getResponse']>
}

interface PublicConfig {
  enabled: false
}
interface EnabledConfig {
  enabled: true
  version: 'v2' | 'v3'
  siteKey: string
}
type Config = PublicConfig | EnabledConfig

// Module-level cache so multiple forms on the same page (header +
// footer newsletter, page-embedded contact) don't each fetch the
// config independently. 60-second TTL matches the server-side
// unstable_cache revalidate window — without a TTL, an admin's flip
// in another tab wouldn't reach a long-lived single-page session
// until full reload (App Router transitions reuse the module).
// Failed fetches are NOT cached — the next caller retries instead
// of receiving "disabled" forever after a transient blip.
let configPromise: Promise<Config> | null = null
let configTs = 0
const CONFIG_TTL_MS = 60_000
function fetchConfig(): Promise<Config> {
  if (configPromise && Date.now() - configTs < CONFIG_TTL_MS) return configPromise
  // 5-second hard timeout — a slow / hung public route would otherwise
  // block the recaptcha config promise indefinitely and freeze the
  // form's submit gate. AbortSignal.timeout is supported in every
  // browser shipping a reasonably current Next 15-ready runtime.
  const p: Promise<Config> = fetch('/api/public/recaptcha-config', {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`recaptcha-config-${r.status}`)
      return (await r.json()) as Config
    })
    .catch(() => {
      // Blow the cache on failure so the next caller retries rather
      // than receiving "disabled" forever.
      if (configPromise === p) {
        configPromise = null
        configTs = 0
      }
      return { enabled: false } as Config
    })
  configPromise = p
  configTs = Date.now()
  return p
}

const V3_SCRIPT_ID = 'cavecms-recaptcha-v3-lead'
const V2_SCRIPT_ID = 'cavecms-recaptcha-v2-lead'

function injectScript(id: string, src: string): void {
  if (document.getElementById(id)) return
  const s = document.createElement('script')
  s.id = id
  s.src = src
  s.async = true
  s.defer = true
  const nonceMeta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
  if (nonceMeta?.content) s.nonce = nonceMeta.content
  document.head.appendChild(s)
}

function waitForGrecaptcha(
  check: (g: NonNullable<Window['grecaptcha']>) => boolean,
  timeoutMs = 8000,
): Promise<NonNullable<Window['grecaptcha']>> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      const g = window.grecaptcha
      if (g && check(g)) {
        g.ready(() => resolve(g))
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('grecaptcha_load_timeout'))
        return
      }
      window.setTimeout(tick, 80)
    }
    tick()
  })
}

interface UseRecaptchaForLead {
  ready: boolean
  config: Config | null
  getToken: (action: string) => Promise<string | null>
  /** Mount point for the v2 widget. Render `<r.Widget />` somewhere
   *  in the form body. For v3 / disabled, renders nothing.            */
  Widget: () => React.ReactElement | null
}

export function useRecaptchaForLead(): UseRecaptchaForLead {
  const [config, setConfig] = useState<Config | null>(null)
  const widgetIdRef = useRef<number | null>(null)
  const v2TokenRef = useRef<string>('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const v3ApiRef = useRef<GrecaptchaV3 | null>(null)
  const v2ApiRef = useRef<GrecaptchaV2 | null>(null)

  // Load config + script(s) once.
  useEffect(() => {
    let cancelled = false
    fetchConfig().then((c) => {
      if (cancelled) return
      setConfig(c)
      if (!c.enabled) return
      if (c.version === 'v3') {
        injectScript(V3_SCRIPT_ID, `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(c.siteKey)}`)
        waitForGrecaptcha((g) => typeof g.execute === 'function')
          .then((g) => {
            if (!cancelled) v3ApiRef.current = g as GrecaptchaV3
          })
          .catch(() => {/* getToken handles unavailability */})
      } else {
        injectScript(V2_SCRIPT_ID, 'https://www.google.com/recaptcha/api.js?render=explicit')
        waitForGrecaptcha((g) => typeof g.render === 'function')
          .then((g) => {
            if (cancelled) return
            v2ApiRef.current = g as GrecaptchaV2
            if (containerRef.current && widgetIdRef.current === null) {
              widgetIdRef.current = (g as GrecaptchaV2).render(containerRef.current, {
                sitekey: c.siteKey,
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
          })
          .catch(() => {/* getToken handles unavailability */})
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Re-attempt v2 render once the container becomes available (it
  // mounts on the same tick as the form body; the script load above
  // may have resolved before the ref attached). Explicit dependency
  // on `config` prevents re-firing on every parent re-render, which
  // under Strict Mode would risk a double `render()` against the
  // same container (grecaptcha de-dupes silently but the second
  // call's callback wins).
  useEffect(() => {
    if (!config || !config.enabled || config.version !== 'v2') return
    if (widgetIdRef.current !== null) return
    if (!v2ApiRef.current || !containerRef.current) return
    widgetIdRef.current = v2ApiRef.current.render(containerRef.current, {
      sitekey: config.siteKey,
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
  }, [config])

  const getToken = async (action: string): Promise<string | null> => {
    const c = config ?? (await fetchConfig())
    if (!c.enabled) return null
    if (c.version === 'v3') {
      const g = v3ApiRef.current ?? (await waitForGrecaptcha((x) => typeof x.execute === 'function').then((x) => x as GrecaptchaV3).catch(() => null))
      if (!g) return null
      try {
        const token = await g.execute(c.siteKey, { action })
        return token
      } catch {
        return null
      }
    }
    // v2 — token is whatever the widget callback last captured.
    const token = v2TokenRef.current
    return token || null
  }

  const Widget: UseRecaptchaForLead['Widget'] = () => {
    if (!config || !config.enabled || config.version !== 'v2') return null
    return <div ref={containerRef} className="my-4" />
  }

  return { ready: config !== null, config, getToken, Widget }
}
