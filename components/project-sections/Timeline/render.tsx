import type { ReactNode } from 'react'
import { MediaImg } from '@/components/blocks/MediaImg'
import { RevealOnView } from '../_shared/RevealOnView'
import type { MediaMap, TimelineData } from '../_shared/types'

// Vertical construction-progress timeline. Each entry: copper dot on
// a vertical line, formatted date, milestone title, optional body
// richtext, optional photo. Whole list cascade-staggers in via
// .cavecms-stagger-item.
//
// The schema enforces ISO date strings (YYYY-MM-DD) at the Zod
// gate, so the formatter below trusts the format. Locale-aware
// formatting; falls back to the raw string if Date parsing fails
// (defensive — covers edge cases like a future schema change).

function formatDate(raw: string): string {
  // Treat the input as a date-only (no timezone shift). Parsing
  // 'YYYY-MM-DD' via `new Date()` lands at UTC midnight which can
  // shift a day in negative timezones; explicit construction from
  // parts avoids that gotcha.
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return raw
  const [, y, mo, d] = m
  const dt = new Date(Number(y), Number(mo) - 1, Number(d))
  if (Number.isNaN(dt.getTime())) return raw
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export function TimelineSection({
  data,
  media,
}: {
  data: TimelineData
  media: MediaMap
}): ReactNode {
  if (data.entries.length === 0) return null

  return (
    <RevealOnView
      as="section"
      id="timeline"
      animation="slide-up"
      className="bg-cream py-20 sm:py-28"
    >
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        <div className="text-center max-w-3xl mx-auto">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Project progress
          </p>
          <h2 className="mt-4 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
            From groundbreaking to handover
          </h2>
        </div>

        <ol className="relative mt-16 space-y-12 pl-10 sm:pl-16">
          {/* Continuous copper line behind the dots. Pinned to the
              left so the content can sit to the right of the rail
              at every viewport. */}
          <span
            aria-hidden
            className="absolute left-3 top-1.5 bottom-1.5 w-px bg-gradient-to-b from-copper-300 via-copper-400 to-copper-300 sm:left-5"
          />
          {data.entries.map((e, i) => (
            <li
              key={`${e.date}-${i}`}
              className="cavecms-stagger-item animate-cavecms-slide-up relative"
              style={{ ['--stagger-index' as string]: i }}
            >
              {/* Dot on the rail */}
              <span
                aria-hidden
                className="absolute -left-[1.625rem] top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-copper-600 ring-4 ring-cream sm:-left-[2.875rem]"
              >
                <span className="block h-1.5 w-1.5 rounded-full bg-cream" />
              </span>

              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-700">
                {formatDate(e.date)}
              </p>
              <h3 className="mt-2 font-serif text-xl sm:text-2xl font-semibold tracking-tight text-near-black">
                {e.title}
              </h3>
              {e.body_richtext?.trim() && (
                <div
                  className="prose mt-3 max-w-none prose-p:text-warm-stone prose-p:leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: e.body_richtext }}
                />
              )}
              {e.photo && (
                <div className="mt-5 overflow-hidden rounded-2xl border border-near-black/8 bg-cream-50 shadow-md shadow-near-black/5">
                  <MediaImg
                    media={media.get(e.photo.media_id)}
                    alt={e.photo.alt}
                    variant="md"
                    className="block aspect-[16/9] w-full object-cover"
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </RevealOnView>
  )
}
