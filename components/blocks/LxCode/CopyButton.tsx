'use client'
import { useState } from 'react'
import clsx from 'clsx'

// One-click copy for the code block header. Client component (clipboard +
// transient "Copied" state); renders fine in both the public SSR tree and the
// editor's client tree (it is NOT async — only the parent LxCode must stay sync).
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy code to clipboard"
      onClick={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        } catch {
          /* clipboard blocked (insecure context / denied) — no-op */
        }
      }}
      className={clsx(
        'font-sans text-[10px] font-semibold uppercase tracking-eyebrow transition-colors',
        copied ? 'text-champagne' : 'text-warm-stone/70 hover:text-ivory',
      )}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
