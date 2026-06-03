'use client'

import { useEffect, useRef, useState } from 'react'
import type { SectionKenBurns, SectionSlideTransition } from '@/lib/cms/blockMeta'

// Animated section background (Feature A). Renders one or more photos behind a
// section with:
//   • Ken Burns — a slow continuous camera drift on the displayed photo
//     (inner <img>, CSS keyframes from globals.css; the keyframe NAME comes
//     from a fixed allow-list, never operator free-text).
//   • Slideshow — when 2+ slides are present they auto cross-fade. The default
//     'through-black' transition is the cinematic look: the OUTGOING photo
//     fades out while zooming IN, the INCOMING fades in while zooming OUT, both
//     dipping through a black base. The counter-zoom lives on the OUTER layer;
//     the inner Ken Burns drift composes on top (parent × child transform).
//
// Scalability + a11y (per house rules):
//   • The advance timer runs ONLY while the section is in the viewport
//     (IntersectionObserver) — off-screen heroes cost nothing.
//   • All slides but the first are loading="lazy" — opening a 8-slide hero
//     doesn't fetch 8 images up front; they stream as the loop reaches them.
//   • prefers-reduced-motion → no auto-advance, no drift; the first slide
//     shows static. The inner drift is ALSO disabled in CSS as a belt.
//   • Every timer + observer is torn down on unmount.

export type BackdropSlide = { src: string; alt: string }

// Single-image ambient drift cycle (ms) when there's no slideshow.
const SINGLE_DRIFT_MS = 16000
// Cross-fade + counter-zoom duration between slides (ms) at the cinematic
// default. For short intervals the effective transition is shortened (see
// `transitionMs` below) so it NEVER exceeds half the hold — a 1000ms interval
// gets a 500ms fade, not a clamp. This honours the full schema range
// (slideIntervalMs 1000..30000) instead of silently flooring it.
const TRANSITION_MS = 1300

// Effective fade for a given interval: the cinematic 1300ms, but never more
// than half the hold so the incoming slide always settles before the next
// advance (no overlap/jank) — and so the operator's exact ms value is honoured
// down to the schema minimum rather than silently raised.
function effectiveTransition(intervalMs: number): number {
  return Math.min(TRANSITION_MS, Math.max(200, Math.round(intervalMs * 0.5)))
}

export function SectionBackdrop({
  slides,
  fitClass,
  position,
  kenBurns,
  transition,
  intervalMs,
}: {
  slides: BackdropSlide[]
  fitClass: string
  position?: string
  kenBurns: SectionKenBurns
  transition: SectionSlideTransition
  intervalMs: number
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [reduced, setReduced] = useState(false)
  const isShow = slides.length > 1

  // Track prefers-reduced-motion (also re-evaluates if the user flips the OS
  // setting mid-session).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])

  // Auto-advance — only when there's a slideshow, motion is allowed, AND the
  // section is on screen. The interval is created/destroyed by the observer so
  // an off-screen hero never ticks.
  useEffect(() => {
    if (!isShow || reduced) return
    const el = rootRef.current
    if (!el || typeof window === 'undefined') return
    // Honour the operator's exact interval (schema-clamped to 1000..30000);
    // the 1000 floor here is only a defensive guard against an unclamped prop.
    const period = Math.max(1000, intervalMs)
    let timer = 0
    const start = () => {
      if (!timer) {
        timer = window.setInterval(
          () => setIndex((i) => (i + 1) % slides.length),
          period,
        )
      }
    }
    const stop = () => {
      if (timer) {
        window.clearInterval(timer)
        timer = 0
      }
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) start()
        else stop()
      },
      { rootMargin: '0px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      stop()
    }
  }, [isShow, reduced, intervalMs, slides.length])

  if (!slides.length) return null

  // Clamp the active index so a shrinking slide list (live editor: operator
  // deletes a slide while index points past the new end) never leaves every
  // layer inactive → a transient blank backdrop.
  const safeIndex = index % slides.length
  const counterZoom = transition !== 'fade'
  const transitionMs = effectiveTransition(intervalMs)
  const driftMs = isShow
    ? Math.max(1000, intervalMs) + transitionMs
    : SINGLE_DRIFT_MS
  const kbName = kenBurns !== 'none' ? `cms-kb-${kenBurns}` : undefined

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0">
      {transition === 'through-black' && (
        <div aria-hidden="true" className="absolute inset-0 bg-black" />
      )}
      {slides.map((s, i) => {
        const active = reduced ? i === 0 : i === safeIndex
        return (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              opacity: active ? 1 : 0,
              transform: counterZoom ? `scale(${active ? 1 : 1.12})` : undefined,
              transition: reduced
                ? undefined
                : `opacity ${transitionMs}ms ease, transform ${transitionMs}ms ease`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={s.src}
              alt={s.alt}
              aria-hidden={s.alt === '' ? 'true' : undefined}
              className={`h-full w-full cms-kb-img ${fitClass}`}
              style={{
                objectPosition: position,
                animation:
                  !reduced && kbName && active
                    ? `${kbName} ${driftMs}ms ease-in-out infinite alternate`
                    : undefined,
              }}
              loading={i === 0 ? 'eager' : 'lazy'}
              decoding="async"
              fetchPriority={i === 0 ? 'high' : undefined}
              draggable={false}
            />
          </div>
        )
      })}
    </div>
  )
}
