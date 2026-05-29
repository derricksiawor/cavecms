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
// Default 'obsidian' reproduces the EXACT pre-theming look
// (bg-near-black + cream-50 + copper accents) so existing installs that
// don't carry a footer `theme` in their stored settings render
// unchanged (Zod `.default('obsidian')` fills on read).

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
}

export const FOOTER_THEMES: Record<FooterTheme, FooterThemeClasses> = {
  // Default — byte-for-byte the original hardcoded dark footer.
  obsidian: {
    surface: 'bg-near-black text-cream-50',
    logoFilter: 'brightness-0 invert',
    muted: 'text-cream-50/70',
    subtle: 'text-cream-50/50',
    strong: 'text-cream-50/80',
    strongHover: 'hover:text-cream-50',
    accent: 'text-copper-400',
    linkHover: 'hover:text-copper-300',
    border: 'border-cream-50/10',
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
