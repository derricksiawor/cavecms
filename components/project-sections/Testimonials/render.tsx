'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Quote } from 'lucide-react'
import type { TestimonialsData } from '../_shared/types'

// One-at-a-time testimonial carousel. Large serif quote with a
// copper quotation mark, pagination dots, prev/next chevrons. Auto-
// advances every 7s, pauses on hover/focus, respects
// prefers-reduced-motion (no auto-advance when reduced).
//
// Crossfade uses CSS `key`-based remount + `animate-bwc-fade-in` —
// no framer-motion dependency. The Chunk D token system carries the
// curve + duration, so the visual rhythm matches every other
// project-section animation without a JS-side override.
//
// Accessibility: pagination dots are inside ≥44px buttons (the dot is
// visual only). The container does NOT carry aria-live — on an auto-
// rotating carousel, repeating announcements every 7s is a documented
// WCAG anti-pattern. Screen readers navigate via the explicit prev /
// next / dot controls.

const AUTO_ADVANCE_MS = 7_000

function detectReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function TestimonialsSection({ data }: { data: TestimonialsData }) {
  const entries = data.entries
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  // Lazy initialise from matchMedia so the auto-advance effect sees
  // the correct value on first render — using useRef caused the
  // first 7-second timer to fire even when the user had reduced
  // motion set, because the ref-update effect ran AFTER the
  // auto-advance effect on first mount.
  const [reducedMotion, setReducedMotion] = useState(detectReducedMotion)
  const total = entries.length

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const next = useCallback(
    () => setIndex((i) => (i + 1) % Math.max(total, 1)),
    [total],
  )
  const prev = useCallback(
    () => setIndex((i) => (i - 1 + Math.max(total, 1)) % Math.max(total, 1)),
    [total],
  )

  useEffect(() => {
    if (paused || total <= 1 || reducedMotion) return
    const t = setTimeout(next, AUTO_ADVANCE_MS)
    return () => clearTimeout(t)
  }, [index, paused, total, next, reducedMotion])

  if (total === 0) return null
  const current = entries[index] ?? entries[0]
  if (!current) return null

  return (
    <section
      id="testimonials"
      className="bg-near-black py-20 sm:py-28 text-cream"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="mx-auto max-w-4xl px-4 sm:px-6 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-300">
          In their own words
        </p>
        <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-cream">
          From the residents
        </h2>

        <div className="relative mt-14 min-h-[16rem]">
          <Quote
            className="mx-auto h-10 w-10 text-copper-400"
            strokeWidth={1.5}
            aria-hidden
          />

          {/* `key` forces a remount on slide change so the CSS
             entrance animation fires every time without needing
             framer-motion's AnimatePresence. The fill-mode: both on
             animate-bwc-fade-in preserves the visible end-state once
             the animation finishes. */}
          <figure key={index} className="mt-6 animate-bwc-fade-in">
            <blockquote className="mx-auto max-w-3xl font-serif text-xl sm:text-2xl md:text-3xl font-medium leading-relaxed text-cream/95">
              &ldquo;{current.quote}&rdquo;
            </blockquote>
            <figcaption className="mt-6 text-sm text-cream/70">
              <span className="font-semibold text-cream">
                {current.attribution}
              </span>
              {current.unit_type && (
                <>
                  {' '}
                  &middot;{' '}
                  <span className="italic">{current.unit_type}</span>
                </>
              )}
            </figcaption>
          </figure>
        </div>

        {total > 1 && (
          <div className="mt-10 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={prev}
              aria-label="Previous testimonial"
              className="grid h-11 w-11 place-items-center rounded-full border border-cream/20 bg-near-black/40 text-cream transition-colors duration-standard ease-standard hover:border-cream/40 hover:bg-cream/10 min-h-[44px] min-w-[44px]"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>

            <ul
              role="tablist"
              aria-label="Testimonial pagination"
              className="flex items-center gap-1"
            >
              {entries.map((_, i) => (
                <li key={i}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    aria-label={`Show testimonial ${i + 1}`}
                    onClick={() => setIndex(i)}
                    // The dot is purely visual; the button is the
                    // ≥44px touch target wrapping it.
                    className="grid h-11 w-11 place-items-center min-h-[44px] min-w-[44px]"
                  >
                    <span
                      aria-hidden
                      className={[
                        'block h-1.5 rounded-full transition-all duration-standard ease-standard',
                        i === index
                          ? 'w-8 bg-copper-400'
                          : 'w-1.5 bg-cream/30 hover:bg-cream/60',
                      ].join(' ')}
                    />
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={next}
              aria-label="Next testimonial"
              className="grid h-11 w-11 place-items-center rounded-full border border-cream/20 bg-near-black/40 text-cream transition-colors duration-standard ease-standard hover:border-cream/40 hover:bg-cream/10 min-h-[44px] min-w-[44px]"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
