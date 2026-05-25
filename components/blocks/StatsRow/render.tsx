'use client'
import clsx from 'clsx'
import { useCountUp } from '../Counter/useCountUp'
import type { BlockData } from '@/lib/cms/block-registry'
import type { InlineEditContext } from '@/lib/cms/inlineEditableFields'

// Elementor parity: Counter (single tile) + Stats Row (multi-counter
// row). CaveCMS merges them into ONE block_type `stats_row` because the
// renderer dispatches purely on `items.length` + `layout` - the
// schema doesn't change between the two picker entry points.
//
// Picker mapping (lib/cms/blockSeeds.ts):
//   - "Counter"  -> seeds items:[1] + layout:'solo' (single tile)
//   - "Stats Row" -> seeds items:[3] + layout:'3up'  (canonical 3-up)
// Both POST `blockType: 'stats_row'`; the operator can convert one
// into the other by changing items + layout via the drawer.
//
// Animation:
//   - Each tile runs its own useCountUp instance (Counter/useCountUp.ts).
//   - Stagger: tile `i` waits i * 120ms after viewport entry before
//     starting its RAF loop - matches the researcher's "120ms
//     stagger" finding for luxury-real-estate counters.
//   - prefers-reduced-motion short-circuits to the final value
//     immediately (handled inside useCountUp).
//
// SEO/no-JS:
//   - Initial render shows 0 for each tile (state default before the
//     observer fires). The surrounding `label` carries the SEO
//     weight - "120 Residences" reads correctly even if the digit
//     never animates because the visitor's JS is off.
//
// Reference URLs:
//   - https://elementor.com/help/counter-widget/
//   - https://ultimateelementor.com/widgets/counter/

type StatsRowData = BlockData<'stats_row'>
type StatsRowItem = StatsRowData['items'][number]

const LAYOUT_GRID: Record<StatsRowData['layout'], string> = {
  // solo = single centred tile; not a grid.
  solo: 'flex flex-col items-center text-center',
  '2up': 'grid grid-cols-1 sm:grid-cols-2 gap-8 sm:gap-10',
  '3up': 'grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-10',
  '4up': 'grid grid-cols-2 md:grid-cols-4 gap-6 sm:gap-10',
}

const STAGGER_MS = 120

function CounterTile({
  item,
  index,
  isSolo,
  disabled,
}: {
  item: StatsRowItem
  index: number
  isSolo: boolean
  disabled: boolean
}) {
  const { value, ref } = useCountUp(item.value, item.duration_ms, {
    staggerMs: index * STAGGER_MS,
    disabled,
  })
  // Format with thousand separators for any value >= 1000. Locale
  // 'en-US' is consistent across SSR + client (no locale negotiation
  // mismatches that would hydrate inconsistently).
  const display = value >= 1000 ? value.toLocaleString('en-US') : `${value}`
  // Crawler / no-JS / screen-reader fallback string. The animated
  // `display` shows the climb (initially 0 on SSR + first paint);
  // the sr-only fallback below carries the FINAL value as accessible
  // text so SEO and assistive tech read "120 Residences" regardless
  // of whether the count-up animation ever runs.
  const targetDisplay =
    item.value >= 1000 ? item.value.toLocaleString('en-US') : `${item.value}`
  const accessibleLabel = `${item.prefix ?? ''}${targetDisplay}${item.suffix ?? ''}`
  return (
    <div
      ref={ref}
      className={clsx(
        'flex flex-col gap-2',
        isSolo ? 'items-center text-center' : 'items-start text-left sm:items-center sm:text-center',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'font-serif font-semibold leading-none tracking-tight text-copper-500',
          // Solo gets the hero-sized digit; multi-up uses a moderate
          // size so 4-up rows don't blow out on mobile.
          isSolo
            ? 'text-6xl sm:text-7xl'
            : 'text-4xl sm:text-5xl',
        )}
      >
        {item.prefix}
        {display}
        {item.suffix}
      </span>
      {/* Visually-hidden but accessible final value. Always reads the
          target so crawlers + screen readers + no-JS visitors see
          "120" not "0". The visible <span> above is aria-hidden so
          assistive tech doesn't double-announce. */}
      <span className="sr-only">{accessibleLabel}</span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone">
        {item.label}
      </span>
      {item.helper_text && (
        <span className="text-xs text-warm-stone/80">{item.helper_text}</span>
      )}
    </div>
  )
}

export function StatsRow({
  data,
  inlineEdit,
  outerClass,
}: {
  data: StatsRowData
  inlineEdit?: InlineEditContext
  outerClass?: string
}) {
  if (data.items.length === 0) return null
  const isSolo = data.layout === 'solo'
  // In edit mode, skip the count-up animation entirely so the
  // operator sees the final value while tweaking knobs in the
  // drawer. Otherwise every keystroke (value / duration_ms / etc.)
  // would restart the climb-from-zero and the operator can't
  // preview the actual rendered figure.
  const disabled = Boolean(inlineEdit)
  // Solo collapses to a single tile regardless of how many items the
  // operator added (defensive - drawer UI should also keep solo
  // synced with items.length===1, but render is forgiving).
  const items = isSolo ? data.items.slice(0, 1) : data.items
  return (
    <section
      className={clsx(
        'py-16 sm:py-20 px-4 sm:px-6 max-w-6xl mx-auto',
        outerClass,
      )}
    >
      <div className={LAYOUT_GRID[data.layout]}>
        {items.map((item, i) => (
          <CounterTile
            // Key by position only - useCountUp's internal reset
            // effect handles `target` / `durationMs` changes via
            // useState, no need to force a React remount per
            // keystroke (which would tear down the observer/RAF
            // and animate from 0 again on every typed digit).
            key={i}
            item={item}
            index={i}
            isSolo={isSolo}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  )
}
