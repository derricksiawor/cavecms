/**
 * CaveCMS font catalog — the curated set of self-hosted typefaces the
 * operator can apply, Elementor-style, to global roles AND individual
 * blocks.
 *
 * PURE module (no `server-only`): imported by the client font picker,
 * the server layout/CSS emitter, the block-registry weight refine, and
 * unit tests. Keep it free of DOM + server-only imports.
 *
 * Each font ships as an `@fontsource(-variable)` package (self-hosted —
 * no Google requests, CSP stays `font-src 'self'`). The browser only
 * downloads a family's woff2 when text actually renders in it, so the
 * full catalog's `@font-face` declarations are cheap to ship while real
 * font files stay only-load-used.
 *
 * Adding a font = `pnpm add @fontsource-variable/<slug>`, add one entry
 * here, and add the matching side-effect import in ./loadFonts.ts.
 */

export type FontCategory = 'serif' | 'sans' | 'display' | 'mono'

export interface FontCatalogEntry {
  /** Stable slug — what a block's `family` / a role stores. Matches the
   *  @fontsource package slug. */
  key: string
  /** Human label shown in the picker. */
  family: string
  /** The `font-family` name the @fontsource @font-face declares — what
   *  the `--font-cat-<key>` CSS var resolves to. Variable packages use
   *  "<Name> Variable"; static packages use the bare name. */
  cssFamily: string
  category: FontCategory
  /** System fallback appended after cssFamily in the CSS var. */
  fallback: string
  /** Variable wght axis range [min,max]. `null` for static single-weight
   *  fonts (use `staticWeight`). Drives the weight picker's available
   *  range so an operator can't pick a weight the font can't render. */
  weightRange: readonly [number, number] | null
  /** Single weight for static (non-variable) fonts. */
  staticWeight?: number
}

// Category fallback stacks — kept here so every entry stays terse.
const FALLBACK: Record<FontCategory, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  display: 'system-ui, -apple-system, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
}

const entry = (
  key: string,
  family: string,
  cssFamily: string,
  category: FontCategory,
  weightRange: readonly [number, number] | null,
  opts?: { staticWeight?: number; fallback?: string },
): FontCatalogEntry => ({
  key,
  family,
  cssFamily,
  category,
  fallback: opts?.fallback ?? FALLBACK[category],
  weightRange,
  staticWeight: opts?.staticWeight,
})

// Order within a category = picker display order. weightRange is the
// variable wght axis ([min,max]); null = static single-weight (staticWeight).
const ENTRIES: FontCatalogEntry[] = [
  // ── Serif ──────────────────────────────────────────────────────────
  entry('marcellus', 'Marcellus', 'Marcellus', 'serif', null, { staticWeight: 400 }),
  entry('cormorant-garamond', 'Cormorant Garamond', 'Cormorant Garamond Variable', 'serif', [300, 700]),
  entry('playfair-display', 'Playfair Display', 'Playfair Display Variable', 'serif', [400, 900]),
  entry('eb-garamond', 'EB Garamond', 'EB Garamond Variable', 'serif', [400, 800]),
  entry('lora', 'Lora', 'Lora Variable', 'serif', [400, 700]),
  entry('source-serif-4', 'Source Serif 4', 'Source Serif 4 Variable', 'serif', [200, 900]),
  entry('fraunces', 'Fraunces', 'Fraunces Variable', 'serif', [100, 900]),
  // ── Sans ───────────────────────────────────────────────────────────
  entry('montserrat', 'Montserrat', 'Montserrat Variable', 'sans', [100, 900]),
  entry('inter', 'Inter', 'Inter Variable', 'sans', [100, 900]),
  entry('work-sans', 'Work Sans', 'Work Sans Variable', 'sans', [100, 900]),
  entry('dm-sans', 'DM Sans', 'DM Sans Variable', 'sans', [100, 1000]),
  entry('manrope', 'Manrope', 'Manrope Variable', 'sans', [200, 800]),
  entry('plus-jakarta-sans', 'Plus Jakarta Sans', 'Plus Jakarta Sans Variable', 'sans', [200, 800]),
  entry('figtree', 'Figtree', 'Figtree Variable', 'sans', [300, 900]),
  entry('raleway', 'Raleway', 'Raleway Variable', 'sans', [100, 900]),
  // ── Display ─────────────────────────────────────────────────────────
  entry('space-grotesk', 'Space Grotesk', 'Space Grotesk Variable', 'display', [300, 700]),
  entry('archivo', 'Archivo', 'Archivo Variable', 'display', [100, 900]),
  entry('bricolage-grotesque', 'Bricolage Grotesque', 'Bricolage Grotesque Variable', 'display', [200, 800]),
  entry('syne', 'Syne', 'Syne Variable', 'display', [400, 800]),
  // ── Mono ────────────────────────────────────────────────────────────
  entry('jetbrains-mono', 'JetBrains Mono', 'JetBrains Mono Variable', 'mono', [100, 800]),
  entry('fira-code', 'Fira Code', 'Fira Code Variable', 'mono', [300, 700]),
]

