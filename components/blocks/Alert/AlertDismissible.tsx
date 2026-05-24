'use client'
import { useEffect, useState, useCallback } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { ALERT_SECTION_CLASS } from './render'

// Client-only wrapper for a dismissible Alert. Reads localStorage on
// mount to check whether the visitor has previously dismissed THIS
// blockId + content combination; if so, renders nothing.
//
// Storage layout:
//   key:   `bwc:alert:${contentKey}` where contentKey is
//          `${blockId}:${djb2:fnv-1a-content-hash}` composed by the
//          server-side Alert renderer (lib/blocks/Alert/render.tsx).
//   value: '1' (string) when dismissed.
//
// Properties:
//   - blockId scopes dismissal to ONE block row - two distinct Alert
//     blocks with identical text don't share a dismissal slot.
//   - Editing the content (variant/title/body) rotates the contentHash,
//     re-displaying the alert to all previously-dismissed visitors.
//   - Operator clones an alert -> new blockId -> dismissal does NOT
//     carry over (intended; new block surfaces to the visitor).
//
// Hydration:
//   - SSR / first client paint: visible. We don't know yet whether
//     the visitor has dismissed this content.
//   - Mount effect reads localStorage; if dismissed, we hide.
//   - 1-frame flicker for previously-dismissed alerts is the chosen
//     tradeoff (vs cookies, which would add a server round-trip or
//     SSR personalisation, and vs SSR-hidden-by-default, which would
//     keep the alert invisible to no-JS visitors entirely).
//
// Storage failures (private-window quotas, locked storage in iframe
// sandbox, third-party cookie blockers in certain embeds) are
// silently swallowed - the alert stays visible. A failed dismiss
// click sets in-memory state to dismissed for the current page view
// only; the next navigation re-shows it. NEVER throw from this
// component; an alert can't crash the page it sits on.

interface Props {
  contentKey: string
  outerClass?: string
  children: React.ReactNode
}

export function AlertDismissible({ contentKey, outerClass, children }: Props) {
  // Initial state: visible. The mount effect may flip it to dismissed
  // immediately if localStorage says so.
  const [dismissed, setDismissed] = useState(false)
  const storageKey = `bwc:alert:${contentKey}`

  useEffect(() => {
    // Wrapped in try/catch because localStorage access throws in some
    // sandboxed iframes / privacy modes. A storage error must not
    // crash the page.
    try {
      if (typeof window === 'undefined') return
      const stored = window.localStorage.getItem(storageKey)
      if (stored === '1') setDismissed(true)
    } catch {
      // Storage unavailable - leave alert visible. Visitor's dismiss
      // click will hide it for the current session via state but
      // won't persist across reloads.
    }
  }, [storageKey])

  const handleDismiss = useCallback(() => {
    setDismissed(true)
    try {
      window.localStorage.setItem(storageKey, '1')
    } catch {
      // see useEffect comment - tolerate storage failure. The
      // in-memory `dismissed` state still hides for this session.
    }
  }, [storageKey])

  if (dismissed) return null

  return (
    <section className={clsx(ALERT_SECTION_CLASS, outerClass)}>
      <div className="relative">
        {children}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss alert"
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-cream-50/60 transition-colors duration-quick hover:bg-cream-50/10 hover:text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/60 motion-reduce:transition-none"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
    </section>
  )
}
