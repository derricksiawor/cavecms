// Single source of truth for pill-shaped surface styling. Consumed
// by PillButton (the canonical clickable pill) AND any other element
// that needs to render the same pill chrome with a different semantic
// element — most notably the public admin bar's BarLink (a Next Link
// that visually IS the pill but cannot share PillButton's <button>
// element).
//
// Adding a new variant or size here ripples into every consumer
// automatically. Drift between callsites is impossible.

export type PillVariant = 'subtle' | 'filled' | 'destructive' | 'ghost' | 'bar'
export type PillSize = 'sm' | 'md' | 'lg' | 'bar'

export const PILL_BASE =
  'inline-flex w-fit items-center justify-center rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/40 motion-reduce:transition-none'

export const VARIANT_CLASS: Record<PillVariant, string> = {
  // Subtle: bordered, transparent fill, hovers to copper border. The
  // workhorse for non-destructive row actions ("Restore", "Open",
  // "Mark contacted", etc.) on the cream admin surface.
  subtle:
    'border border-warm-stone/25 text-warm-stone hover:border-copper-400 hover:text-near-black',
  // Filled: solid near-black background, cream text. Primary bulk
  // actions and confirm-modal CTAs.
  filled:
    'bg-near-black text-cream-50 shadow-[0_14px_30px_-16px_rgba(5,5,5,0.6)] hover:bg-copper-700',
  // Destructive: copper background, irreversible-ish bulk actions
  // (Move to Trash, Disable, etc.).
  destructive:
    'bg-copper-700 text-cream-50 shadow-[0_14px_30px_-16px_rgba(196,124,68,0.7)] hover:bg-copper-800',
  // Ghost: no border, text + hover halo. Kebab trigger and other
  // low-emphasis controls on cream-bg surfaces.
  ghost:
    'text-warm-stone hover:bg-warm-stone/10 hover:text-near-black',
  // Bar: ghost-style transparent surface tuned for use ON the dark
  // public-side admin bar (bg-near-black). Cream-on-dark default,
  // copper-on-faint-cream hover. Only valid paired with size 'bar'
  // — the height/padding floor is in the bar size class. Never used
  // on cream-bg surfaces. Forced-colors override keeps the pill
  // legible in Windows High Contrast / "Increase contrast" modes
  // where the cream/copper palette collapses to OS colours.
  bar:
    'text-cream-50/85 hover:bg-cream-50/10 hover:text-copper-200 focus-visible:ring-copper-400/60 forced-colors:text-CanvasText forced-colors:border forced-colors:border-CanvasText',
}

export const SIZE_CLASS: Record<PillSize, string> = {
  // sm = compact row-action pill (~22px tall). Matches the existing
  // table cell density.
  sm: 'gap-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]',
  // md = bulk-action bar pill (~32px tall).
  md: 'gap-2 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.22em]',
  // lg = primary CTA (Confirm Modal).
  lg: 'gap-2 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em]',
  // bar = admin bar pill. min-h floors at the bar height (44px
  // mobile per project standards touch-target floor / 40px md+) so the pill
  // fills the bar vertically; horizontal padding kept compact for
  // WP-style density. `py` keeps a hair of breathing room around
  // icon+label combos. Only valid paired with VARIANT_CLASS.bar.
  bar: 'gap-1.5 px-3 py-1 md:py-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] min-h-[44px] md:min-h-[40px]',
}

// Icon size paired with each pill size (lucide pixel).
export const ICON_SIZE: Record<PillSize, number> = {
  sm: 12,
  md: 13,
  lg: 14,
  bar: 13,
}