export const FONT_CATALOG: Record<string, FontCatalogEntry> = Object.fromEntries(
  ENTRIES.map((e) => [e.key, e]),
)

/** Picker display order, preserving the category grouping above. */
export const FONT_CATALOG_ORDER: readonly string[] = ENTRIES.map((e) => e.key)

export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  serif: 'Serif',
  sans: 'Sans-serif',
  display: 'Display',
  mono: 'Monospace',
}

export function isFontCatalogKey(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(FONT_CATALOG, value)
}

// A valid font-key SLUG — the shape any font key (bundled OR runtime
// custom) must satisfy. Lowercase alphanumeric + dashes, 1..64 chars,
// must start with an alphanumeric. Every bundled catalog key is a valid
// slug (so the loosened validators below still accept them) AND every
// custom-font key (`cf-<slug>-<id>`) is one too. The render path emits
// `var(--font-cat-<key>)` for ANY slug — the var is only DEFINED for
// active fonts (bundled via catalogVarsCss, custom via customFontFaceCss),
// so an unknown-but-well-formed slug resolves to nothing and the element
// falls back to its inherited face. This is what lets per-block / role
// values reference a runtime custom font the static catalog can't know.
export const FONT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isFontKeySlug(v: string): boolean {
  return FONT_KEY_RE.test(v)
}

/** The CSS var that resolves to a catalog font's stack (defined by
 *  catalogVarsCss in ./fontCss). */
export function fontCatalogVar(key: string): string {
  return `--font-cat-${key}`
}


// ──────────────────────────────────────────────────────────────────────
// Global typography roles — the "Global Fonts" tier (Elementor). A block
// references a ROLE by default (tracks the site setting); an override
// stores a catalog key directly. Role tokens and catalog keys share one
// value space and never collide (no catalog font is named display/body).
// ──────────────────────────────────────────────────────────────────────

export type TypographyRole = 'display' | 'body'

export const TYPOGRAPHY_ROLES: TypographyRole[] = ['display', 'body']

// `cssVar` is the legacy :root leaf var the whole @theme chain keys off
// (these were supplied by next/font before the catalog migration):
//   --font-playfair  → --font-display / --font-serif  → font-display, font-serif
//   --font-montserrat→ --font-body / --font-sans      → font-body, font-sans
// Overriding the leaf re-skins every consumer in one move. (The name
// "playfair" is historical — it has always held the serif/headings face,
// which ships as Marcellus.)
export const TYPOGRAPHY_ROLE_META: Record<
  TypographyRole,
  { label: string; help: string; cssVar: string }
> = {
  display: {
    label: 'Headings',
    help: 'Serif/display face for headings, titles, and display copy.',
    cssVar: '--font-playfair',
  },
  body: {
    label: 'Body',
    help: 'Face for body copy, UI, buttons, and eyebrows.',
    cssVar: '--font-montserrat',
  },
}

/** Shipped role defaults — Marcellus headings + Montserrat body (the
 *  historic CaveCMS pairing). Operators remap these under Settings →
 *  Typography; the fleet default is unchanged. */
export const TYPOGRAPHY_ROLES_DEFAULT: Record<TypographyRole, string> = {
  display: 'marcellus',
  body: 'montserrat',
}

export function isTypographyRole(value: string): value is TypographyRole {
  return value === 'display' || value === 'body'
}
