'use client'

import { useEffect, useRef, useState } from 'react'
import { setupGsap, gsap } from './gsap-setup'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

type CountUpOptions = {
  to: number
  /** start value (default 0) */
  from?: number
  /** seconds (default 1.8). 0 = no tween (final value set immediately). */
  duration?: number
  /** gsap ease (default 'power2.out') */
  ease?: string
  /** ScrollTrigger start (default 'top 85%') */
  start?: string
  /** display formatter (default: rounded integer) */
  format?: (n: number) => string
}

/**
 * Number tween on scroll. Tweens a JS number FROM `from` TO `to` and
 * re-renders the formatted string per gsap onUpdate tick. The returned
 * ref attaches to the trigger element — the count starts when THAT
 * element scrolls into view, not on mount.
 *
 *   const [text, ref] = useCountUp({ to: 20, format: n => `${n}+` })
 *   return <span ref={ref}>{text}</span>
 *
 * Contract for SSR + SEO:
 *   The initial useState value is `format(to)` — the FINAL value, not
 *   the start. SSR HTML therefore carries the meaningful number
 *   ("20+", not "0+") so crawlers index real content. On client
 *   mount the gsap.from tween waits for the ScrollTrigger; when the
 *   trigger fires it resets state to `from` and animates to `to`.
 *
 * Contract for reduced-motion:
 *   Hook short-circuits — state stays at `format(to)`. No flash, no
 *   tween. The OS-level prefers-reduced-motion is honoured.
 *
 * Contract for inline `format` callers:
 *   Callers (e.g. LxStat) pass inline arrow functions whose identity
 *   changes every render. To avoid effect-thrash that would tear down
 *   and recreate the ScrollTrigger on every parent re-render, the
 *   format function is captured into a ref; the effect deps include
 *   only primitives. The latest format is read inside onUpdate.
 */
export function useCountUp(options: CountUpOptions) {
  const {
    to,
    from = 0,
    duration = 1.8,
    ease = 'power2.out',
    start = 'top 85%',
    format,
  } = options

  const ref = useRef<HTMLSpanElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  // Initial state = final value. SSR + first paint show the meaningful
  // number; the tween (if active) momentarily resets to `from` on
  // trigger-fire and animates back.
  const [text, setText] = useState<string>(() =>
    format ? format(to) : String(to),
  )

  // formatRef holds the latest format. The effect deps purposefully
  // omit `format` so an inline-arrow caller doesn't churn the effect.
  // onUpdate reads formatRef.current at call time.
  const formatRef = useRef(format)
  formatRef.current = format

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Reduced-motion path: leave state at format(to). If the consumer
    // changed `to` between renders, sync.
    if (reducedMotion) {
      const fmt = formatRef.current
      setText(fmt ? fmt(to) : String(to))
      return
    }

    // Zero-duration short-circuit — instant final value, no tween.
    if (duration === 0) {
      const fmt = formatRef.current
      setText(fmt ? fmt(to) : String(to))
      return
    }

    setupGsap()

    // Sync displayed text to the latest `to` and the latest format
    // BEFORE installing the tween. Without this sync, when an
    // operator edits `data.value` in the drawer (changing `to`),
    // this effect re-runs to create a new ScrollTrigger — but
    // because the trigger has `once: true` and may have already
    // fired, the new gsap.from may not animate. The painted text
    // would remain at the previous tween's final value. Forcing
    // setText here covers that gap.
    {
      const fmt = formatRef.current
      setText(fmt ? fmt(to) : String(to))
    }

    // state.value starts at `to` (matches the painted initial text).
    // gsap.from(state, { value: from, ... }) tweens FROM `from` TO the
    // target's current value (`to`). With scrollTrigger, the tween
    // waits for the trigger; on fire it sets state.value=from and
    // animates back to `to`. onUpdate dispatches setText per tick.
    const state = { value: to }
    const ctx = gsap.context(() => {
      gsap.from(state, {
        value: from,
        duration,
        ease,
        onUpdate: () => {
          const fmt = formatRef.current
          setText(
            fmt ? fmt(state.value) : String(Math.round(state.value)),
          )
        },
        scrollTrigger: {
          trigger: el,
          start,
          once: true,
          toggleActions: 'play none none none',
        },
      })
    }, el)

    return () => {
      // Wrap in try/catch — `el` may have been detached between
      // effect run and cleanup (React 18 Strict mode double-invoke,
      // Suspense fallback swap, parent unmount race). gsap.context
      // revert handles detached nodes generally but defence in depth.
      try {
        ctx.revert()
      } catch {
        // silent — detached node, nothing to revert
      }
    }
  }, [reducedMotion, to, from, duration, ease, start])

  // Format-identity sync effect — fires on every render where the
  // format closure identity differs (e.g., operator changes
  // prefix/suffix/decimals via the drawer). The main tween effect
  // omits `format` from its deps to avoid restarting the tween on
  // inline-arrow callers; this lightweight setText-only effect
  // catches the static-display window (pre-trigger-fire or
  // post-tween-complete) where the format closure changed but the
  // tween's onUpdate isn't running.
  useEffect(() => {
    setText(format ? format(to) : String(to))
  }, [format, to])

  return [text, ref] as const
}
