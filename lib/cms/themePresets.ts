// Curated brand-palette presets — the same eight styles advertised on the
// marketing site (cavecms.derricksiawor.com themes gallery). One click in
// Settings → Theme fills the manual colour pickers with a complete,
// contrast-checked palette; the operator can still fine-tune any swatch
// before saving.
//
// PURE module (no server-only): consumed by the client Theme picker.
//
// Mapping from the marketing record { bg, fg, accent, muted } onto the
// CaveCMS ThemePalette { mode, primary, secondary, accent, surfaceDark,
// surfaceLight }:
//   • mode          — 'dark' when the brand's base background is dark,
//                     else 'light' (drives the page base surface).
//   • surfaceDark   — the brand's dark anchor (dark themes: bg; light
//                     themes: fg). Used for dark sections + the obsidian
//                     header/footer surface.
//   • surfaceLight  — the brand's light anchor (dark themes: fg; light
//                     themes: bg). Used for light sections + base bg.
//   • accent        — accent (buttons, links, eyebrows).
//   • secondary     — muted (supporting text).
//   • primary       — heading colour ON the light surface, so it always
//                     equals the DARK anchor (== surfaceDark). This keeps
//                     the WCAG soft-block (which gates primary/secondary on
//                     the light surface) honest for every preset, dark or
//                     light, exactly like the shipped default where
//                     primary == surfaceDark.
//
// Hex values are byte-identical to components/marketing/themes-data.ts on
// the marketing site so "what they saw advertised" is "what they install".

import type { ThemePalette } from '@/lib/cms/themeCss'

export interface ThemePreset {
  /** Stable id (matches the marketing slug). */
  slug: string
  /** Display name — "Obsidian & Gold", etc. */
  label: string
  /** Marketing headline — the card's one-liner. */
  headline: string
  /** Who it's for — the small "pairs with" hint. */
  pairsWith: string
  /** The palette this preset writes into Settings → Theme. */
  palette: ThemePalette
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    slug: 'obsidian-gold',
    label: 'Obsidian & Gold',
    headline: 'Quietly luxurious.',
    pairsWith: 'Hospitality · Restaurants · Boutique brands',
    palette: {
      mode: 'dark',
      surfaceDark: '#050505',
      surfaceLight: '#F5F1EA',
      accent: '#C9A961',
      secondary: '#6E665A',
      primary: '#050505',
    },
  },
  {
    slug: 'studio-mono',
    label: 'Studio Mono',
    headline: 'Quietly confident.',
    pairsWith: 'Agencies · Portfolios · Editorial',
    palette: {
      mode: 'dark',
      surfaceDark: '#0D0D0E',
      surfaceLight: '#F0F0EE',
      accent: '#DADADA',
      secondary: '#6B6B6B',
      primary: '#0D0D0E',
    },
  },
  {
    slug: 'sunrise-warm',
    label: 'Sunrise Warm',
    headline: 'Generous and warm.',
    pairsWith: 'Wellness · Cafés · Lifestyle',
    palette: {
      mode: 'light',
      surfaceDark: '#2A1D12',
      surfaceLight: '#FBF4EA',
      accent: '#C97A3A',
      secondary: '#7A6A5A',
      primary: '#2A1D12',
    },
  },
  {
    slug: 'forest-trade',
    label: 'Forest Trade',
    headline: 'Built to last.',
    pairsWith: 'Trades · Construction · Industrial',
    palette: {
      mode: 'dark',
      surfaceDark: '#10141A',
      surfaceLight: '#EAEFEF',
      accent: '#D97A3C',
      secondary: '#7A8090',
      primary: '#10141A',
    },
  },
  {
    slug: 'parchment-faith',
    label: 'Parchment',
    headline: 'Come as you are.',
    pairsWith: 'Communities · Nonprofits · Faith',
    palette: {
      mode: 'light',
      surfaceDark: '#1C1814',
      surfaceLight: '#FAF6EE',
      accent: '#8A6A4C',
      secondary: '#867E72',
      primary: '#1C1814',
    },
  },
  {
    slug: 'carbon-tech',
    label: 'Carbon',
    headline: 'Sharp & modern.',
    pairsWith: 'Software · SaaS · Developer tools',
    palette: {
      mode: 'dark',
      surfaceDark: '#06080D',
      surfaceLight: '#F4F6FB',
      accent: '#7DA6FF',
      secondary: '#7D8597',
      primary: '#06080D',
    },
  },
  {
    slug: 'sand-realty',
    label: 'Sand & Sea',
    headline: 'Calm and clear.',
    pairsWith: 'Real estate · Architecture · Property',
    palette: {
      mode: 'light',
      surfaceDark: '#0E0E0C',
      surfaceLight: '#F5F1EA',
      accent: '#7A8A6A',
      secondary: '#857E72',
      primary: '#0E0E0C',
    },
  },
  {
    slug: 'ink-portfolio',
    label: 'Ink',
    headline: 'Personal and direct.',
    pairsWith: 'Freelance · Coaches · Solo studios',
    palette: {
      mode: 'dark',
      surfaceDark: '#0D0E0D',
      surfaceLight: '#EEF0EC',
      accent: '#A8C97A',
      secondary: '#7F8278',
      primary: '#0D0E0D',
    },
  },
]

/** The base background + foreground a preset card renders with, derived
 *  from its mode. Dark mode shows the dark surface as the card bg with the
 *  light surface as text; light mode inverts. */
export function presetSurfaces(p: ThemePalette): { bg: string; fg: string } {
  return p.mode === 'dark'
    ? { bg: p.surfaceDark, fg: p.surfaceLight }
    : { bg: p.surfaceLight, fg: p.surfaceDark }
}
