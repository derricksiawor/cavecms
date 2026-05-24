'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { BedDouble, Bath, Ruler } from 'lucide-react'
import { MediaImg } from '@/components/blocks/MediaImg'
import { DUR, EASE_STANDARD } from '../_shared/motion'
import type { FloorPlansData, MediaMap } from '../_shared/types'

// Tabbed floor-plan viewer. One tab per unit type; clicking a tab
// swaps the plan image + body. The active tab's plan crossfades
// (Framer Motion) on swap. Keyboard support per WAI-ARIA tabs.

export function FloorPlansSection({
  data,
  media,
}: {
  data: FloorPlansData
  media: MediaMap
}) {
  const units = data.unit_types
  const [active, setActive] = useState(0)

  // Sync the active index when the units array shrinks beneath
  // the current tab (admin removes the last unit type while the
  // user is on it). Without this, the visible tab strip is i=0..N-1
  // but `active` still points at N+1 — aria-selected never matches,
  // aria-controls references a stale panel id. The fallback below
  // renders unit-0 content, but the tab list lies about its state.
  useEffect(() => {
    if (active >= units.length && units.length > 0) setActive(0)
  }, [active, units.length])

  if (units.length === 0) return null

  // Clamp at render-time as well — the useEffect runs after paint,
  // and a synchronous clamp keeps that first frame visually correct.
  const safeActive = Math.min(active, units.length - 1)
  const current = units[safeActive]
  if (!current) return null
  const m = media.get(current.image.media_id)

  // Roving-tabindex arrow-key handling per WAI-ARIA tab pattern.
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % units.length)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + units.length) % units.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(units.length - 1)
    }
  }

  return (
    <section
      id="floor-plans"
      className="bg-cream-50 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            The plans
          </p>
          <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
            Floor plans &amp; layouts
          </h2>
        </div>

        <div
          role="tablist"
          aria-label="Unit types"
          className="mt-10 -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {units.map((u, i) => (
            <button
              key={u.name + i}
              type="button"
              role="tab"
              aria-selected={i === safeActive}
              aria-controls={`floorplan-panel-${i}`}
              id={`floorplan-tab-${i}`}
              tabIndex={i === safeActive ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={onTabKey}
              className={[
                'shrink-0 rounded-full border px-5 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] transition-colors duration-standard ease-standard min-h-[44px]',
                i === safeActive
                  ? 'border-copper-600 bg-copper-600 text-cream'
                  : 'border-near-black/15 bg-cream-50 text-near-black hover:border-copper-300 hover:bg-cream-100',
              ].join(' ')}
            >
              {u.name}
            </button>
          ))}
        </div>

        <div
          id={`floorplan-panel-${safeActive}`}
          role="tabpanel"
          aria-labelledby={`floorplan-tab-${safeActive}`}
          className="mt-10 grid gap-10 lg:grid-cols-12 lg:gap-12"
        >
          <div className="lg:col-span-7">
            <AnimatePresence mode="wait">
              <motion.div
                key={safeActive}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: DUR.standard, ease: EASE_STANDARD }}
                className="overflow-hidden rounded-2xl border border-near-black/8 bg-cream-50 p-6 shadow-md shadow-near-black/5 sm:p-10"
              >
                <MediaImg
                  media={m}
                  alt={current.image.alt || `${current.name} floor plan`}
                  variant="lg"
                  className="block h-72 w-full object-contain sm:h-96 lg:h-[28rem]"
                />
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="lg:col-span-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={safeActive}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: DUR.standard, ease: EASE_STANDARD }}
              >
                <h3 className="font-serif text-2xl sm:text-3xl font-semibold tracking-tight text-near-black">
                  {current.name}
                </h3>

                <ul className="mt-6 grid grid-cols-3 gap-3">
                  {[
                    {
                      Icon: BedDouble,
                      value: current.beds,
                      label: current.beds === 1 ? 'Bedroom' : 'Bedrooms',
                    },
                    {
                      Icon: Bath,
                      value: current.baths,
                      label: current.baths === 1 ? 'Bathroom' : 'Bathrooms',
                    },
                    {
                      Icon: Ruler,
                      value: current.sqft.toLocaleString('en-US'),
                      label: 'Sq ft',
                    },
                  ].map(({ Icon, value, label }) => (
                    <li
                      key={label}
                      className="rounded-2xl border border-near-black/8 bg-cream-50 px-4 py-4 text-center"
                    >
                      <Icon
                        className="mx-auto h-5 w-5 text-copper-700"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <p className="mt-3 font-serif text-2xl font-semibold text-near-black">
                        {value}
                      </p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-warm-stone">
                        {label}
                      </p>
                    </li>
                  ))}
                </ul>

                {current.description?.trim() && (
                  <p className="mt-6 text-base text-warm-stone leading-relaxed whitespace-pre-line">
                    {current.description}
                  </p>
                )}

                <a
                  href="#inquiry-form"
                  className="mt-8 inline-flex items-center gap-2 rounded-full border border-near-black/20 bg-cream px-6 py-3 text-sm font-semibold tracking-wide text-near-black transition-all duration-standard ease-standard hover:bg-near-black hover:text-cream hover:border-near-black min-h-[44px]"
                >
                  Reserve this unit
                </a>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  )
}
