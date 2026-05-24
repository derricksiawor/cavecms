'use client'

import { useEffect, useRef } from 'react'
import { setupGsap, gsap } from './gsap-setup'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

type RevealOptions = {
  /** px translateY at start (default 24) */
  y?: number
  /** seconds (default 0.7) */
  duration?: number
  /** seconds (default 0) */
  delay?: number
  /** gsap ease (default 'power3.out') */
  ease?: string
  /** ScrollTrigger start (default 'top 85%') */
  start?: string
  /** play once and detach (default true) */
  once?: boolean
}

/**
 * Fade + slide-up reveal on viewport entry. Attach the returned ref
 * to the element to reveal. When prefers-reduced-motion is set, the
 * hook is a no-op — element renders in its final state with no
 * starting transform/opacity.
 *
 * Per-instance cleanup is handled by gsap.context() — when the
 * component unmounts, every tween + ScrollTrigger created inside
 * the context is reverted in one call.
 */
export function useRevealOnScroll<T extends HTMLElement = HTMLDivElement>(
  options: RevealOptions = {},
) {
  const ref = useRef<T | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const {
    y = 24,
    duration = 0.7,
    delay = 0,
    ease = 'power3.out',
    start = 'top 85%',
    once = true,
  } = options

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion) return

    setupGsap()

    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { opacity: 0, y },
        {
          opacity: 1,
          y: 0,
          duration,
          delay,
          ease,
          scrollTrigger: {
            trigger: el,
            start,
            once,
            toggleActions: 'play none none none',
          },
        },
      )
    }, el)

    return () => ctx.revert()
  }, [reducedMotion, y, duration, delay, ease, start, once])

  return ref
}
