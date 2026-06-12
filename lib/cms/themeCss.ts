// Source of truth for the operator brand palette + the CSS it generates.
// PURE module (no server-only): imported by the client Theme picker, the
// server root layout, the settings registry, and unit tests.
//
// The luxury @theme tokens in app/globals.css reference these --brand-*
// vars. Overriding the --brand-* vars re-skins every block, the header,
// and the footer. Derived tokens (antique-gold hover, bone divider) are
// only emitted when the operator changed the source color, so a default
// install stays pixel-identical AND every browser is covered (concrete
// hex, no color-mix dependency).

import { HEX_COLOR_RE } from '@/lib/cms/designTokens'

export interface ThemePalette {
  mode: 'light' | 'dark'
  primary: string
  secondary: string
  accent: string
  surfaceDark: string
  surfaceLight: string
}

export const THEME_PALETTE_DEFAULT: ThemePalette = {
  mode: 'light',
  primary: '#050505',
  secondary: '#6E665A',
  accent: '#C9A961',
  surfaceDark: '#050505',
  surfaceLight: '#F5F1EA',
}

// Normalise any HEX_COLOR_RE-valid hex (#RGB / #RRGGBB / #RRGGBBAA) to a plain
// #RRGGBB string, or null if invalid. 3-char shorthand is expanded (#F5A →
// #FF55AA); an 8-char value's alpha byte is DROPPED (luminance/mixing operate on
// the opaque RGB — the alpha is irrelevant to which ink pole reads light/dark).
// Without this, the colour math below (which assumed exactly 7 chars) silently
// bailed to a fallback for the 3/8-char hexes that HEX_COLOR_RE accepts — e.g.
// an 8-char surfaceLight made relLuminance return 0.5 and pick the WRONG ink.
function normalizeHex6(hex: string): string | null {
  if (!HEX_COLOR_RE.test(hex)) return null
  if (hex.length === 7) return hex
  if (hex.length === 9) return hex.slice(0, 7) // strip alpha
  if (hex.length === 4) {
    // #RGB → #RRGGBB
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  }
  return null
}

// Mix a hex color toward black by `amount` (0..1) in sRGB. Used for the
// two derived utility shades (hover gold, divider). sRGB (not OKLCH) is
// deliberate: concrete hex output works in every browser, and these two
// shades don't need perceptual-uniform precision.
export function darkenHex(hex: string, amount: number): string {
  const h6 = normalizeHex6(hex)
  if (!h6) return hex
  const r = parseInt(h6.slice(1, 3), 16)
  const g = parseInt(h6.slice(3, 5), 16)
  const b = parseInt(h6.slice(5, 7), 16)
  const f = (c: number) => Math.round(c * (1 - amount))
  const h = (c: number) => f(c).toString(16).padStart(2, '0').toUpperCase()
  return `#${h(r)}${h(g)}${h(b)}`
}

// Mix a hex toward white by `amount` (0..1). Used to derive a subtle elevated
// divider line just above a dark base surface.
function lightenHex(hex: string, amount: number): string {
  const h6 = normalizeHex6(hex)
  if (!h6) return hex
  const r = parseInt(h6.slice(1, 3), 16)
  const g = parseInt(h6.slice(3, 5), 16)
  const b = parseInt(h6.slice(5, 7), 16)
  const f = (c: number) => Math.round(c + (255 - c) * amount)
  const h = (c: number) => f(c).toString(16).padStart(2, '0').toUpperCase()
  return `#${h(r)}${h(g)}${h(b)}`
}

