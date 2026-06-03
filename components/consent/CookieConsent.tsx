'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CookieConsentConfig } from '@/lib/cms/settings-registry'
import {
  consentToGoogleSignals,
  readConsent,
  writeConsent,
  type ConsentState,
} from '@/lib/consent/consent'

// Public GDPR cookie-consent banner (Feature B). Fully functional:
//   • Shows on first visit (or after a `consentVersion` bump) — Reject all /
//     Customise / Accept all, with per-category toggles behind Customise and
//     an "Allow selected" save.
//   • Persists the choice to a first-party cookie (lib/consent).
//   • GATES tags for real: emits Google Consent Mode v2 signals
//     (gtag('consent','update', …)) so the site's GA4 / Google Ads / GTM tags
//     don't store anything until granted; ALSO sets window.cavecmsConsent +
//     fires a `cavecms:consent` event so any non-Google tag can react.
//   • Re-openable any time — the footer "Cookie preferences" link (and
//     window.cavecmsOpenCookiePrefs()) dispatch `cavecms:open-cookie-prefs`.
//
// Accessibility: role="dialog" + aria-modal in center mode, labelled heading,
// Esc closes the customise view, focus moves into the panel on open.

type Cats = Record<string, boolean>

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
    dataLayer?: unknown[]
    cavecmsConsent?: Cats
    cavecmsOpenCookiePrefs?: () => void
  }
}

