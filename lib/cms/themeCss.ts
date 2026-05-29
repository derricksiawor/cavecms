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

// Mix a hex color toward black by `amount` (0..1) in sRGB. Used for the
// two derived utility shades (hover gold, divider). sRGB (not OKLCH) is
// deliberate: concrete hex output works in every browser, and these two
// shades don't need perceptual-uniform precision.
export function darkenHex(hex: string, amount: number): string {
  if (!HEX_COLOR_RE.test(hex) || hex.length !== 7) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const f = (c: number) => Math.round(c * (1 - amount))
  const h = (c: number) => f(c).toString(16).padStart(2, '0').toUpperCase()
  return `#${h(r)}${h(g)}${h(b)}`
}

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

  // Base surface follows the mode (most visible "is the site light or
  // dark" signal). Light -> light surface bg + dark fg; Dark -> inverse.
  if (p.mode === 'dark') {
    put('--brand-base-bg', p.surfaceDark)
    put('--brand-base-fg', p.surfaceLight)
  } else {
    put('--brand-base-bg', p.surfaceLight)
    put('--brand-base-fg', p.surfaceDark)
  }

  // Derived tokens — emit ONLY when the source color changed from the
  // default, so a default install keeps the hand-picked #8B6F3A / #E8E1D4.
  if (p.accent !== THEME_PALETTE_DEFAULT.accent) {
    put('--color-antique-gold', darkenHex(p.accent, 0.15))
  }
  if (p.surfaceLight !== THEME_PALETTE_DEFAULT.surfaceLight) {
    put('--color-bone', darkenHex(p.surfaceLight, 0.08))
  }

  return `:root{${decls.join(';')}}`
}
