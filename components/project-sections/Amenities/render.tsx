import type { ReactNode } from 'react'
import { iconForAmenity } from '../_shared/amenityIcons'
import { RevealOnView } from '../_shared/RevealOnView'
import type { AmenitiesData } from '../_shared/types'

// Amenities grid. Each chip = circular copper icon + label, with a
// hover lift + copper underline. Cascade-staggers the chip entrance
// using the .bwc-stagger-item utility (Anna's 50ms-per-item).
//
// The Zod cap is 60 amenities; the visual cap is 24 — anything past
// 24 indicates an over-stuffed list and would crush the grid. We
// render the first 24 with the chip layout; older entries past 24
// fall back to a comma-joined caption (admin will not hit this in
// normal use — a sales sheet rarely lists >24 amenities).

export function AmenitiesSection({ data }: { data: AmenitiesData }): ReactNode {
  const items = data.items.filter((i) => i.label.trim())
  if (items.length === 0) return null

  const primary = items.slice(0, 24)
  const overflow = items.slice(24)

  return (
    <RevealOnView
      as="section"
      id="amenities"
      animation="slide-up"
      className="bg-cream-100 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Lifestyle
          </p>
          <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
            Everyday amenities, considered
          </h2>
          <p className="mt-4 text-base sm:text-lg text-warm-stone leading-relaxed">
            Each residence is paired with curated common spaces, hospitality
            services, and infrastructure designed to feel quietly indulgent.
          </p>
        </div>

        <ul className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 sm:gap-4">
          {primary.map((it, i) => {
            const Icon = iconForAmenity(it.icon)
            return (
              <li
                key={`${it.label}-${i}`}
                className="bwc-stagger-item animate-bwc-fade-in group relative flex items-center gap-4 rounded-2xl border border-near-black/8 bg-cream-50 px-5 py-4 transition-all duration-standard ease-standard hover:-translate-y-0.5 hover:border-copper-300 hover:shadow-lg hover:shadow-copper-900/5"
                style={{ ['--stagger-index' as string]: i }}
              >
                <span
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-copper-100 text-copper-700 transition-colors duration-standard ease-standard group-hover:bg-copper-600 group-hover:text-cream"
                  aria-hidden
                >
                  <Icon className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <span className="font-serif text-sm sm:text-base text-near-black">
                  {it.label}
                </span>
              </li>
            )
          })}
        </ul>

        {overflow.length > 0 && (
          <p className="mt-8 text-sm text-warm-stone">
            Also includes: {overflow.map((o) => o.label).join(', ')}.
          </p>
        )}
      </div>
    </RevealOnView>
  )
}
