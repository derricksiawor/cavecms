/**
 * CaveCMS luxury redesign — single source of truth for design tokens.
 *
 * Admin-bar pickers (color swatches, type-size selector, spacing
 * slider, animation preset dropdown) read from THIS file. Operators
 * cannot pick free-form hex values, pixel sizes, or font weights —
 * they pick from this set. The same tokens are also emitted as CSS
 * custom properties in app/globals.css and as Tailwind utilities by
 * Tailwind v4's @theme mechanism. Adding a new color requires
 * updating BOTH this file and globals.css (the two files stay in
 * sync by hand; there's no codegen yet).
 *
 * This file describes the picker UX vocabulary. Renderers translate
 * a token to a className via the helpers at the bottom — that way
 * if the Tailwind utility naming convention changes, only this file
 * needs editing, not every block renderer.
 */

import { FONT_CATALOG, isFontKeySlug, fontCatalogVar } from '@/lib/typography/catalog'

// ──────────────────────────────────────────────────────────────────
// Color palette — tight by design. Luxury brands have ~6 tokens, not
// 60. Adding a 7th requires brand-owner approval.
// ──────────────────────────────────────────────────────────────────

export type ColorToken =
  | 'obsidian'
  | 'ivory'
  | 'champagne'
  | 'antique-gold'
  | 'warm-stone'
  | 'bone'

export const COLOR_TOKENS: Record<
  ColorToken,
  { label: string; cssVar: string; hex: string; role: string }
> = {
  obsidian: {
    label: 'Obsidian',
    cssVar: '--color-obsidian',
    hex: '#050505',
    role: 'Primary dark — backgrounds, text on light',
  },
  ivory: {
    label: 'Ivory',
    cssVar: '--color-ivory',
    hex: '#F5F1EA',
    role: 'Primary light — backgrounds, text on dark',
  },
  champagne: {
    label: 'Champagne',
    cssVar: '--color-champagne',
    hex: '#C9A961',
    role: 'Primary gold — CTAs, accents, hairline rules',
  },
  'antique-gold': {
    label: 'Antique Gold',
    cssVar: '--color-antique-gold',
    hex: '#8B6F3A',
    role: 'Deeper gold — hover states, secondary accents',
  },
  'warm-stone': {
    label: 'Warm Stone',
    cssVar: '--color-warm-stone',
    hex: '#6E665A',
    role: 'Muted text — secondary labels, captions',
  },
  bone: {
    label: 'Bone',
    cssVar: '--color-bone',
    hex: '#E8E1D4',
    role: 'Soft neutral — dividers, hairlines on light',
  },
} as const

// ──────────────────────────────────────────────────────────────────
// Tone — semantic groupings of colors that pair as background+text
// combinations. The admin tone picker shows these as visual cards.
// ──────────────────────────────────────────────────────────────────

export type ToneToken = 'obsidian' | 'ivory' | 'champagne'

export const TONE_TOKENS: Record<
  ToneToken,
  { label: string; bg: ColorToken; text: ColorToken; accent: ColorToken }
> = {
  obsidian: { label: 'Obsidian',  bg: 'obsidian', text: 'ivory',    accent: 'champagne' },
  ivory:    { label: 'Ivory',     bg: 'ivory',    text: 'obsidian', accent: 'champagne' },
  champagne:{ label: 'Champagne', bg: 'champagne',text: 'obsidian', accent: 'obsidian'  },
} as const

// ──────────────────────────────────────────────────────────────────
// Spacing — editorial scale. Operators get NAMED stops, never raw px.
// Drives `py-section-md` etc. via Tailwind v4 --spacing-* tokens.
// ──────────────────────────────────────────────────────────────────

export type SpacingToken =
  | 'section-xs'
  | 'section-sm'
  | 'section-md'
  | 'section-lg'
  | 'section-xl'
  | 'section-2xl'

export const SPACING_TOKENS: Record<SpacingToken, { label: string; px: number }> = {
  'section-xs':  { label: 'XS · 48px',   px: 48  },
  'section-sm':  { label: 'SM · 64px',   px: 64  },
  'section-md':  { label: 'MD · 96px',   px: 96  },
  'section-lg':  { label: 'LG · 128px',  px: 128 },
  'section-xl':  { label: 'XL · 160px',  px: 160 },
  'section-2xl': { label: '2XL · 192px', px: 192 },
} as const

// ──────────────────────────────────────────────────────────────────
// Global typography ROLES (display = serif/headings, body = sans). The
// face each role uses is operator-configurable (Settings → Typography /
// the typography_roles setting) and resolved at render via the
// --font-display / --font-body CSS vars; the only thing keyed off here
// now is each role's curated weight set (used by shippedWeightTokensFor
// to gate the weight picker). The shipped display role default is a
// static-400 serif (Marcellus), so a heading at a heavier weight is
// browser-synthesised — historical CaveCMS behaviour, preserved.
// ──────────────────────────────────────────────────────────────────

export type FontFamilyToken = 'display' | 'body'

