'use client'

import { useEffect, useRef } from 'react'
import { setupGsap, gsap } from './gsap-setup'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

type ParallaxOptions = {
  /** start scale (default 1.0) */
  scaleFrom?: number
  /** end scale (default 1.08) */
  scaleTo?: number
  /** start yPercent (default 0) */
  yPercent?: number
  /** end yPercent — non-zero for vertical parallax (default 0) */
  yPercentTo?: number
}

/**
 * Scroll-driven scale + optional vertical translate. Scrub-tied to
 * the element's progress through the viewport: at top-of-viewport-
 * entry the transform is at the FROM values; at bottom-of-viewport-
 * exit it's at the TO values.
 *
 * Best used on full-bleed images inside an overflow-hidden parent
 * so the scaled image doesn't blow out the layout.
 */
export function useParallax<T extends HTMLElement = HTMLImageElement>(
  options: ParallaxOptions = {},
) {
  const ref = useRef<T | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const { scaleFrom = 1.0, scaleTo = 1.08, yPercent = 0, yPercentTo = 0 } = options

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion) return
    setupGsap()

    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { scale: scaleFrom, yPercent },
        {
          scale: scaleTo,
          yPercent: yPercentTo,
          ease: 'none',
          scrollTrigger: {
            trigger: el,
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
          },
        },
      )
    }, el)

    return () => ctx.revert()
  }, [reducedMotion, scaleFrom, scaleTo, yPercent, yPercentTo])

  return ref
}
