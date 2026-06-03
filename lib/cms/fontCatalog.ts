// Curated Google-font catalog for the site-wide typography setting. Bounded (not
// free-form) so every choice is a real, loadable family and nothing user-supplied
// is interpolated into a stylesheet URL or CSS. Covers the common brand needs:
// geometric/grotesk/humanist sans for product brands, editorial serifs/displays
// for luxury, plus mono. Pick a heading font + a body font to match any brand.

export interface FontEntry {
  /** Google Fonts family name. */
  family: string
  /** Axis param for the css2 API (weights this site loads). */
  axis: string
  kind: 'sans' | 'serif' | 'display' | 'mono'
  /** Full CSS font stack with sensible fallbacks. */
  stack: string
}

const SANS_FB = 'system-ui, -apple-system, "Segoe UI", sans-serif'
const SERIF_FB = 'Georgia, "Times New Roman", serif'
const MONO_FB = 'ui-monospace, SFMono-Regular, Menlo, monospace'

export const FONT_CATALOG = {
  // ── sans ──
  inter: { family: 'Inter', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Inter', ${SANS_FB}` },
  poppins: { family: 'Poppins', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Poppins', ${SANS_FB}` },
  montserrat: { family: 'Montserrat', axis: 'wght@100;200;300;400;500;600;700;800', kind: 'sans', stack: `'Montserrat', ${SANS_FB}` },
  manrope: { family: 'Manrope', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Manrope', ${SANS_FB}` },
  'dm-sans': { family: 'DM Sans', axis: 'wght@400;500;600;700', kind: 'sans', stack: `'DM Sans', ${SANS_FB}` },
  'plus-jakarta-sans': { family: 'Plus Jakarta Sans', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Plus Jakarta Sans', ${SANS_FB}` },
  'work-sans': { family: 'Work Sans', axis: 'wght@400;500;600;700', kind: 'sans', stack: `'Work Sans', ${SANS_FB}` },
  sora: { family: 'Sora', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Sora', ${SANS_FB}` },
  'space-grotesk': { family: 'Space Grotesk', axis: 'wght@400;500;600;700', kind: 'sans', stack: `'Space Grotesk', ${SANS_FB}` },
  outfit: { family: 'Outfit', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Outfit', ${SANS_FB}` },
  figtree: { family: 'Figtree', axis: 'wght@400;500;600;700;800', kind: 'sans', stack: `'Figtree', ${SANS_FB}` },
  // ── serif / display ──
  'playfair-display': { family: 'Playfair Display', axis: 'wght@400;500;600;700;800', kind: 'display', stack: `'Playfair Display', ${SERIF_FB}` },
  fraunces: { family: 'Fraunces', axis: 'opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700', kind: 'display', stack: `'Fraunces', ${SERIF_FB}` },
  lora: { family: 'Lora', axis: 'wght@400;500;600;700', kind: 'serif', stack: `'Lora', ${SERIF_FB}` },
  'cormorant-garamond': { family: 'Cormorant Garamond', axis: 'wght@400;500;600;700', kind: 'serif', stack: `'Cormorant Garamond', ${SERIF_FB}` },
  'eb-garamond': { family: 'EB Garamond', axis: 'wght@400;500;600;700', kind: 'serif', stack: `'EB Garamond', ${SERIF_FB}` },
  marcellus: { family: 'Marcellus', axis: 'wght@400', kind: 'display', stack: `'Marcellus', ${SERIF_FB}` },
  // ── mono ──
  'jetbrains-mono': { family: 'JetBrains Mono', axis: 'wght@400;500;700', kind: 'mono', stack: `'JetBrains Mono', ${MONO_FB}` },
  'ibm-plex-mono': { family: 'IBM Plex Mono', axis: 'wght@400;500;600', kind: 'mono', stack: `'IBM Plex Mono', ${MONO_FB}` },
} as const satisfies Record<string, FontEntry>

export type FontKey = keyof typeof FONT_CATALOG
export const FONT_KEYS = Object.keys(FONT_CATALOG) as FontKey[]

export interface TypographySetting {
  heading: FontKey | null
  body: FontKey | null
}

// Build the Google Fonts css2 <link href> for the chosen families (deduped), or
// null when neither is set. display=swap so text paints immediately.
export function googleFontsHref(t: TypographySetting): string | null {
  const keys = [t.heading, t.body].filter((k): k is FontKey => !!k && k in FONT_CATALOG)
  if (keys.length === 0) return null
  const seen = new Set<string>()
  const families: string[] = []
  for (const k of keys) {
    const e = FONT_CATALOG[k]
    const param = `family=${e.family.replace(/ /g, '+')}:${e.axis}`
    if (!seen.has(param)) {
      seen.add(param)
      families.push(param)
    }
  }
  return `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`
}

// CSS that overrides the two leaf font vars everything chains through
// (--font-playfair = headings/display, --font-montserrat = body/sans). Only
// emits the vars that are set, so an unset axis keeps the compiled default.
export function typographyVarsCss(t: TypographySetting): string {
  const lines: string[] = []
  if (t.heading && t.heading in FONT_CATALOG) {
    lines.push(`--font-playfair:${FONT_CATALOG[t.heading].stack}`)
  }
  if (t.body && t.body in FONT_CATALOG) {
    lines.push(`--font-montserrat:${FONT_CATALOG[t.body].stack}`)
  }
  return lines.length ? `:root{${lines.join(';')}}` : ''
}
