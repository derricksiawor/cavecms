// Class-set map for the public site footer, mirroring lib/cms/headerTheme.ts.
// The footer was hardcoded to a single dark (near-black) palette; this
// lets the operator pick a footer theme in Settings → Footer the same
// way they pick a header theme, so a light-themed site can carry a
// light footer instead of an always-dark one.
//
// Each theme covers EVERY foreground/background pair the footer renders
// — surface, the logo filter, the three muted text tiers, the copper
// accent headings, link rest/hover, and the divider border — so no
// element disappears against its own background on any theme.
//
// Class strings are STATIC literals (no template interpolation) so
// Tailwind's JIT scanner emits every utility at build time.
//
// Theme tokens MIRROR lib/cms/headerTheme.ts: surfaces + accents route
// through the brand-linked utilities (obsidian → --brand-surface-dark,
// ivory → --brand-surface-light, champagne → --brand-accent) so a change
// in Settings → Theme re-skins the footer the same way it re-skins the
// header. Previously the default 'obsidian' footer used the LEGACY static
// palette (near-black + cream-50 + copper-400), which is hard-pinned hex
// and ignored the brand palette — that was the "theme doesn't affect the
// footer" gap. A default install stays visually ~identical because the
// brand defaults equal the luxury hex (surface-dark #050505 == near-black;
// surface-light #F5F1EA ≈ cream-50; accent #C9A961 is the header's gold).

export type FooterTheme = 'cream' | 'obsidian' | 'ivory' | 'champagne' | 'bone'

export interface FooterThemeClasses {
  /** Footer wrapper: background + base text colour. */
  surface: string
  /** Applied to the <img> logo. Dark themes invert a dark logo to read
   *  light; light themes leave it as-authored. */
  logoFilter: string
  /** Secondary text — tagline, newsletter body. */
  muted: string
  /** Tertiary text — hours, copyright row, "unavailable" notes. */
  subtle: string
  /** Footer-column link rest state. */
  strong: string
  /** Footer-column + legal link hover → full-strength foreground. */
  strongHover: string
  /** Copper accent — newsletter + column headings (eyebrows). */
  accent: string
  /** Address-link hover accent. */
  linkHover: string
  /** Divider border above the copyright row. */
  border: string
  /** Newsletter email <input>: bg + border + text + placeholder + focus.
   *  Per-theme so the field stays legible on light AND dark footers (the
   *  form was previously hard-pinned to the dark palette and broke on the
   *  light footer themes). */
  field: string
  /** Newsletter submit button — accent fill, mirroring headerTheme.ts `cta`
   *  for the matching theme so the footer CTA tracks the brand accent the
   *  same way the header's primary button does. */
  cta: string
}

export const FOOTER_THEMES: Record<FooterTheme, FooterThemeClasses> = {
  // Default dark footer — now brand-linked (mirrors headerTheme.ts
  // 'obsidian'). bg-obsidian/text-ivory/text-champagne all resolve through
  // the --brand-* vars, so Settings → Theme re-skins it. Default palette
  // values keep this visually equivalent to the original near-black footer
  // while the eyebrow accent now matches the header's champagne-gold.
  obsidian: {
    surface: 'bg-obsidian text-ivory',
    logoFilter: 'brightness-0 invert',
    muted: 'text-ivory/70',
    subtle: 'text-ivory/50',
    strong: 'text-ivory/80',
    strongHover: 'hover:text-ivory',
    accent: 'text-champagne',
    linkHover: 'hover:text-champagne',
    border: 'border-ivory/10',
    field:
      'bg-ivory/5 border-ivory/20 text-ivory placeholder:text-ivory/40 focus:border-champagne',
    cta: 'bg-champagne text-obsidian hover:bg-cream-50',
  },
  cream: {
    surface: 'bg-cream text-near-black',
    logoFilter: '',
    muted: 'text-near-black/70',
    subtle: 'text-near-black/50',
    strong: 'text-near-black/80',
    strongHover: 'hover:text-near-black',
    accent: 'text-copper-700',
    linkHover: 'hover:text-copper-700',
    border: 'border-near-black/10',
    field:
      'bg-near-black/5 border-near-black/20 text-near-black placeholder:text-near-black/40 focus:border-copper-700',
    cta: 'bg-near-black text-cream-50 hover:bg-copper-700',
  },
  ivory: {
    surface: 'bg-ivory text-obsidian',
    logoFilter: '',
    muted: 'text-obsidian/70',
    subtle: 'text-obsidian/50',
    strong: 'text-obsidian/80',
    strongHover: 'hover:text-obsidian',
    accent: 'text-copper-700',
    linkHover: 'hover:text-copper-700',
    border: 'border-obsidian/10',
    field:
      'bg-obsidian/5 border-obsidian/20 text-obsidian placeholder:text-obsidian/40 focus:border-copper-700',
    cta: 'bg-obsidian text-ivory hover:bg-copper-700',
  },
  champagne: {
    surface: 'bg-champagne text-obsidian',
    logoFilter: '',
    muted: 'text-obsidian/70',
    subtle: 'text-obsidian/55',
    strong: 'text-obsidian/80',
    strongHover: 'hover:text-obsidian',
    accent: 'text-copper-800',
    linkHover: 'hover:text-copper-800',
    border: 'border-obsidian/15',
    field:
      'bg-obsidian/5 border-obsidian/25 text-obsidian placeholder:text-obsidian/45 focus:border-obsidian',
    cta: 'bg-obsidian text-champagne hover:bg-near-black',
  },
  bone: {
    surface: 'bg-bone text-obsidian',
    logoFilter: '',
    muted: 'text-obsidian/70',
    subtle: 'text-obsidian/50',
    strong: 'text-obsidian/80',
    strongHover: 'hover:text-obsidian',
    accent: 'text-copper-700',
    linkHover: 'hover:text-copper-700',
    border: 'border-obsidian/10',
    field:
      'bg-obsidian/5 border-obsidian/20 text-obsidian placeholder:text-obsidian/40 focus:border-copper-700',
    cta: 'bg-obsidian text-bone hover:bg-copper-700',
  },
}

const FOOTER_THEME_VALUES = new Set<FooterTheme>([
  'cream',
  'obsidian',
  'ivory',
  'champagne',
  'bone',
])

/** Resolve a stored footer `theme` value to its class set. Unknown /
 *  missing values fall back to 'obsidian' (the original dark footer)
 *  so a tampered or pre-theming settings row renders the historic look
 *  rather than an unstyled footer. */
export function resolveFooterTheme(value: unknown): FooterThemeClasses {
  if (typeof value === 'string' && FOOTER_THEME_VALUES.has(value as FooterTheme)) {
    return FOOTER_THEMES[value as FooterTheme]
  }
  return FOOTER_THEMES.obsidian
}
