import type { BlockData } from '@/lib/cms/block-registry'

// Shared style tokens for the Posts widget (#6). Every visual choice is a
// PRESET mapped to theme-token-bound Tailwind classes — never raw hex/px. The
// card auto-contrasts the ancestor section surface (the `onDark` flag), so a
// posts widget dropped on a dark hero reads as cleanly as on a light page.

export type PostsTemplate = BlockData<'lx_posts'>['template']
export type CardStyle = BlockData<'lx_posts'>['cardStyle']
export type Spacing = BlockData<'lx_posts'>['spacing']
export type ImageAspect = BlockData<'lx_posts'>['imageAspect']
export type Columns = BlockData<'lx_posts'>['columns']

// Image aspect-ratio boxes — fixed-ratio wrappers so images reserve their
// space and never cause layout shift (CLS) while loading (#7).
export const ASPECT_CLASS: Record<ImageAspect, string> = {
  '16:9': 'aspect-[16/9]',
  '4:3': 'aspect-[4/3]',
  '3:2': 'aspect-[3/2]',
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
}

// Grid column counts → responsive Tailwind grid. 1 col stays single; 2–4 step
// up at sm/md/lg so a 4-up never crushes on mobile.
export const GRID_COLS: Record<Columns, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
}

// Inter-card gap by spacing preset.
export const GRID_GAP: Record<Spacing, string> = {
  tight: 'gap-5 sm:gap-6',
  comfortable: 'gap-8 sm:gap-10',
  airy: 'gap-12 sm:gap-14',
}

// Inner padding for the `cards` template's padded card body. Flat/list use no
// inner pad; soft/elevated cards do.
export const CARD_PAD: Record<Spacing, string> = {
  tight: 'p-4',
  comfortable: 'p-5 sm:p-6',
  airy: 'p-7 sm:p-8',
}

/** Card chrome by cardStyle preset, surface-aware. `flat` = no card (image +
 *  text only); `soft` = subtle tinted panel + radius; `elevated` = panel +
 *  soft shadow that lifts on hover. All theme-token-bound (champagne accent →
 *  --brand-accent; ivory/obsidian tints flip with the surface). */
export function cardChrome(style: CardStyle, onDark: boolean): string {
  if (style === 'flat') return ''
  const base = 'overflow-hidden rounded-2xl transition-all duration-standard ease-standard'
  const surface = onDark
    ? 'bg-ivory/[0.06]'
    : 'bg-cream-50/70'
  if (style === 'elevated') {
    return [
      base,
      surface,
      'shadow-[0_10px_40px_-18px_rgba(20,18,16,0.35)]',
      // Hover lift — disabled under reduced-motion via the motion-reduce: variant.
      'motion-safe:group-hover:-translate-y-1 motion-safe:group-hover:shadow-[0_18px_50px_-18px_rgba(20,18,16,0.45)]',
    ].join(' ')
  }
  // soft
  return [base, surface].join(' ')
}

/** The image-zoom hover treatment, reduced-motion-safe (no zoom when the user
 *  prefers reduced motion). Applied to the <img> inside the card group. */
export const IMAGE_HOVER_ZOOM =
  'motion-safe:transition-transform motion-safe:duration-standard motion-safe:ease-standard motion-safe:group-hover:scale-[1.03]'

// ── Surface-aware text tones (theme tokens; flip light↔dark) ──────────────
export function textTones(onDark: boolean) {
  return {
    heading: onDark ? 'text-ivory' : 'text-obsidian',
    title: onDark ? 'text-ivory' : 'text-obsidian',
    excerpt: onDark ? 'text-ivory/70' : 'text-warm-stone',
    meta: onDark ? 'text-ivory/60' : 'text-warm-stone',
    // Category pill — theme accent on light; ivory-tint on dark.
    pill: onDark
      ? 'bg-ivory/10 text-ivory ring-ivory/20 hover:bg-ivory/15'
      : 'bg-champagne/15 text-antique-gold ring-champagne/40 hover:bg-champagne/25',
    // Image fallback panel when a post has no hero image — a tasteful tinted
    // monogram surface, not a broken-image gap (#3).
    fallback: onDark
      ? 'bg-gradient-to-br from-ivory/[0.08] to-ivory/[0.02] text-ivory/30'
      : 'bg-gradient-to-br from-champagne/15 to-cream-50 text-antique-gold/40',
  }
}

// line-clamp utility class for a given clamp count (0 = no clamp). Tailwind
// ships line-clamp-1..6; 0 maps to no class.
export function clampClass(n: number): string {
  if (!n || n < 1) return ''
  return `line-clamp-${Math.min(6, Math.max(1, Math.floor(n)))}`
}

// Responsive `sizes` hint per column count, so the browser fetches the right
// srcset variant for a card that occupies 1/N of the row (protects bandwidth
// + LCP, #7). Approximate breakpoints matching GRID_COLS.
export function cardSizes(columns: Columns): string {
  switch (columns) {
    case 1:
      return '100vw'
    case 2:
      return '(min-width: 640px) 50vw, 100vw'
    case 3:
      return '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw'
    case 4:
      return '(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw'
    default:
      return '100vw'
  }
}
