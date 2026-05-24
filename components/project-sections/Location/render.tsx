import type { ReactNode } from 'react'
import { MapPin, Navigation } from 'lucide-react'
import { RevealOnView } from '../_shared/RevealOnView'
import type { LocationData } from '../_shared/types'

// Location section — embedded Google Maps iframe (sandboxed) + an
// address card + nearby points-of-interest with drive-time pills.
//
// The map_embed_url is gated at the Zod boundary to ONLY accept
// https://www.google.com/maps/embed?... URLs — see
// lib/cms/project-section-registry.ts. The iframe is additionally
// sandboxed (no allow-top-navigation) so even if Google's embed
// served attacker content, it could not navigate the host.
//
// Renders nothing when there's no address AND no map AND no POIs.

export function LocationSection({ data }: { data: LocationData }): ReactNode {
  const hasAddress = !!data.address?.trim()
  const hasMap = !!data.map_embed_url
  const hasPois = data.points_of_interest.length > 0
  if (!hasAddress && !hasMap && !hasPois) return null

  return (
    <RevealOnView
      as="section"
      id="location"
      animation="slide-up"
      className="bg-cream-50 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
              The neighbourhood
            </p>
            <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
              Where it sits
            </h2>

            {hasAddress && (
              <div className="mt-8 rounded-2xl border border-near-black/8 bg-cream-50 p-6">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-copper-50 text-copper-700"
                  >
                    <MapPin className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
                      Address
                    </p>
                    <p className="mt-1 font-serif text-base sm:text-lg text-near-black whitespace-pre-line">
                      {data.address}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {hasPois && (
              <div className="mt-8">
                <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-warm-stone">
                  Nearby
                </p>
                <ul className="mt-4 divide-y divide-near-black/8 border-y border-near-black/8">
                  {data.points_of_interest.map((p, i) => (
                    <li
                      key={`${p.label}-${i}`}
                      className="flex items-center justify-between py-3"
                    >
                      <span className="flex items-center gap-3 font-serif text-base text-near-black">
                        <Navigation
                          className="h-3.5 w-3.5 text-copper-600"
                          strokeWidth={2}
                          aria-hidden
                        />
                        {p.label}
                      </span>
                      <span className="ml-3 inline-flex items-center rounded-full bg-cream-200 px-3 py-1 text-xs font-semibold text-near-black">
                        {p.drive_time_min} min drive
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="lg:col-span-7">
            {hasMap ? (
              <div className="overflow-hidden rounded-2xl border border-near-black/8 bg-cream-50 shadow-lg shadow-near-black/5">
                <iframe
                  src={data.map_embed_url}
                  title={`Map of ${data.address || 'the project'}`}
                  className="block h-[28rem] w-full border-0 sm:h-[32rem] lg:h-[36rem]"
                  referrerPolicy="no-referrer-when-downgrade"
                  loading="lazy"
                  // Locked-down iframe per project standards security gate.
                  // OMIT allow-top-navigation so the embed cannot
                  // navigate the parent even if attacker content is
                  // served through Maps. allow-scripts is needed for
                  // map interactivity; allow-same-origin is needed
                  // for Google's own cookies; allow-popups covers
                  // "Open in Maps" links.
                  sandbox="allow-scripts allow-same-origin allow-popups"
                />
              </div>
            ) : (
              // Empty-map placeholder. Stays minimal — a missing map
              // shouldn't hijack visual weight from a real address
              // panel.
              <div className="grid aspect-[4/3] place-items-center rounded-2xl border border-dashed border-near-black/15 bg-cream-100 text-warm-stone">
                <p className="px-6 text-center text-sm">
                  Map preview will appear here once the editor adds an embed
                  link.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </RevealOnView>
  )
}
