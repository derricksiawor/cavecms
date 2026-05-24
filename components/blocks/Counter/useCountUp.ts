'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

// Reusable count-up hook for Counter (single tile) and StatsRow (multi-
// counter row). IntersectionObserver-driven so the animation only runs
// when the operator's number tile is actually visible - prevents the
// "user lands on page, sees 120, scrolls past, never sees the animation"
// problem that fixed scroll listeners would cause.
//
// Design notes:
//   - First paint renders 0 (SSR + initial client render match). The
//     surrounding label carries the SEO weight, not the numeric value.
//   - prefers-reduced-motion (any layer of OS / browser / user choice)
//     short-circuits the animation - jump straight to target. The hook
//     subscribes to the MediaQueryList so a runtime change of the OS
//     setting flips behaviour without a page reload.
//   - Stagger is per-item (callers pass index * 120ms). Each item runs
//     its own IntersectionObserver + RAF loop, so a 6-item StatsRow has
//     6 observers - acceptable; they self-disconnect on first trigger.
//   - All timers / observers / RAFs cleaned up on unmount and on every
//     ref reassignment / target change.
//   - `start` is read through a ref so a target/duration change mid-
//     stagger (between viewport entry and the staggerMs timer firing)
//     uses the fresh target, not the closure value captured at
//     observer-install time.
//   - On a target/duration change, the reset effect re-installs the
//     IntersectionObserver against the latest node so the new target
//     animates on the next viewport entry without needing the parent
//     component to remount the host element.

// eased value from 0..1 -> 0..1 with a soft tail (matches research's
// "easeOutExpo, 1800-2200ms" finding for luxury counters).
function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)
}

interface UseCountUpOptions {
  /** Bypass the animation entirely and render `target` immediately.
   *  Used by callers that already know to skip (e.g. an EditDrawer
   *  preview where the operator is tweaking the target value, or
   *  when the operator's edit-mode preview should show the final
   *  number, not the climb). */
  disabled?: boolean
  /** Delay this many ms after the element enters the viewport before
   *  the RAF loop kicks off. Used for stagger in StatsRow (each item
   *  passes `index * 120`). Has no effect when `disabled` or
   *  prefers-reduced-motion is set. */
  staggerMs?: number
}

interface UseCountUpReturn {
  /** Current animated value. Render this in the DOM. Starts at 0 and
   *  grows to `target` over `durationMs`. */
  value: number
  /** Ref callback to attach to the DOM node that should trigger the
   *  count-up when it enters the viewport. Cleans up any previous
   *  observer/timer when reassigned. */
  ref: (node: HTMLElement | null) => void
}

