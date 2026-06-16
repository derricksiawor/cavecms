'use client'

import { useEffect, useState } from 'react'
import { LinkIcon, Check, Copy } from 'lucide-react'
import { acquireScrollLock, releaseScrollLock } from '@/lib/client/bodyScrollLock'

// Shows the admin the generated one-time reset link with a Copy button,
// plus whether it was also emailed. Centered, flush, on-brand. The copy
// target is the full absolute URL (built by the caller from the page
// origin so it works even with no Site URL configured).
export function ResetLinkModal({
  open,
  email,
  url,
  emailed,
  onClose,
}: {
  open: boolean
  email: string
  url: string
  emailed: boolean
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) setCopied(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    acquireScrollLock()
    return () => {
      window.removeEventListener('keydown', onKey)
      releaseScrollLock()
    }
  }, [open, onClose])

  if (!open) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be blocked; the link text is selectable as a fallback.
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 z-40 cursor-default bg-near-black/45 backdrop-blur-[3px] animate-cavecms-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="resetlink-title"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50 shadow-[0_40px_80px_-30px_rgba(5,5,5,0.55)] animate-cavecms-fade-in"
      >
        <div className="relative px-8 pt-9 pb-7 sm:px-10">
          <div className="relative flex flex-col items-center text-center">
            <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-full bg-cream-50 text-copper-700 ring-1 ring-warm-stone/25">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-full bg-copper-300/30 blur-xl"
              />
              <LinkIcon size={24} strokeWidth={1.8} className="relative" />
            </span>
            <p
              id="resetlink-title"
              className="mt-5 font-serif text-2xl font-bold tracking-tight text-near-black"
            >
              Reset link ready
            </p>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-warm-stone">
              {emailed ? (
                <>
                  We emailed this one-time link to{' '}
                  <span className="font-medium text-near-black">{email}</span>.
                  You can also copy it below to share it directly.
                </>
              ) : (
                <>
                  Copy this one-time link and send it to{' '}
                  <span className="font-medium text-near-black">{email}</span>.
                  It expires in 60 minutes and can be used once.
                </>
              )}
            </p>
          </div>

          <div className="mt-7 flex items-stretch gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="h-12 flex-1 rounded-xl border border-warm-stone/30 bg-white px-4 text-sm text-near-black outline-none [overflow-wrap:anywhere] focus:border-copper-400 focus:ring-2 focus:ring-copper-300/40"
            />
            <button
              type="button"
              onClick={copy}
              className="inline-flex w-fit shrink-0 items-center justify-center gap-2 rounded-xl bg-near-black px-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-cream-50 transition-all hover:bg-copper-700"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex w-fit items-center justify-center rounded-full border border-warm-stone/30 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
