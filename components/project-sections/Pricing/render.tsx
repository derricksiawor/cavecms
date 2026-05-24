import type { ReactNode } from 'react'
import { CalendarClock, ArrowUpRight } from 'lucide-react'
import { RevealOnView } from '../_shared/RevealOnView'
import { formatMoney } from '../_shared/currency'
import type { PricingData } from '../_shared/types'

// Three display modes per spec:
//   'range'    — large min / max numbers, copper accent
//   'per_unit' — value_richtext is the per-unit body (rendered as
//                 prose); the floor-plans section carries the
//                 per-type breakdown separately
//   'contact'  — large CTA "Schedule a private viewing"
//
// units_total + units_remaining + handover_eta render as captions
// regardless of display mode (when present), since they're useful
// for the buyer in any pricing posture.

export function PricingSection({ data }: { data: PricingData }): ReactNode {
  // Render nothing when ALL renderable surfaces are empty —
  // including the empty 'contact'-mode seed, where admin has not
  // customised anything yet. Without this, a freshly-created project
  // renders a full near-black band with a generic "private viewing"
  // CTA before admin has filled the page in, which looks like the
  // section is the WHOLE page rather than an empty one.
  const hasBody = !!data.value_richtext?.trim()
  const hasPrice =
    typeof data.price_min === 'number' || typeof data.price_max === 'number'
  const hasUnits = typeof data.units_total === 'number'
  const hasHandover = !!data.handover_eta?.trim()
  // Collapse to null when ALL renderable surfaces are empty — applies
  // uniformly to every display mode including the 'contact' seed.
  // Without this, a freshly-created project renders a full near-black
  // band with a generic "private viewing" CTA before admin has
  // populated anything, which dominates the page visually.
  if (!hasBody && !hasPrice && !hasUnits && !hasHandover) return null

  const currency = data.price_currency || 'USD'

  return (
    <RevealOnView
      as="section"
      id="pricing"
      animation="slide-up"
      className="bg-near-black py-20 sm:py-28 text-cream"
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-300">
          Investment
        </p>
        <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-cream">
          Pricing &amp; availability
        </h2>

        {data.display === 'range' && hasPrice && (
          <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-10">
            {typeof data.price_min === 'number' && (
              <div className="flex flex-col items-center sm:items-end">
                <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-cream/60">
                  Starting at
                </p>
                <p className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-semibold text-copper-300">
                  {formatMoney(data.price_min, currency)}
                </p>
              </div>
            )}
            {typeof data.price_max === 'number' &&
              data.price_max !== data.price_min && (
                <div className="flex flex-col items-center sm:items-start">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-cream/60">
                    Up to
                  </p>
                  <p className="mt-3 font-serif text-4xl sm:text-5xl md:text-6xl font-semibold text-cream">
                    {formatMoney(data.price_max, currency)}
                  </p>
                </div>
              )}
          </div>
        )}

        {data.display === 'per_unit' && hasBody && (
          <div
            className="prose prose-invert mx-auto mt-10 max-w-3xl prose-p:text-cream/85 prose-strong:text-cream prose-headings:font-serif prose-headings:text-cream"
            dangerouslySetInnerHTML={{ __html: data.value_richtext }}
          />
        )}

        {data.display === 'contact' && (
          <div className="mt-10">
            {hasBody ? (
              <div
                className="prose prose-invert mx-auto max-w-2xl prose-p:text-cream/85"
                dangerouslySetInnerHTML={{ __html: data.value_richtext }}
              />
            ) : (
              <p className="mx-auto max-w-2xl text-base sm:text-lg text-cream/80 leading-relaxed">
                This residence is offered through private appointment. Reach
                out to our sales team for a bespoke walkthrough and full
                pricing.
              </p>
            )}
            <a
              href="#inquiry-form"
              className="mt-10 inline-flex items-center gap-2 rounded-full bg-copper-500 px-8 py-4 text-sm font-semibold tracking-wide text-near-black transition-all duration-standard ease-standard hover:bg-copper-400 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-copper-900/30 min-h-[44px]"
            >
              Schedule a private viewing
              <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
            </a>
          </div>
        )}

        {data.display === 'range' && hasBody && (
          <div
            className="prose prose-invert mx-auto mt-10 max-w-2xl prose-p:text-cream/75"
            dangerouslySetInnerHTML={{ __html: data.value_richtext }}
          />
        )}

        {/* Caption rail — units + handover ETA. Renders below every
           display mode when present. */}
        {(typeof data.units_total === 'number' || data.handover_eta) && (
          <ul className="mt-12 inline-flex flex-wrap items-center justify-center gap-x-8 gap-y-3 border-t border-cream/15 pt-6">
            {typeof data.units_total === 'number' && (
              <li className="text-sm text-cream/70">
                {typeof data.units_remaining === 'number' ? (
                  <>
                    <span className="font-semibold text-cream">
                      {data.units_remaining}
                    </span>{' '}
                    of {data.units_total} units remaining
                  </>
                ) : (
                  <>
                    {data.units_total}{' '}
                    {data.units_total === 1 ? 'unit' : 'units'} in this
                    collection
                  </>
                )}
              </li>
            )}
            {data.handover_eta && (
              <li className="inline-flex items-center gap-2 text-sm text-cream/70">
                <CalendarClock
                  className="h-4 w-4 text-copper-300"
                  strokeWidth={1.75}
                  aria-hidden
                />
                Handover {data.handover_eta}
              </li>
            )}
          </ul>
        )}
      </div>
    </RevealOnView>
  )
}