export function useCountUp(
  target: number,
  durationMs: number,
  { disabled = false, staggerMs = 0 }: UseCountUpOptions = {},
): UseCountUpReturn {
  // Initial value = target. SSR + first paint render the final figure
  // ("120 Residences") instead of "0 Residences". The observer-driven
  // reset effect drops it back to 0 only AFTER the element is observed
  // entering the viewport (or for a target change mid-life), so the
  // animation still plays for visitors who scroll into the section.
  // Pre-fix: useState(0) made every full-page screenshot, every
  // no-JS visitor, and every visitor whose JS hadn't hydrated yet
  // see a literal "0+ Residences" instead of the actual number.
  const [value, setValue] = useState(target)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const rafRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedRef = useRef(false)
  const nodeRef = useRef<HTMLElement | null>(null)
  // True after the first reset-effect tick so we know "this is a real
  // target/duration change", not the synthetic post-mount run that
  // would otherwise drop value back to 0 immediately on hydration.
  const hydratedRef = useRef(false)
  // Timestamp of the most recent observer install. If the
  // observer fires with isIntersecting=true within ~120ms of install,
  // it means the element was ALREADY in viewport when we started
  // watching — visitor landed with the stats in view. Skip the
  // animation in that case (a literal "snap to 0 then climb to 120"
  // looks broken to someone who already saw the real number on
  // first paint). Otherwise (later fire) it's a real scroll-in and
  // the climb is the WOW the visitor came for.
  const observerInstalledTsRef = useRef(0)

  const cleanup = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Final unmount cleanup. The ref-callback cleanup handles
  // ref-swap mid-life; this catches the component going away entirely.
  useEffect(() => cleanup, [cleanup])

  // Subscribe to prefers-reduced-motion changes. Runtime toggles of
  // the OS setting (rare but supported - keyboard-shortcut on macOS,
  // settings panel on iOS) re-evaluate the animation policy without
  // needing a page reload.
  const [reducedMotion, setReducedMotion] = useState<boolean>(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    // addEventListener is the modern API; Safari < 14 used addListener
    // (deprecated). Both exist in current builds; addEventListener is
    // what Next 15's `lib.dom` ships, so type-checks pass directly.
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // `start` reads `target` and `durationMs` directly. We keep a ref
  // to the latest `start` so observer / timer callbacks installed
  // BEFORE a mid-flight target change still close over the freshest
  // function (otherwise the closure captured at install time fires
  // the OLD target's animation).
  const start = useCallback(() => {
    if (startedRef.current) return
    startedRef.current = true
    const startTs = performance.now()
    const tick = () => {
      // Bail if the host component has unmounted between RAF schedule
      // and RAF fire. Pre-fix, a fast-scroll page (20+ stats blocks)
      // could leak 20 RAF closures whose setValue() fires after their
      // owning component is gone — React 19 swallows the warning but
      // the closures hold the captured target/duration/setValue refs
      // until the next GC cycle. The unmount cleanup at line ~109 sets
      // nodeRef.current = null; we re-check it here as the cheap gate.
      if (!nodeRef.current) {
        rafRef.current = null
        return
      }
      const elapsed = performance.now() - startTs
      const t = Math.min(1, elapsed / Math.max(1, durationMs))
      const eased = easeOutExpo(t)
      // Round during the climb so the operator-visible number doesn't
      // flicker with fractional digits. The final frame uses the exact
      // target to guarantee the rendered value matches the source of
      // truth (target may be a non-integer like 4.9).
      if (t < 1) {
        setValue(Math.round(target * eased))
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setValue(target)
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [target, durationMs])

  const startRef = useRef(start)
  useEffect(() => {
    startRef.current = start
  }, [start])

  // Reset state if the target / duration / disabled / reducedMotion
  // changes. Short-circuits to the final value for both `disabled`
  // and prefers-reduced-motion (no RAF or observer cost). Otherwise
  // resets value to 0 and re-installs the observer on the
  // currently-bound node so the next viewport entry animates with
  // the fresh target.
  useEffect(() => {
    cleanup()
    if (disabled || reducedMotion) {
      setValue(target)
      startedRef.current = true
      return
    }
    // On the FIRST run after hydration we leave value === target so the
    // visitor sees the actual figure during scroll-down. The observer's
    // entry callback handles the reset-to-zero + animate-up. On
    // subsequent runs (target/duration changed mid-life) we drop to 0
    // so the new target animates from scratch.
    if (hydratedRef.current) {
      setValue(0)
    }
    hydratedRef.current = true
    startedRef.current = false
    // Re-install observer on the cached node. If `ref` hasn't been
    // attached yet (component just mounting), the ref callback will
    // install one when it fires.
    const node = nodeRef.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      timerRef.current = setTimeout(() => startRef.current(), staggerMs)
      return
    }
    observerInstalledTsRef.current = performance.now()
    observerRef.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry?.isIntersecting) return
        observerRef.current?.disconnect()
        observerRef.current = null
        // Skip animation if the element was already in viewport at
        // observe-time — visitor already saw the real number on first
        // paint. A snap-to-0 + climb-back here would look like a glitch.
        const isLandingView =
          performance.now() - observerInstalledTsRef.current < 120
        if (isLandingView) {
          startedRef.current = true
          return
        }
        // Real scroll-in. Drop to 0 SYNCHRONOUSLY (one paint at 0) then
        // let RAF take it back up to target.
        setValue(0)
        if (staggerMs > 0) {
          timerRef.current = setTimeout(() => startRef.current(), staggerMs)
        } else {
          startRef.current()
        }
      },
      { threshold: 0.2 },
    )
    observerRef.current.observe(node)
  }, [target, durationMs, disabled, reducedMotion, staggerMs, cleanup])

  const ref = useCallback(
    (node: HTMLElement | null) => {
      // Reassignment - tear down whatever the previous node hooked up.
      cleanup()
      nodeRef.current = node
      if (!node) return
      if (disabled || reducedMotion || startedRef.current) return

      // SSR fallback (no IntersectionObserver) - just queue the start
      // after the stagger delay. The component is mounted; the value
      // will climb from 0 to target on schedule.
      if (typeof IntersectionObserver === 'undefined') {
        timerRef.current = setTimeout(() => startRef.current(), staggerMs)
        return
      }

      observerInstalledTsRef.current = performance.now()
      observerRef.current = new IntersectionObserver(
        (entries) => {
          const entry = entries[0]
          if (!entry?.isIntersecting) return
          // Single-fire - disconnect synchronously so a rapid
          // scroll-out-then-in doesn't re-trigger the animation.
          observerRef.current?.disconnect()
          observerRef.current = null
          // Same skip-on-initial-view guard as the reset-effect
          // observer. See its comment for rationale.
          const isLandingView =
            performance.now() - observerInstalledTsRef.current < 120
          if (isLandingView) {
            startedRef.current = true
            return
          }
          setValue(0)
          if (staggerMs > 0) {
            timerRef.current = setTimeout(() => startRef.current(), staggerMs)
          } else {
            startRef.current()
          }
        },
        { threshold: 0.2 },
      )
      observerRef.current.observe(node)
    },
    [cleanup, disabled, reducedMotion, staggerMs],
  )

  return { value, ref }
}