export const FONT_FAMILY_TOKENS: Record<
  FontFamilyToken,
  { shippedWeights: ReadonlyArray<FontWeightToken> }
> = {
  // Light weights are intentionally omitted (CLAUDE.md forbids them) so the
  // role weight picker can't construct a "light" heading.
  display: { shippedWeights: ['regular', 'medium', 'semibold', 'bold', 'black'] as const },
  body: { shippedWeights: ['regular', 'medium', 'semibold', 'bold'] as const },
} as const

// ──────────────────────────────────────────────────────────────────
// Font weight — Elementor exposes 100–900 numeric values but
// CLAUDE.md mandates no light weights. The token set starts at 400.
// ──────────────────────────────────────────────────────────────────

export type FontWeightToken =
  | 'regular'
  | 'medium'
  | 'semibold'
  | 'bold'
  | 'black'

export const FONT_WEIGHT_TOKENS: Record<
  FontWeightToken,
  { label: string; weight: number; tailwindClass: string }
> = {
  regular:  { label: 'Regular · 400',  weight: 400, tailwindClass: 'font-normal'   },
  medium:   { label: 'Medium · 500',   weight: 500, tailwindClass: 'font-medium'   },
  semibold: { label: 'Semibold · 600', weight: 600, tailwindClass: 'font-semibold' },
  bold:     { label: 'Bold · 700',     weight: 700, tailwindClass: 'font-bold'     },
  black:    { label: 'Black · 900',    weight: 900, tailwindClass: 'font-black'    },
} as const

export type TextSizeToken =
  | 'display-2xl'
  | 'display-xl'
  | 'display-lg'
  | 'display-md'
  | 'display-sm'
  | 'body-lg'
  | 'body-md'
  | 'body-sm'
  | 'eyebrow'

export const TEXT_SIZE_TOKENS: Record<
  TextSizeToken,
  { label: string; px: number; family: FontFamilyToken }
> = {
  'display-2xl': { label: 'Display 2XL · 80px', px: 80, family: 'display' },
  'display-xl':  { label: 'Display XL · 64px',  px: 64, family: 'display' },
  'display-lg':  { label: 'Display LG · 48px',  px: 48, family: 'display' },
  'display-md':  { label: 'Display MD · 36px',  px: 36, family: 'display' },
  'display-sm':  { label: 'Display SM · 28px',  px: 28, family: 'display' },
  'body-lg':     { label: 'Body LG · 20px',     px: 20, family: 'body'    },
  'body-md':     { label: 'Body MD · 16px',     px: 16, family: 'body'    },
  'body-sm':     { label: 'Body SM · 14px',     px: 14, family: 'body'    },
  'eyebrow':     { label: 'Eyebrow · 12px',     px: 12, family: 'body'    },
} as const

// ──────────────────────────────────────────────────────────────────
// Animation presets — per-block opt-in. None = static. The picker
// shows these as labeled radio cards in the admin bar.
// ──────────────────────────────────────────────────────────────────

export type AnimationPresetToken =
  | 'none'
  | 'fade-in'
  | 'slide-up'
  | 'line-reveal'
  | 'count-up'
  | 'parallax'
  | 'magnetic'
  | 'gold-rule'

export const ANIMATION_PRESETS: Record<
  AnimationPresetToken,
  { label: string; description: string }
> = {
  'none':        { label: 'None',           description: 'Static — no animation' },
  'fade-in':     { label: 'Fade in',        description: 'Opacity fade on scroll into view' },
  'slide-up':    { label: 'Slide up',       description: '24px slide + opacity fade on scroll' },
  'line-reveal': { label: 'Line reveal',    description: 'Heading lines stagger up — use on hero headlines only' },
  'count-up':    { label: 'Count up',       description: 'Number tweens 0 → target on scroll (trust-strip stats)' },
  'parallax':    { label: 'Parallax',       description: 'Image scales 1.0 → 1.08 across viewport pass' },
  'magnetic':    { label: 'Magnetic',       description: 'CTA follows cursor by ~8px on hover (buttons only)' },
  'gold-rule':   { label: 'Gold rule wipe', description: 'Hairline rule wipes left→right on scroll' },
} as const

// ──────────────────────────────────────────────────────────────────
// Motion timing — sourced from the existing @theme block in
// globals.css so callers stay consistent with cavecms-* animations.
// ──────────────────────────────────────────────────────────────────

export type EaseToken = 'standard' | 'decelerate' | 'inout' | 'accelerate' | 'luxury'
export type DurationToken =
  | 'quick' | 'standard' | 'drawer' | 'reveal'
  | 'elegant' | 'shimmer' | 'ambient' | 'drift'

// ──────────────────────────────────────────────────────────────────
// Tailwind class helpers — admin emits the right utility for a
// given token. Single source of truth: if Tailwind's --color-*
// → bg-* naming ever changes, only these helpers need editing.
// ──────────────────────────────────────────────────────────────────