export function CookieConsent({ config }: { config: CookieConsentConfig }) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [customizing, setCustomizing] = useState(false)
  const [sel, setSel] = useState<Cats>(() => seedSelections(config))
  const panelRef = useRef<HTMLDivElement>(null)

  // Apply a final choice: persist + signal + broadcast + close.
  const apply = useCallback(
    (cats: Cats) => {
      const next: Cats = { ...cats }
      // Required categories are always granted regardless of UI state.
      for (const c of config.categories) if (c.required) next[c.key] = true
      const state: ConsentState = { v: config.consentVersion, ts: Math.floor(Date.now() / 1000), cats: next }
      writeConsent(state)
      broadcast(next, config)
      setOpen(false)
      setCustomizing(false)
    },
    [config],
  )

  // Decide visibility on mount; re-emit a stored choice's signals so gtag
  // (which booted with everything denied) learns the persisted grant.
  useEffect(() => {
    setMounted(true)
    const stored = readConsent()
    if (stored && stored.v === config.consentVersion) {
      broadcast(stored.cats, config)
      setSel({ ...seedSelections(config), ...stored.cats })
      setOpen(false)
    } else {
      setOpen(true)
    }
    // Expose the re-open hook + listen for the footer link / programmatic open.
    const openPrefs = () => {
      setSel((prev) => ({ ...seedSelections(config), ...(readConsent()?.cats ?? prev) }))
      setCustomizing(true)
      setOpen(true)
    }
    window.cavecmsOpenCookiePrefs = openPrefs
    window.addEventListener('cavecms:open-cookie-prefs', openPrefs)
    return () => {
      window.removeEventListener('cavecms:open-cookie-prefs', openPrefs)
      if (window.cavecmsOpenCookiePrefs === openPrefs) delete window.cavecmsOpenCookiePrefs
    }
  }, [config])

  // Move focus into the panel when it opens; Esc collapses customise.
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && customizing) setCustomizing(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, customizing])

  if (!mounted || !open) return null

  const acceptAll = () => apply(Object.fromEntries(config.categories.map((c) => [c.key, true])))
  const rejectAll = () =>
    apply(Object.fromEntries(config.categories.map((c) => [c.key, !!c.required])))
  const saveSelected = () => apply(sel)

  const dark = config.theme === 'dark' || (config.theme === 'auto')
  const isCenter = config.position === 'center'

  const surface = dark
    ? 'bg-neutral-900/95 text-neutral-100 ring-1 ring-white/10'
    : 'bg-white/97 text-neutral-900 ring-1 ring-black/10'
  const subtle = dark ? 'text-neutral-400' : 'text-neutral-500'
  const linkCls = dark ? 'text-neutral-200 underline underline-offset-2' : 'text-neutral-700 underline underline-offset-2'

  const posCls = isCenter
    ? 'left-1/2 top-1/2 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2'
    : config.position === 'bottom'
      ? 'inset-x-0 bottom-0 mx-auto w-full max-w-5xl sm:bottom-4 sm:inset-x-4 sm:mx-auto'
      : config.position === 'bottom-right'
        ? 'bottom-4 right-4 w-[min(92vw,420px)]'
        : 'bottom-4 left-4 w-[min(92vw,420px)]'

  return (
    <div
      className="fixed inset-0 z-[2147483600] pointer-events-none"
      aria-live="polite"
    >
      {isCenter && (
        <div className="absolute inset-0 bg-black/50 pointer-events-auto" aria-hidden="true" />
      )}
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={isCenter ? 'true' : undefined}
        aria-label={config.title}
        className={`pointer-events-auto fixed ${posCls} rounded-2xl p-5 shadow-2xl backdrop-blur-md outline-none sm:p-6 ${surface}`}
      >
        <h2 className="text-base font-semibold tracking-tight sm:text-lg">{config.title}</h2>
        <p className={`mt-2 text-[13px] leading-relaxed ${subtle}`}>
          {config.message}{' '}
          {config.policyUrl && (
            <a href={config.policyUrl} className={linkCls}>
              Learn more
            </a>
          )}
        </p>

        {customizing && (
          <div className="mt-4 max-h-[42vh] space-y-3 overflow-y-auto pr-1">
            {config.categories.map((c) => (
              <label
                key={c.key}
                className={`flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 ${dark ? 'bg-white/5' : 'bg-black/[0.03]'}`}
              >
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{c.label}</span>
                  <span className={`mt-0.5 block text-[12px] leading-snug ${subtle}`}>{c.description}</span>
                </span>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-current"
                  checked={c.required ? true : !!sel[c.key]}
                  disabled={c.required}
                  onChange={(e) => setSel((s) => ({ ...s, [c.key]: e.target.checked }))}
                  aria-label={`${c.label}${c.required ? ' (always on)' : ''}`}
                />
              </label>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={rejectAll} className={btnGhost(dark)}>
            {config.buttons.rejectAll}
          </button>
          {!customizing ? (
            <button type="button" onClick={() => setCustomizing(true)} className={btnGhost(dark)}>
              {config.buttons.customize}
            </button>
          ) : (
            <button type="button" onClick={saveSelected} className={btnGhost(dark)}>
              {config.buttons.save}
            </button>
          )}
          <button type="button" onClick={acceptAll} className={`ml-auto ${btnSolid(dark)}`}>
            {config.buttons.allowAll}
          </button>
        </div>
      </div>
    </div>
  )
}

function seedSelections(config: CookieConsentConfig): Cats {
  return Object.fromEntries(config.categories.map((c) => [c.key, !!c.required]))
}

// Persist-side effects: Consent Mode v2 update + global flag + event.
function broadcast(cats: Cats, config: CookieConsentConfig) {
  if (typeof window === 'undefined') return
  window.cavecmsConsent = cats
  if (config.googleConsentMode && typeof window.gtag === 'function') {
    window.gtag('consent', 'update', consentToGoogleSignals(cats))
  }
  window.dispatchEvent(new CustomEvent('cavecms:consent', { detail: cats }))
}

function btnSolid(dark: boolean): string {
  return `rounded-full px-5 py-2 text-[13px] font-semibold transition-colors ${
    dark ? 'bg-white text-neutral-900 hover:bg-neutral-200' : 'bg-neutral-900 text-white hover:bg-neutral-700'
  }`
}
function btnGhost(dark: boolean): string {
  return `rounded-full px-4 py-2 text-[13px] font-medium transition-colors ${
    dark ? 'text-neutral-300 hover:bg-white/10' : 'text-neutral-600 hover:bg-black/5'
  }`
}
