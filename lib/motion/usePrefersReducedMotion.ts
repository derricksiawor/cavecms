'use client'

import { useSyncExternalStore } from 'react'

/**
 * Subscribes to `prefers-reduced-motion: reduce` and re-renders when
 * the OS toggle changes. Returns true when the user has opted out of
 * motion — every motion hook short-circuits when this returns true.
 *
 * Implemented as a singleton-subscribed store via useSyncExternalStore:
 *   - ONE matchMedia listener per page, regardless of how many motion
 *     hooks subscribe. The legacy useState pattern installed N listeners
 *     per page (one per hook instance) — on a stats-heavy page this hit
 *     20-30 listeners. The singleton reduces that to 1.
 *   - The snapshot is read SYNCHRONOUSLY during commit (pre-paint), so
 *     reduced-motion users do NOT see a one-frame flash of "would-have-
 *     animated" content. useState's deferred-effect pattern caused this
 *     flash; useSyncExternalStore eliminates it.
 *   - SSR returns false (no matchMedia available); the getServerSnapshot
 *     callback below provides this default. Hydration may briefly show
 *     animation start-states for reduced-motion users on slow connections,
 *     but the subsequent commit synchronises immediately.
 *
 * Important note re GSAP: the global `@media (prefers-reduced-motion:
 * reduce)` rule in globals.css floors CSS animation/transition
 * durations to ~0ms. GSAP uses requestAnimationFrame + inline
 * transform/opacity — NOT CSS animations — so that global rule does
 * NOT defence-in-depth GSAP. Each motion hook MUST check this flag
 * and short-circuit. The global CSS rule covers the cavecms-* keyframes
 * + Tailwind transitions only.
 */

let cachedMql: MediaQueryList | null = null
function getMql(): MediaQueryList {
  // Lazy + cached — avoids constructing a new matchMedia on every
  // subscriber. Same MediaQueryList instance shared across the page.
  if (cachedMql === null) {
    cachedMql = window.matchMedia('(prefers-reduced-motion: reduce)')
  }
  return cachedMql
}

function subscribe(onChange: () => void): () => void {
  const mql = getMql()
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  return getMql().matches
}

function getServerSnapshot(): boolean {
  // SSR cannot read matchMedia. Default to false — non-reduced-motion
  // users get correct first paint; reduced-motion users hydrate with
  // the subsequent commit (the useSyncExternalStore snapshot is read
  // synchronously during commit, so this is sub-frame).
  return false
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