export function bgClass(token: ColorToken): string {
  return `bg-${token}`
}

export function textClass(token: ColorToken): string {
  return `text-${token}`
}

export function borderClass(token: ColorToken): string {
  return `border-${token}`
}

export function paddingYClass(token: SpacingToken): string {
  return `py-${token}`
}

export function paddingXClass(token: SpacingToken): string {
  return `px-${token}`
}

export function fontSizeClass(token: TextSizeToken): string {
  return `text-${token}`
}

// Role families ('display'/'body') resolve to the Tailwind utilities
// font-display / font-body directly in resolveFamilyRender below; catalog
// fonts resolve to an inline var. (The old FAMILY_TAILWIND map +
// fontFamilyClass helper were removed — resolveFamilyRender is the single
// resolver now.)

// ──────────────────────────────────────────────────────────────────
// Tone resolver — given a tone token, return the bg + text + accent
// classes for a section container. Used by Container/Section blocks.
// ──────────────────────────────────────────────────────────────────

export function toneClasses(token: ToneToken): {
  bg: string
  text: string
  accent: string
} {
  const t = TONE_TOKENS[token]
  return {
    bg: bgClass(t.bg),
    text: textClass(t.text),
    accent: textClass(t.accent),
  }
}

// ──────────────────────────────────────────────────────────────────
// Picker resolver helpers — token-or-hex round-trip.
//
// Block schemas were widened from `z.enum(tokens)` to
// `z.union([z.enum(tokens), hexRegex])`. The picker emits either:
//   - a token literal:  "champagne", "obsidian", …
//   - a raw hex string: "#C9A961" or "#C9A96180" (8-char = +alpha)
//
// resolveColorValue() returns a CSS value the renderer can drop into
// either inline style or as a `style={{ background: ... }}` payload.
// isColorToken() lets callers branch on token-vs-custom for UI hints
// (the globe icon turns blue when the value is a token).
// ──────────────────────────────────────────────────────────────────

export function isColorToken(value: string): value is ColorToken {
  return Object.prototype.hasOwnProperty.call(COLOR_TOKENS, value)
}

export function cssVarForColor(token: ColorToken): string {
  return `var(${COLOR_TOKENS[token].cssVar})`
}

export function resolveColorValue(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (isColorToken(value)) return cssVarForColor(value)
  // Defensive: accept #RGB, #RRGGBB, #RRGGBBAA only. Anything else
  // gets dropped (returns undefined) so a malformed persist can't
  // inject CSS. The picker UI never emits anything other than these.
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
    return value
  }
  return undefined
}

export function fontWeightClass(token: FontWeightToken): string {
  return FONT_WEIGHT_TOKENS[token].tailwindClass
}

// ──────────────────────────────────────────────────────────────────
// Family resolution — a block's `family` is EITHER a global role token
// ('display' | 'body', which tracks Settings → Typography) OR a direct
// catalog font key ('cormorant-garamond', …). Roles emit a Tailwind
// utility (cacheable, follows the role var); catalog keys can't have a
// static utility per font, so they emit an inline `font-family` var that
// the layout's --font-cat-* map resolves. undefined → neither (the
// renderer keeps its built-in baseline).
// ──────────────────────────────────────────────────────────────────

export function resolveFamilyRender(family: string | undefined | null): {
  className?: string
  style?: { fontFamily: string }
} {
  if (!family) return {}
  if (family === 'display' || family === 'body') return { className: `font-${family}` }
  // Any well-formed font-key slug (bundled catalog OR a runtime custom/Google
  // font) emits the inline var. The var is DEFINED only for active fonts
  // (catalogVarsCss / customFontFaceCss), so an unknown-but-valid slug
  // resolves to nothing and the element keeps its inherited face.
  if (isFontKeySlug(family)) {
    return { style: { fontFamily: `var(${fontCatalogVar(family)})` } }
  }
  return {}
}

// Which weight tokens a family can actually render — used by the weight
// picker to grey out unavailable weights. Roles use their curated
// `shippedWeights`; catalog fonts use their variable wght range (or the
// single static weight). null = "no family chosen → leave all enabled".
export function shippedWeightTokensFor(
  family: string | undefined | null,
): FontWeightToken[] | null {
  if (!family) return null
  if (family === 'display' || family === 'body') {
    return [...FONT_FAMILY_TOKENS[family].shippedWeights]
  }
  const f = FONT_CATALOG[family]
  if (!f) return null
  return (Object.keys(FONT_WEIGHT_TOKENS) as FontWeightToken[]).filter((w) => {
    const n = FONT_WEIGHT_TOKENS[w].weight
    return f.weightRange
      ? n >= f.weightRange[0] && n <= f.weightRange[1]
      : f.staticWeight === n
  })
}

// Validation regex re-exported for Zod schemas widening color enums to
// `z.union([z.enum(tokens), z.string().regex(HEX_COLOR_RE)])`. Same
// pattern as resolveColorValue but anchored — schema-side rejects
// anything that isn't a clean hex.
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
