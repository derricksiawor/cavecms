import clsx from 'clsx'
import { Star } from 'lucide-react'
import type { BlockData } from '@/lib/cms/block-registry'

// Elementor-parity Star Rating widget. Canonical fields per
// `includes/widgets/star-rating.php`:
//   - rating_scale (5 | 10) — CaveCMS ships 5 only; the 10-scale is rare
//     in luxury real-estate and would force layout reflow.
//   - rating (decimal allowed — e.g. 4.5)
//   - title (optional label, e.g. "Client Rating")
//   - icon (FA star | Unicode ★) — CaveCMS uses lucide Star; one source.
//   - unmarked_style (Solid | Outline) — CaveCMS always outline (the
//     researcher's luxury default).
//   - alignment, stars_color, unmarked_color, stars_size, stars_gap
//
// Half-star math: round to NEAREST 0.5 (Math.round(value * 2) / 2).
//   3.49 -> Math.round(6.98)/2 = 3.5
//   3.51 -> Math.round(7.02)/2 = 3.5
//   3.99 -> Math.round(7.98)/2 = 4.0
//   3.25 -> Math.round(6.5)/2  = 3.5 (banker's rounding to .5)
// Stored value is preserved — only the visual rounds. "4.7 (412
// reviews)" reads accurately in the label/count even though the
// star bar shows 4.5.
//
// Reference URLs:
//   - https://elementor.com/help/star-rating-widget/
//   - https://github.com/elementor/elementor/blob/main/includes/widgets/star-rating.php

type StarRatingData = BlockData<'star_rating'>

const SIZE_CLASS: Record<
  StarRatingData['size'],
  { star: string; text: string; gap: string }
> = {
  sm: { star: 'h-4 w-4', text: 'text-xs', gap: 'gap-1' },
  md: { star: 'h-5 w-5', text: 'text-sm', gap: 'gap-1.5' },
  lg: { star: 'h-6 w-6', text: 'text-base', gap: 'gap-2' },
}

const ALIGN_CLASS: Record<StarRatingData['alignment'], string> = {
  left: 'justify-start',
  center: 'justify-center',
  right: 'justify-end',
}

// Visual state of each of the 5 stars. `full` = solid copper Star;
// `half` = copper Star with the right half clipped (CSS inset);
// `empty` = outline-only copper-tinted star.
type StarState = 'full' | 'half' | 'empty'

function starStateForPosition(rounded: number, index: number): StarState {
  if (rounded >= index + 1) return 'full'
  if (rounded >= index + 0.5) return 'half'
  return 'empty'
}

export function StarRating({
  data,
  outerClass,
}: {
  data: StarRatingData
  outerClass?: string
}) {
  // Clamp first - schema bounds 0..5 but Zod's `.number()` allows
  // out-of-bounds before parse if parsing was bypassed. Defensive
  // clamp guarantees rendered visual matches the rendered numeric.
  const clamped = Math.max(0, Math.min(5, data.value))
  // Round to nearest 0.5. Math.round(x * 2) / 2 is the canonical form.
  const rounded = Math.round(clamped * 2) / 2
  const sizeClasses = SIZE_CLASS[data.size]
  const alignClass = ALIGN_CLASS[data.alignment]

  // a11y label: announce "4.5 out of 5 stars" rather than "filled
  // filled filled filled half" - matches WAI-ARIA Authoring Practices
  // for ratings. Wrapped in role="img" with aria-label to keep
  // screen readers from announcing 5 separate <Star> elements.
  const a11yLabel = `${rounded} out of 5 stars`

  return (
    <section
      className={clsx(
        'py-12 sm:py-16 px-4 sm:px-6 max-w-4xl mx-auto',
        outerClass,
      )}
    >
      <div
        className={clsx(
          'flex flex-wrap items-center',
          sizeClasses.gap,
          alignClass,
        )}
      >
        {data.label && (
          <span className={clsx('font-semibold text-near-black', sizeClasses.text)}>
            {data.label}
          </span>
        )}
        <span
          role="img"
          aria-label={a11yLabel}
          className={clsx('inline-flex items-center', sizeClasses.gap)}
        >
          {[0, 1, 2, 3, 4].map((i) => {
            const state = starStateForPosition(rounded, i)
            return (
              <span
                key={i}
                aria-hidden="true"
                className="relative inline-block"
              >
                {/* outline base - always rendered so the row keeps
                    its full width regardless of fill state */}
                <Star
                  strokeWidth={1.5}
                  className={clsx(
                    sizeClasses.star,
                    'text-copper-400/30',
                  )}
                />
                {/* fill overlay - clipped to a fraction depending on
                    state. Position absolute so it sits exactly on top
                    of the outline; clipPath hides the right half for
                    half-stars. */}
                {state !== 'empty' && (
                  <Star
                    strokeWidth={1.5}
                    fill="currentColor"
                    className={clsx(
                      'absolute inset-0',
                      sizeClasses.star,
                      'text-copper-500',
                    )}
                    style={
                      state === 'half' ? { clipPath: 'inset(0 50% 0 0)' } : undefined
                    }
                  />
                )}
              </span>
            )
          })}
        </span>
        <span className={clsx('text-near-black', sizeClasses.text)}>
          {/* Display the STORED value (clamped to 0..5) - the stars
              themselves snap to the nearest 0.5 visually but the
              numeric label must reflect operator input so "4.7 / 5"
              reads accurately when the bar shows 4.5 stars. */}
          {clamped.toFixed(1)}
        </span>
        {typeof data.review_count === 'number' && data.review_count > 0 && (
          <span className={clsx('text-warm-stone', sizeClasses.text)}>
            ({data.review_count.toLocaleString()} reviews)
          </span>
        )}
      </div>
    </section>
  )
}
