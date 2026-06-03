'use client'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import clsx from 'clsx'
import { useToast } from '@/components/inline-edit/Toast'

// A read-only monospace value with a copy button. Used for the exact
// verification <meta> tags each search console asks you to paste, and for
// the auto-hosted IndexNow `/{key}.txt` URL.
//
// These values paste into WEB forms (Google Search Console, Bing
// Webmaster Tools) — NOT into a shell that executes on paste — so a
// post-copy success toast is the right affordance here. Rule #0.591's
// inline-edit-before-copy requirement is specifically for commands pasted
// into execute-on-receive shells; this is not that case.
//
// The copy button flips to a copper check for ~1.6s on success and fires
// a toast, so the operator gets confirmation both at the button and in the
// global toast stack.
export function CopyField({
  value,
  label,
  /** Toast message on copy. Defaults to "Copied to clipboard." */
  toastMessage = 'Copied to clipboard.',
  /** Optional helper line under the field. */
  help,
  /** Truncate the displayed value to one line (default). Long meta tags
   *  wrap when false. */
  truncate = true,
  className,
}: {
  value: string
  label?: string
  toastMessage?: string
  help?: React.ReactNode
  truncate?: boolean
  className?: string
}) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(toastMessage)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error("Couldn't copy — select the text and copy it manually.")
    }
  }

  return (
    <div className={clsx('space-y-1.5', className)}>
      {label && (
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
          {label}
        </p>
      )}
      <div className="flex items-stretch gap-2">
        <code
          className={clsx(
            'flex-1 rounded-xl border border-warm-stone/25 bg-cream-50/80 px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-near-black',
            truncate ? 'truncate' : 'break-all',
          )}
          title={truncate ? value : undefined}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy to clipboard"
          className={clsx(
            'inline-flex w-11 shrink-0 items-center justify-center rounded-xl border transition-all duration-quick ease-standard cavecms-focus-ring',
            copied
              ? 'border-copper-500 bg-copper-500/15 text-copper-700'
              : 'border-warm-stone/25 bg-cream-50/80 text-warm-stone hover:border-copper-400 hover:bg-copper-500/10 hover:text-copper-700',
          )}
        >
          {copied ? (
            <Check size={16} strokeWidth={2.4} aria-hidden />
          ) : (
            <Copy size={16} strokeWidth={2} aria-hidden />
          )}
        </button>
      </div>
      {help && <p className="text-[11px] text-warm-stone">{help}</p>}
    </div>
  )
}
