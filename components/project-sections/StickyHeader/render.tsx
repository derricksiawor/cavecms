'use client'

import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { statusLabel } from '../_shared/labels'

// Sticky mini-header. Appears after the hero scrolls off-screen,
// stays pinned at the top until the user scrolls back up past the
// hero. Carries project name + status pill + sticky CTA so the
// "Schedule a tour" affordance is always one tap away.
//
// Uses a single IntersectionObserver on the #project-hero sentinel.
// The bar is always mounted; visibility is toggled via a
// `data-pinned` attribute that drives a CSS transform + opacity
// transition. No framer-motion dep — Chunk D's duration-standard +
// ease-standard tokens carry the motion.

export function StickyHeader({
  projectName,
  projectStatus,
}: {
  projectName: string
  projectStatus: string
}) {
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    const sentinel = document.getElementById('project-hero')
    if (!sentinel) return
    // Synchronous initial check — IntersectionObserver fires
    // asynchronously, so on a deep-link arrival (page loaded with
    // #pricing hash already scrolled past the hero) the bar would
    // take 200-600 ms to appear. Reading the rect at attach time
    // closes that window.
    const initialRect = sentinel.getBoundingClientRect()
    setPinned(initialRect.bottom <= 0)
    // Observe the hero element directly; the bar pins as soon as
    // the hero's bottom edge crosses the top of the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        // When the hero is NOT intersecting (scrolled off), pin.
        setPinned(!entry.isIntersecting && entry.boundingClientRect.top < 0)
      },
      { threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [])

  return (
    <header
      data-pinned={pinned}
      // Slot below the admin bar when it's present (var resolves to
      // its height when logged in; defaults to 0 for the public
      // visitor). z:40 puts the bar in front of the SiteHeader (z:30)
      // but behind the admin bar (z:60).
      style={{ top: 'var(--admin-bar-h, 0px)' }}
      className={[
        'fixed inset-x-0 z-40 border-b border-near-black/10 bg-cream/95 backdrop-blur supports-[backdrop-filter]:bg-cream/80',
        'transition-all duration-standard ease-standard',
        // Pre-pin state: lifted off-screen + invisible + uninteractive
        'data-[pinned=false]:-translate-y-full data-[pinned=false]:opacity-0 data-[pinned=false]:pointer-events-none',
        // Pinned state: settled in place
        'data-[pinned=true]:translate-y-0 data-[pinned=true]:opacity-100',
      ].join(' ')}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-10">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="inline-flex h-2 w-2 shrink-0 rounded-full bg-copper-500 animate-bwc-pulse-copper"
            aria-hidden
          />
          <p className="min-w-0 truncate font-serif text-base font-semibold tracking-tight text-near-black sm:text-lg">
            {projectName}
          </p>
          {statusLabel(projectStatus) && (
            <span className="hidden shrink-0 rounded-full border border-copper-200 bg-copper-50 px-3 py-0.5 text-[9px] font-semibold uppercase tracking-[0.28em] text-copper-700 sm:inline-block">
              {statusLabel(projectStatus)}
            </span>
          )}
        </div>

        <a
          href="#inquiry-form"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-near-black px-4 py-2.5 text-xs font-semibold tracking-wide text-cream transition-all duration-standard ease-standard hover:bg-copper-700 min-h-[44px] sm:px-5 sm:text-sm"
        >
          Schedule a tour
          <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={2} />
        </a>
      </div>
    </header>
  )
}
