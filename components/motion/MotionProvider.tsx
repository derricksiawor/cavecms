'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { setupGsap, ScrollTrigger } from '@/lib/motion/gsap-setup'

/**
 * App-root motion bootstrap. Three responsibilities:
 *
 *   1. Register GSAP's ScrollTrigger once on first mount.
 *
 *   2. Refresh ScrollTrigger positions after App Router navigation.
 *      Triggers in the new tree compute their start/end positions
 *      against the document's height; if the new tree mounts before
 *      a refresh fires, positions can be wrong.
 *
 *      Implementation: double-rAF on pathname change so the refresh
 *      runs strictly AFTER the new tree's first paint (one rAF
 *      guarantees layout has flushed; a second rAF lands us safely
 *      post-paint).
 *
 *      Additionally subscribe to a ResizeObserver on
 *      document.documentElement so any height change (image decode,
 *      font swap, sticky chrome unmount, viewport rotate) refreshes
 *      triggers. Debounced via rAF to coalesce bursts.
 *
 *      And subscribe to document.fonts.ready (Fraunces / Inter swap
 *      shifts heading line breaks → document height changes → trigger
 *      positions must re-compute).
 *
 *   3. Per-component cleanup is owned by each hook's gsap.context()
 *      — those revert on unmount and remove their own triggers. We
 *      do NOT manually kill all triggers here, because that would
 *      race against the new tree's mount-time registration.
 *
 * Renders no wrapper DOM. Children pass through unchanged.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // GSAP plugin registration — once.
  useEffect(() => {
    setupGsap()
  }, [])

  // Refresh on pathname change. Double-rAF runs after the new tree
  // has both laid out and painted.
  useEffect(() => {
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => ScrollTrigger.refresh())
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [pathname])

  // Refresh on document height change (image decode, font swap,
  // dynamic chrome, mobile-Safari URL-bar collapse). Debounced via
  // a TRAILING 150ms setTimeout — rAF alone only coalesces same-
  // frame bursts; sustained height changes (iOS Safari URL-bar
  // animation, video poster decode chain) fire multiple frames and
  // would trigger ScrollTrigger.refresh() per frame without this
  // trailing debounce. 150ms is well past Safari's 100ms scroll-
  // event throttle, so refresh fires once per settled-layout state.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    let pending: number | undefined
    const refresh = () => {
      if (pending !== undefined) window.clearTimeout(pending)
      pending = window.setTimeout(() => {
        ScrollTrigger.refresh()
        pending = undefined
      }, 150)
    }
    const ro = new ResizeObserver(refresh)
    ro.observe(document.documentElement)
    return () => {
      ro.disconnect()
      if (pending !== undefined) window.clearTimeout(pending)
    }
  }, [])

  // Refresh after web fonts settle. Fraunces line breaks shift when
  // the variable font replaces the fallback; the heading-line-reveal
  // depends on those final line breaks.
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) return
    let active = true
    document.fonts.ready
      .then(() => {
        if (active) ScrollTrigger.refresh()
      })
      .catch(() => {
        // ignore — fonts.ready rejected; the per-component
        // useLineReveal also gates on fonts.ready independently.
      })
    return () => {
      active = false
    }
  }, [])

  return <>{children}</>
}
