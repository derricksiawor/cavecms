// Human-readable label for each `projects.status` enum value. The
// renderer needs these in three places (Hero badge fallback,
// FactsStrip cell, StickyHeader pill) — defining once keeps the
// translation surface in one spot when Tier 2E adds FR / Twi.
//
// Keys mirror the enum in db/schema/projects.ts so a typo here
// surfaces as a TS error, not silent fallback text.

export const STATUS_LABELS: Record<
  'coming_soon' | 'under_construction' | 'selling' | 'sold_out',
  string
> = {
  coming_soon: 'Coming Soon',
  under_construction: 'Under Construction',
  selling: 'Now Selling',
  sold_out: 'Sold Out',
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return ''
  return (
    STATUS_LABELS[status as keyof typeof STATUS_LABELS] ??
    status.replace(/_/g, ' ')
  )
}
