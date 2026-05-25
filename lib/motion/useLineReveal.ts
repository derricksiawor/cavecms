'use client'

import { useEffect, useRef } from 'react'
import { setupGsap, gsap } from './gsap-setup'
import { SplitText } from 'gsap/SplitText'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

let splitTextRegistered = false
function ensureSplitText() {
  if (splitTextRegistered || typeof window === 'undefined') return
  setupGsap()
  gsap.registerPlugin(SplitText)
  splitTextRegistered = true
}

type LineRevealOptions = {
  /** seconds between line tweens (default 0.08) */
  stagger?: number
  /** seconds per line (default 0.9) */
  duration?: number
  /** gsap ease (default 'expo.out') */
  ease?: string
  /** seconds delay before stagger starts (default 0) */
  delay?: number
  /** ScrollTrigger start (default 'top 80%') */
  start?: string
  /** play on mount instead of on scroll (default false) */
  onMount?: boolean
}

/**
 * Line-by-line reveal for editorial headings. Uses GSAP SplitText
 * (free since 3.13 / Webflow acquisition) with mask: 'lines' which
 * auto-creates an overflow-hidden wrapper per visual line of wrap.
 * Each line then translates from yPercent:100 → 0 with a stagger.
 *
 * Font-swap correctness: Fraunces ships via next/font with
 * display: 'swap'. The system fallback renders first, Fraunces swaps
 * in 200-500ms later, and the line breaks REFLOW because Fraunces
 * has different metrics. If SplitText snapshots line breaks against
 * the system font, the post-swap visible lines are misaligned with
 * SplitText's clipped wrappers. The hook gates split + tween setup
 * on `document.fonts.ready` so SplitText always reads the final
 * laid-out lines.
 *
 * Descender padding: SplitText `mask: 'lines'` clips each line at
 * its line-box height. Glyphs with descenders (g, p, y) can be
 * clipped when leading is tight. The hook injects a small bottom
 * padding (0.15em) on the heading while the reveal is active.
 *
 * Reduced-motion: hook is a no-op; heading renders normally.
 *
 * Cleanup: gsap.context().revert() kills all tweens + ScrollTriggers
 * scoped to el. SplitText.revert() restores original text content.
 * Both wrapped in try/catch — `el` may be detached between effect run
 * and cleanup (React 18 Strict mode double-invoke, Suspense fallback
 * swap, parent unmount race).
 */
export function useLineReveal<T extends HTMLElement = HTMLHeadingElement>(
  options: LineRevealOptions = {},
) {
  const ref = useRef<T | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const {
    stagger = 0.08,
    duration = 0.9,
    ease = 'expo.out',
    delay = 0,
    start = 'top 80%',
    onMount = false,
  } = options

  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion) return
    ensureSplitText()

    // Cancel-on-unmount guard for the async fonts.ready wait. If the
    // component unmounts before fonts resolve, we skip setup entirely
    // — including the padding-bottom injection. Applying the padding
    // synchronously here (pre-fonts.ready) would create a visible
    // 0.15em layout shift on the SSR-painted heading even when the
    // reveal never runs.
    let cancelled = false
    let split: SplitText | null = null
    let ctx: gsap.Context | null = null
    // Padding restoration state — captured ONLY when setup() actually
    // applies the padding, so cleanup doesn't try to restore a value
    // that was never overwritten.
    let paddingApplied = false
    let originalPaddingBottom = ''

    const setup = () => {
      if (cancelled || !el.isConnected) return

      // Descender clearance — inject 0.15em pb so glyphs (g, p, y) on
      // tight `leading-display` aren't clipped against the SplitText
      // mask box. Applied AFTER the fonts.ready gate so a fast-unmount
      // before fonts resolve doesn't paint the layout shift.
      originalPaddingBottom = el.style.paddingBottom
      el.style.paddingBottom = `calc(${originalPaddingBottom || '0'} + 0.15em)`
      paddingApplied = true

      split = SplitText.create(el, {
        type: 'lines',
        linesClass: 'cavecms-line',
        mask: 'lines',
        autoSplit: true,
      })

      ctx = gsap.context(() => {
        const tween: gsap.TweenVars = {
          yPercent: 100,
          duration,
          stagger,
          ease,
          delay,
        }
        if (onMount) {
          gsap.from(split!.lines, tween)
        } else {
          gsap.from(split!.lines, {
            ...tween,
            scrollTrigger: {
              trigger: el,
              start,
              once: true,
              toggleActions: 'play none none none',
            },
          })
        }
      }, el)
    }

    // Gate on document.fonts.ready when available (modern browsers).
    // Fallback: run setup synchronously if the API isn't present.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(setup).catch(() => {
        // fonts.ready rejected — proceed with system-font lines
        // rather than skipping the animation entirely.
        if (!cancelled) setup()
      })
    } else {
      setup()
    }

    return () => {
      cancelled = true
      try {
        ctx?.revert()
      } catch {
        // ignore — detached node, nothing to revert
      }
      try {
        split?.revert()
      } catch {
        // ignore — detached node, nothing to revert
      }
      // Restore padding-bottom only if setup actually applied it.
      if (paddingApplied) {
        try {
          el.style.paddingBottom = originalPaddingBottom
        } catch {
          // ignore — detached node
        }
      }
    }
  }, [reducedMotion, stagger, duration, ease, delay, start, onMount])

  return ref
}
