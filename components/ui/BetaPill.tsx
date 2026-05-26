'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'

// Shared "Beta" chip for every surface that ships an in-progress
// feature. Per-feature dismissal is stored in localStorage under
// `cavecms.beta.<feature>.dismissed` so a frequent user isn't
// dominated by the badge after they've internalised the state, but
// new operators (or other browsers / users) still see the full pill.
//
// SSR-safe: localStorage is read only AFTER the initial paint, so the
// hydration tree matches the server-rendered tree byte-for-byte.
// Dismissed state then collapses to a small copper dot which the
// operator can hover / focus to transiently re-expand the pill (the
// expansion is non-sticky — no permanent restore affordance; the
// transient hint is what survives once they've moved past it).

export type BetaPillSize = 'sm' | 'md'

export interface BetaPillProps {
  /** Stable feature key. Different keys persist independently in
   *  localStorage so dismissing the Settings-page Beta doesn't also
   *  hide the sparkle-popover Beta. Use kebab-case. */
  feature: string
  /** `sm` = inline chrome (popovers, panels). `md` = page header
   *  beside an h1. */
  size?: BetaPillSize
  /** When true, an X appears inside the pill; clicking it persists
   *  the dismissed state. Without `dismissible`, the pill stays
   *  visible across reloads. */
  dismissible?: boolean
  /** Extra Tailwind classes merged into the outer element. */
  className?: string
}

const STORAGE_PREFIX = 'cavecms.beta.'
const DISMISSED_SUFFIX = '.dismissed'

/** localStorage key shape for the per-feature dismissed flag.
 *  Exported so tests can assert on it without re-deriving the format. */
export function betaPillStorageKey(feature: string): string {
  return STORAGE_PREFIX + feature + DISMISSED_SUFFIX
}

export function BetaPill({
  feature,
  size = 'sm',
  dismissible = false,
  className,
}: BetaPillProps) {
  // Hydration gate. Renders the un-dismissed pill on the server + on
  // the first client paint, then upgrades from localStorage post-
  // mount. Without this the SSR markup (no localStorage available)
  // would mismatch the client's "already dismissed" markup and React
  // would throw a hydration warning.
  const [hydrated, setHydrated] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  // Transient "show me again" state when the dot is hovered/focused
  // after dismissal. Non-persistent — mouseLeave/blur collapses back
  // to the dot.
  const [transientExpand, setTransientExpand] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (window.localStorage.getItem(betaPillStorageKey(feature)) === '1') {
        setDismissed(true)
      }
    } catch {
      // Private-mode / quota-blocked / cookies-off — fail open and
      // show the pill. Dismiss persistence is a nice-to-have, not a
      // security gate.
    }
    setHydrated(true)
  }, [feature])

  const dismiss = (): void => {
    // Write to storage FIRST; only flip the in-memory state when the
    // write succeeds. Otherwise a quota-blocked browser would collapse
    // the pill for the session but reload right back to the pill on
    // next navigation — confusing UX where the operator thinks they've
    // dismissed it.
    try {
      window.localStorage.setItem(betaPillStorageKey(feature), '1')
    } catch {
      // Quota / private-mode / cookies-off — leave the pill visible.
      // The dismiss button stays clickable; the operator can move on.
      return
    }
    setDismissed(true)
    setTransientExpand(false)
  }

  const showPill = !hydrated || !dismissed || transientExpand

  if (showPill) {
    const sizeClass =
      size === 'md'
        ? 'px-3.5 py-1.5 text-[11px]'
        : 'px-3 py-1 text-[10px]'
    return (
      <span
        // Track mouse-leave so the transient-expand collapses back to
        // a dot on its own. No-op when the pill is in its
        // permanent / un-dismissed mode.
        onMouseLeave={() => {
          if (dismissed) setTransientExpand(false)
        }}
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-full bg-copper-100 font-semibold uppercase tracking-[0.2em] text-copper-700 align-middle',
          sizeClass,
          className,
        )}
      >
        Beta
        {dismissible && !dismissed && (
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss the Beta indicator"
            className="-mr-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-copper-600/70 transition-colors hover:bg-copper-200 hover:text-copper-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400"
          >
            <X size={9} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
      </span>
    )
  }

  // Permanently-dismissed → 6px copper dot. Hover / focus expands
  // back to the pill transiently. Accessible via keyboard (tabbable
  // button) so screen-reader users still know the surface is in beta.
  return (
    <button
      type="button"
      onMouseEnter={() => setTransientExpand(true)}
      onFocus={() => setTransientExpand(true)}
      onBlur={() => setTransientExpand(false)}
      aria-label="Beta indicator — hover to expand"
      title="Beta — hover to expand"
      className={clsx(
        'inline-flex h-1.5 w-1.5 flex-shrink-0 items-center justify-center rounded-full bg-copper-500 align-middle transition-transform duration-standard hover:scale-[2] focus:outline-none focus-visible:ring-2 focus-visible:ring-copper-400 motion-reduce:transition-none motion-reduce:hover:scale-100',
        className,
      )}
    />
  )
}
