'use client'

import { useEffect, useRef } from 'react'
import { readConsent } from '@/lib/consent/consent'

// Client gate for non-Google tracking loaders (Hotjar / HubSpot / Zoho SalesIQ)
// when the GDPR banner is enabled. Those vendors don't support Google Consent
// Mode, so they must be LOAD-gated: inject the loader only once the visitor
// grants the mapped category, and inject on a later grant by subscribing to the
// `cavecms:consent` event the banner fires. This is what makes the consent
// event a real consumer (without it the tags would fire pre-consent).
//
// Loading works under CSP strict-dynamic: this island is part of the nonced
// app bundle, so a <script> it createElement-appends is transitively trusted
// and runs without its own nonce (same mechanism the vendor snippets rely on).

export interface GatedScript {
  /** Stable DOM id so we never double-inject. */
  id: string
  /** Consent category key that must be granted to load this. */
  category: string
  /** Inline snippet (executed) — OR `src` for an external loader. */
  html?: string
  src?: string
  async?: boolean
  defer?: boolean
}

export function ConsentGatedScripts({ scripts }: { scripts: GatedScript[] }) {
  const injected = useRef<Set<string>>(new Set())
  useEffect(() => {
    const injectGranted = () => {
      const cats = readConsent()?.cats ?? {}
      for (const s of scripts) {
        if (injected.current.has(s.id)) continue
        if (!cats[s.category]) continue // not granted (or category absent) → fail closed
        if (document.getElementById(s.id)) {
          injected.current.add(s.id)
          continue
        }
        const el = document.createElement('script')
        el.id = s.id
        if (s.src) {
          el.src = s.src
          if (s.async) el.async = true
          if (s.defer) el.defer = true
        }
        if (s.html) el.text = s.html
        document.head.appendChild(el)
        injected.current.add(s.id)
      }
    }
    injectGranted()
    const onConsent = () => injectGranted()
    window.addEventListener('cavecms:consent', onConsent)
    return () => window.removeEventListener('cavecms:consent', onConsent)
  }, [scripts])
  return null
}
