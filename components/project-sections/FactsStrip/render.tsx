import type { ReactNode } from 'react'
import { MapPin, Home, Coins, CalendarClock, BadgeCheck } from 'lucide-react'
import { statusLabel } from '../_shared/labels'
import { formatPriceRange } from '../_shared/currency'
import type { PricingData } from '../_shared/types'

// Page-level chrome — sits between Hero and the section dispatcher
// loop. Each cell is derived from the project row + the pricing
// section payload, NOT from any single dispatched section. The
// strip degrades cell-by-cell: any cell with no source data simply
// drops out (so a project with no pricing or no handover ETA still
// gets a clean 2- or 3-cell strip).
//
// The cell layout uses CSS grid; on mobile the strip becomes a
// horizontally-scrollable rail so 4-5 cells stay readable without
// crushing the typography.

interface FactsStripProps {
  status: string
  location: string | null
  pricing: PricingData | null
}

interface Cell {
  label: string
  value: string
  Icon: typeof MapPin
}

function unitsLabel(p: PricingData): string | null {
  if (typeof p.units_total !== 'number') return null
  if (typeof p.units_remaining === 'number') {
    return `${p.units_remaining} of ${p.units_total} remaining`
  }
  return `${p.units_total} ${p.units_total === 1 ? 'unit' : 'units'}`
}

export function FactsStripSection({
  status,
  location,
  pricing,
}: FactsStripProps): ReactNode {
  const cells: Cell[] = []

  const statusText = statusLabel(status)
  if (statusText) {
    cells.push({ label: 'Status', value: statusText, Icon: BadgeCheck })
  }
  if (location) {
    cells.push({ label: 'Location', value: location, Icon: MapPin })
  }
  if (pricing) {
    const units = unitsLabel(pricing)
    if (units) cells.push({ label: 'Availability', value: units, Icon: Home })
    const price = formatPriceRange(pricing)
    if (price) cells.push({ label: 'Pricing', value: price, Icon: Coins })
    if (pricing.handover_eta && pricing.handover_eta.trim()) {
      cells.push({
        label: 'Handover',
        value: pricing.handover_eta.trim(),
        Icon: CalendarClock,
      })
    }
  }

  if (cells.length === 0) return null

  // FactsStrip sits directly under the hero — it's typically in-view
  // on first paint at desktop widths. Wrapping in RevealOnView would
  // delay paint by one IntersectionObserver tick, producing a brief
  // blank strip after the hero entrance settles. Render with a plain
  // CSS fade-in instead so it arrives in lockstep with the hero.
  return (
    <section
      className="animate-bwc-fade-in border-y border-near-black/8 bg-cream/95 backdrop-blur supports-[backdrop-filter]:bg-cream/80"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
        <ul
          // Horizontal scroll on mobile so 5 cells don't squeeze. The
          // snap-x ensures each cell aligns crisply when swiped. Grid
          // mode takes over at md so all cells render full-width.
          className="-mx-4 flex snap-x snap-mandatory gap-0 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:mx-0 md:grid md:auto-cols-fr md:grid-flow-col md:gap-0 md:overflow-visible md:px-0"
        >
          {cells.map((c, i) => (
            <li
              key={c.label}
              className={[
                'flex min-w-[68vw] snap-start items-center gap-4 py-6 pr-6 sm:min-w-[44vw] md:min-w-0',
                'md:px-6 md:py-7',
                // Hairline divider between cells. Hidden on mobile
                // scroll because the gap collapses to a single cell
                // anyway.
                i > 0
                  ? 'md:border-l md:border-near-black/10'
                  : '',
              ].join(' ')}
            >
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-copper-50 text-copper-700"
                aria-hidden
              >
                <c.Icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
                  {c.label}
                </p>
                <p className="mt-1 truncate font-serif text-base sm:text-lg text-near-black">
                  {c.value}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
