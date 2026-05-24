// Single source of truth for Chunk E's per-side spacing tier → Tailwind
// utility-class lookup. The schema layer (lib/cms/blockMeta.ts), the
// render-class derivation (lib/cms/spacingClasses.ts), and the editor
// UI (components/inline-edit/SpacingStepper.tsx, SpacingPopover.tsx)
// all read from this file — drift between meta values, rendered CSS,
// and the editor stepper labels is mechanical, not silent.
//
// !-important is REQUIRED. Tailwind v4 emits responsive variants AFTER
// base utilities in source order. Without `!`, a widget's natural
// `py-12 sm:py-16` would win over an operator's per-side `pt-0` at the
// ≥sm breakpoint (sm:py-16 is generated later → applies at sm). The
// `!` prefix raises the override to !important so it beats the natural
// padding at every breakpoint without having to generate matching
// responsive variants per tier (which would 7× the class surface).
//
// Tier scale chosen for parity with Webflow / Elementor defaults:
//
//   none = 0     (0 px)         — explicit "off"
//   xs   = 2     (8 px)         — tight gutter
//   sm   = 4     (16 px)        — small inset
//   md   = 8     (32 px)        — comfortable default
//   lg   = 16    (64 px)        — section-level breathing room
//   xl   = 24    (96 px)        — generous vertical rhythm
//   2xl  = 32    (128 px)       — feature-section hero-adjacent
//
// Static literal strings (NOT computed `${prefix}${value}`) so Tailwind
// v4's JIT scanner sees every class at build time. A computed string
// would silently drop classes from the generated stylesheet.

export const SPACING_TIERS = [
  'none',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
] as const

export type SpacingTier = (typeof SPACING_TIERS)[number]

export type SpacingSide = 'top' | 'right' | 'bottom' | 'left'

// Human-friendly labels for the SpacingStepper readout. Keep
// 1–3 chars so the stepper tier label fits comfortably between the
// 44×44 up/down buttons without crowding.
export const SPACING_TIER_LABEL: Record<SpacingTier, string> = {
  none: 'None',
  xs: 'XS',
  sm: 'S',
  md: 'M',
  lg: 'L',
  xl: 'XL',
  '2xl': '2XL',
}

// pt/pr/pb/pl × 7 tiers. Static literals — Tailwind JIT detects them.
export const PADDING_TIER_CLASS: Record<SpacingSide, Record<SpacingTier, string>> = {
  top: {
    none: '!pt-0',
    xs: '!pt-2',
    sm: '!pt-4',
    md: '!pt-8',
    lg: '!pt-16',
    xl: '!pt-24',
    '2xl': '!pt-32',
  },
  right: {
    none: '!pr-0',
    xs: '!pr-2',
    sm: '!pr-4',
    md: '!pr-8',
    lg: '!pr-16',
    xl: '!pr-24',
    '2xl': '!pr-32',
  },
  bottom: {
    none: '!pb-0',
    xs: '!pb-2',
    sm: '!pb-4',
    md: '!pb-8',
    lg: '!pb-16',
    xl: '!pb-24',
    '2xl': '!pb-32',
  },
  left: {
    none: '!pl-0',
    xs: '!pl-2',
    sm: '!pl-4',
    md: '!pl-8',
    lg: '!pl-16',
    xl: '!pl-24',
    '2xl': '!pl-32',
  },
}

// mt/mr/mb/ml × 7 tiers. Same shape as padding.
export const MARGIN_TIER_CLASS: Record<SpacingSide, Record<SpacingTier, string>> = {
  top: {
    none: '!mt-0',
    xs: '!mt-2',
    sm: '!mt-4',
    md: '!mt-8',
    lg: '!mt-16',
    xl: '!mt-24',
    '2xl': '!mt-32',
  },
  right: {
    none: '!mr-0',
    xs: '!mr-2',
    sm: '!mr-4',
    md: '!mr-8',
    lg: '!mr-16',
    xl: '!mr-24',
    '2xl': '!mr-32',
  },
  bottom: {
    none: '!mb-0',
    xs: '!mb-2',
    sm: '!mb-4',
    md: '!mb-8',
    lg: '!mb-16',
    xl: '!mb-24',
    '2xl': '!mb-32',
  },
  left: {
    none: '!ml-0',
    xs: '!ml-2',
    sm: '!ml-4',
    md: '!ml-8',
    lg: '!ml-16',
    xl: '!ml-24',
    '2xl': '!ml-32',
  },
}

// Named endpoint constants so consumers (SpacingStepper's disable
// check, stepTier's clamp) compare against a named tier rather than
// an array index lookup with non-null assertion. The tuple is `as const`
// with 7 fixed entries; these constants are statically true.
export const FIRST_TIER: SpacingTier = 'none'
export const LAST_TIER: SpacingTier = '2xl'

// Type guard for the read-boundary parsers. A persisted meta blob
// can carry arbitrary JSON; the parsers reject anything that isn't
// a known tier string.
const SPACING_TIER_SET: ReadonlySet<string> = new Set(SPACING_TIERS)
export function isSpacingTier(v: unknown): v is SpacingTier {
  return typeof v === 'string' && SPACING_TIER_SET.has(v)
}

// Step in a tier-ordered direction. Used by SpacingStepper's
// up/down buttons + the keyboard arrow handlers. Out-of-range steps
// clamp to the endpoints (no wrap-around — Wix/Webflow precedent).
export function stepTier(current: SpacingTier, dir: 1 | -1): SpacingTier {
  const idx = SPACING_TIERS.indexOf(current)
  const next = idx + dir
  if (next < 0) return FIRST_TIER
  if (next >= SPACING_TIERS.length) return LAST_TIER
  return SPACING_TIERS[next] ?? FIRST_TIER
}