// WCAG relative luminance (0 = black, 1 = white) for a #RRGGBB hex. Used to
// decide whether a surface colour reads as "light" or "dark" so the ink poles
// can be anchored to the correct end of the scale.
function relLuminance(hex: string): number {
  const h6 = normalizeHex6(hex)
  if (!h6) return 0.5
  const lin = (i: number) => {
    const c = parseInt(h6.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5)
}
// A colour reads "light" above this luminance. Tuned so #0A0A0A (a dark card
// surface) is NOT light while a true cream/ivory IS.
const LIGHT_THRESHOLD = 0.4
const FALLBACK_INK_LIGHT = '#F5F1EA' // warm near-white — readable on any dark bg
const FALLBACK_INK_DARK = '#050505' // near-black — readable on any light bg

// Build the injected <style> body. Only valid hex passes (HEX_COLOR_RE
// also accepts 3/8-char, but the palette schema stores 6-char; we
// re-validate here as defence-in-depth so a tampered settings cell can
// never inject arbitrary CSS — a failing field is simply omitted and the
// @layer-base default remains in effect).
export function brandVarsCss(p: ThemePalette): string {
  const decls: string[] = []
  const put = (name: string, hex: string) => {
    if (HEX_COLOR_RE.test(hex)) decls.push(`${name}:${hex}`)
  }

  put('--brand-surface-dark', p.surfaceDark)
  put('--brand-surface-light', p.surfaceLight)
  put('--brand-accent', p.accent)
  put('--brand-secondary', p.secondary)
  put('--brand-primary', p.primary)

  // CONTRAST-ANCHORED ink poles — the keystone of legible text on ANY palette.
  // `ink-light` (the light pole behind `ivory`, light text on dark surfaces)
  // must always read light; `ink-dark` (behind `obsidian`) must always read
  // dark. A dark-site operator can set surfaceLight to a DARK card colour
  // (#0A0A0A) for dark cards — so ink-light follows surfaceLight ONLY while it
  // is genuinely light, otherwise it falls back to a guaranteed near-white.
  // Symmetric for ink-dark. (Light palettes are unchanged: surfaceLight is
  // light → ink-light == surfaceLight, pixel-identical to before.)
  const inkLight = relLuminance(p.surfaceLight) >= LIGHT_THRESHOLD ? p.surfaceLight : FALLBACK_INK_LIGHT
  const inkDark = relLuminance(p.surfaceDark) < LIGHT_THRESHOLD ? p.surfaceDark : FALLBACK_INK_DARK
  put('--brand-ink-light', inkLight)
  put('--brand-ink-dark', inkDark)

  // Base surface follows the mode. The FOREGROUND uses the anchored ink pole
  // (not the raw opposite surface) so the default text colour is always
  // readable: dark site → dark bg + light ink; light site → light bg + dark ink.
  if (p.mode === 'dark') {
    put('--brand-base-bg', p.surfaceDark)
    put('--brand-base-fg', inkLight)
  } else {
    put('--brand-base-bg', p.surfaceLight)
    put('--brand-base-fg', inkDark)
  }

  // Derived tokens — emit ONLY when the source color changed from the
  // default, so a default install keeps the hand-picked #8B6F3A / #E8E1D4.
  // Override the --brand-* knobs (globals.css aliases --color-antique-gold /
  // --color-bone to these, and @theme inline maps the utilities to them).
  if (p.accent !== THEME_PALETTE_DEFAULT.accent) {
    put('--brand-antique-gold', darkenHex(p.accent, 0.15))
    // Copper scale — the warm accent RAMP (link/hover accents, admin
    // chrome, light tint wells). Re-derived from the operator accent so
    // copper-tinted chrome follows the brand instead of staying the
    // hand-picked copper. Tint ratios approximate the default ramp's
    // lightness steps around copper-500 ≈ the accent slot.
    put('--brand-copper-50', lightenHex(p.accent, 0.92))
    put('--brand-copper-100', lightenHex(p.accent, 0.8))
    put('--brand-copper-200', lightenHex(p.accent, 0.6))
    put('--brand-copper-300', lightenHex(p.accent, 0.35))
    put('--brand-copper-400', lightenHex(p.accent, 0.12))
    put('--brand-copper-500', p.accent)
    put('--brand-copper-600', darkenHex(p.accent, 0.12))
    put('--brand-copper-700', darkenHex(p.accent, 0.3))
    put('--brand-copper-800', darkenHex(p.accent, 0.45))
    put('--brand-copper-900', darkenHex(p.accent, 0.58))
  }
  if (p.surfaceLight !== THEME_PALETTE_DEFAULT.surfaceLight) {
    // `bone` is a subtle DIVIDER/hairline. It must stay visible against the
    // base surface. On a light surface a slightly-darker line works; but when
    // the light surface is itself dark (dark site), darkening it further makes
    // the divider vanish — so derive a subtle ELEVATED line just above the dark
    // base instead. Keeps every divider visible regardless of palette.
    put(
      '--brand-bone',
      relLuminance(p.surfaceLight) >= LIGHT_THRESHOLD
        ? darkenHex(p.surfaceLight, 0.08)
        : lightenHex(p.surfaceDark, 0.12),
    )
    // Cream family — the warm LIGHT-surface ramp (page wells, light pills,
    // form fields). Re-derived from the operator's light surface; when the
    // "light" surface is itself dark (a dark-site palette), derive from the
    // anchored light ink pole instead so cream surfaces never go dark under
    // dark text. Ratios approximate the default ramp around cream-200 ≈ the
    // light surface slot.
    const creamBase =
      relLuminance(p.surfaceLight) >= LIGHT_THRESHOLD ? p.surfaceLight : inkLight
    put('--brand-cream', creamBase)
    put('--brand-cream-50', lightenHex(creamBase, 0.55))
    put('--brand-cream-100', lightenHex(creamBase, 0.35))
    put('--brand-cream-200', creamBase)
    put('--brand-cream-300', darkenHex(creamBase, 0.05))
    put('--brand-cream-400', darkenHex(creamBase, 0.15))
  }
  // Dark ink fills (near-black buttons/footers, charcoal admin cards) follow
  // the anchored dark ink pole. Emitted only when the pole diverges from the
  // default near-black so a default install stays byte-identical.
  if (inkDark !== FALLBACK_INK_DARK) {
    put('--brand-near-black', inkDark)
    put('--brand-deep-charcoal', lightenHex(inkDark, 0.08))
  }

  return `:root{${decls.join(';')}}`
}
