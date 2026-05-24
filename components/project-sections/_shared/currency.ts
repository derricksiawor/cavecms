// Currency formatters shared by Pricing + FactsStrip. Both renderers
// previously held an identical Intl.NumberFormat wrapper plus
// formatPriceRange; the duplication was already drifting between
// the two files (fallback path differed by one branch). Single
// source of truth eliminates the drift and the maintenance tax.
//
// `formatMoney` defends against an adversarial currency code at
// render time. The Zod schema (lib/cms/project-section-registry.ts:84)
// already gates writes to `^[A-Z]{3}$`, so this try/catch only fires
// if a future schema loosen lets a non-ISO code reach the renderer.
//
// `formatPriceRange` returns null in 'contact' display mode (no
// numeric pricing is rendered) and otherwise stitches min/max into a
// human range string. Callers decide whether to render the empty
// case at all.

interface PriceFields {
  display: 'range' | 'per_unit' | 'contact'
  price_min?: number
  price_max?: number
  price_currency?: string
}

export function formatMoney(value: number, currencyCode: string): string {
  const cur = currencyCode.toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: 0,
    }).format(value)
  } catch {
    // Defensive fallback for non-ISO codes — renders "USD 1,200,000"
    // style with the code prefixed. Mirrors Pricing's prior in-file
    // fallback; FactsStrip previously rendered bare digits on a bad
    // code (no prefix) and is intentionally upgraded here so the
    // user sees the currency context even when Intl can't format it.
    return `${cur} ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)}`
  }
}

export function formatPriceRange(p: PriceFields): string | null {
  if (p.display === 'contact') return null
  const cur = p.price_currency || 'USD'
  const min = typeof p.price_min === 'number' ? formatMoney(p.price_min, cur) : null
  const max = typeof p.price_max === 'number' ? formatMoney(p.price_max, cur) : null
  if (min && max) return `${min} – ${max}`
  if (min) return `From ${min}`
  if (max) return `Up to ${max}`
  return null
}
