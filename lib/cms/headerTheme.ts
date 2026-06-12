// Shared class-set map for the public site header + its mobile drawer.
// Both surfaces consume the same `theme` enum value from settings, so
// keeping the mapping here means the bar and the drawer can never
// drift (e.g. dark bar, light drawer) when an operator switches the
// theme in Settings → Site header.
//
// Each theme covers EVERY foreground/background pair the header
// renders — the bar surface, the brand text, the nav-link rest +
// hover states, the primary CTA pill, the mobile hamburger button,
// the mobile drawer panel, and the drawer's own nav + CTA — so the
// CTA never visually disappears against its own background.
//
// Class strings are static (no template interpolation) so Tailwind's
// JIT scanner sees every utility used and emits them at build time.

import type { CSSProperties } from 'react'

export type HeaderTheme = 'cream' | 'obsidian' | 'ivory' | 'champagne' | 'bone'

export interface HeaderThemeClasses {
  // Desktop bar
  bar: string
  brand: string
  nav: string
  navHover: string
  /** Class applied when the nav link points at the current pathname.
   *  Per-theme so the active treatment uses the right accent against
   *  the bar background (champagne on obsidian, copper on cream, etc.). */
  navActive: string
  cta: string
  // Mobile-only
  hamburger: string
  drawer: string
  drawerNav: string
  /** Mobile drawer active-link treatment — same role as `navActive`. */
  drawerNavActive: string
  drawerClose: string
  drawerCta: string
}

export const HEADER_THEMES: Record<HeaderTheme, HeaderThemeClasses> = {
  cream: {
    bar: 'border-b border-warm-stone/15 bg-cream/85 backdrop-blur-md',
    brand: 'text-near-black',
    nav: 'text-near-black/80',
    navHover: 'hover:text-copper-700',
    navActive: 'text-copper-700 font-semibold',
    cta: 'bg-near-black text-cream-50 hover:bg-copper-700 hover:shadow-[0_18px_40px_-22px_color-mix(in_srgb,var(--brand-copper-500)_60%,transparent)]',
    hamburger: 'text-near-black hover:bg-warm-stone/10',
    drawer: 'bg-cream-50',
    drawerNav: 'text-near-black hover:bg-warm-stone/10',
    drawerNavActive: 'bg-copper-100 text-copper-700',
    drawerClose: 'text-near-black hover:bg-warm-stone/10',
    drawerCta: 'bg-near-black text-cream-50 hover:bg-copper-700',
  },
  obsidian: {
    // Solid bg-obsidian (no /90 alpha, no backdrop-blur). The
    // translucent-glass treatment used on light themes desaturates
    // the bar over a cream page body, making the header read as a
    // lighter grey than the obsidian hero section directly below it.
    // For the obsidian theme the visual identity is "deep black bar",
    // not "frosted glass" — so the bar matches a pure-obsidian section.
    bar: 'border-b border-champagne/15 bg-obsidian',
    brand: 'text-ivory',
    nav: 'text-ivory/80',
    navHover: 'hover:text-champagne',
    navActive: 'text-champagne font-semibold',
    cta: 'bg-champagne text-obsidian hover:bg-cream-50 hover:shadow-[0_18px_40px_-22px_color-mix(in_srgb,var(--brand-accent)_50%,transparent)]',
    hamburger: 'text-ivory hover:bg-ivory/10',
    drawer: 'bg-obsidian',
    drawerNav: 'text-ivory hover:bg-ivory/10',
    drawerNavActive: 'bg-champagne/15 text-champagne',
    drawerClose: 'text-ivory hover:bg-ivory/10',
    drawerCta: 'bg-champagne text-obsidian hover:bg-cream-50',
  },
  ivory: {
    bar: 'border-b border-obsidian/10 bg-ivory/90 backdrop-blur-md',
    brand: 'text-obsidian',
    nav: 'text-obsidian/80',
    navHover: 'hover:text-copper-700',
    navActive: 'text-copper-700 font-semibold',
    cta: 'bg-obsidian text-ivory hover:bg-copper-700 hover:shadow-[0_18px_40px_-22px_color-mix(in_srgb,var(--brand-copper-500)_60%,transparent)]',
    hamburger: 'text-obsidian hover:bg-obsidian/10',
    drawer: 'bg-ivory',
    drawerNav: 'text-obsidian hover:bg-obsidian/10',
    drawerNavActive: 'bg-copper-100 text-copper-700',
    drawerClose: 'text-obsidian hover:bg-obsidian/10',
    drawerCta: 'bg-obsidian text-ivory hover:bg-copper-700',
  },
  champagne: {
    bar: 'border-b border-obsidian/15 bg-champagne/90 backdrop-blur-md',
    brand: 'text-obsidian',
    nav: 'text-obsidian/80',
    navHover: 'hover:text-obsidian',
    navActive: 'text-obsidian font-semibold',
    cta: 'bg-obsidian text-champagne hover:bg-near-black hover:shadow-[0_18px_40px_-22px_color-mix(in_srgb,var(--brand-near-black)_50%,transparent)]',
    hamburger: 'text-obsidian hover:bg-obsidian/10',
    drawer: 'bg-champagne',
    drawerNav: 'text-obsidian hover:bg-obsidian/10',
    drawerNavActive: 'bg-obsidian/15 text-obsidian',
    drawerClose: 'text-obsidian hover:bg-obsidian/10',
    drawerCta: 'bg-obsidian text-champagne hover:bg-near-black',
  },
  bone: {
    bar: 'border-b border-obsidian/10 bg-bone/90 backdrop-blur-md',
    brand: 'text-obsidian',
    nav: 'text-obsidian/80',
    navHover: 'hover:text-copper-700',
    navActive: 'text-copper-700 font-semibold',
    cta: 'bg-obsidian text-bone hover:bg-copper-700 hover:shadow-[0_18px_40px_-22px_color-mix(in_srgb,var(--brand-copper-500)_60%,transparent)]',
    hamburger: 'text-obsidian hover:bg-obsidian/10',
    drawer: 'bg-bone',
    drawerNav: 'text-obsidian hover:bg-obsidian/10',
    drawerNavActive: 'bg-copper-100 text-copper-700',
    drawerClose: 'text-obsidian hover:bg-obsidian/10',
    drawerCta: 'bg-obsidian text-bone hover:bg-copper-700',
  },
}

// ─── Operator colour overrides for chrome buttons + nav links ─────────
// Optional hex overrides from settings (site_header.cta*/nav*, footer
// accent/cta*) translate to the shared `.cms-rest-*` / `.cms-hover`
// CSS-var pattern (globals.css) — NOT inline background/color styles,
// because an inline style would beat the `.cms-hover:hover` rule and
// kill the hover override. Returns null when nothing is overridden so
// callers can skip the props entirely (theme classes alone, unchanged
// markup for existing installs).

export interface ChromeOverrideProps {
  className: string
  style: CSSProperties
}

export function ctaOverrideProps(o: {
  fill?: string | null
  text?: string | null
  hoverFill?: string | null
  hoverText?: string | null
  radius?: number | null
}): ChromeOverrideProps | null {
  const style: Record<string, string> = {}
  const classes: string[] = []
  if (o.fill) {
    style['--cms-rest-bg'] = o.fill
    classes.push('cms-rest-bg')
  }
  if (o.text) {
    style['--cms-rest-fg'] = o.text
    classes.push('cms-rest-fg')
  }
  if (o.hoverFill || o.hoverText) {
    classes.push('cms-hover')
    if (o.hoverFill) style['--cms-hover-bg'] = o.hoverFill
    if (o.hoverText) style['--cms-hover-fg'] = o.hoverText
  }
  if (typeof o.radius === 'number') style.borderRadius = `${o.radius}px`
  if (classes.length === 0 && Object.keys(style).length === 0) return null
  return { className: classes.join(' '), style: style as CSSProperties }
}

// Nav-link colour overrides. Rest links take navColor via the rest-var
// (so hover can still change colour); when navActiveColor is set it
// doubles as the rest links' hover colour (hover previews the active
// treatment). Active links take navActiveColor as a plain inline color.
export function navLinkOverrideProps(
  active: boolean,
  navColor?: string | null,
  navActiveColor?: string | null,
): ChromeOverrideProps | null {
  if (active) {
    if (!navActiveColor) return null
    return { className: '', style: { color: navActiveColor } }
  }
  const style: Record<string, string> = {}
  const classes: string[] = []
  if (navColor) {
    style['--cms-rest-fg'] = navColor
    classes.push('cms-rest-fg')
  }
  if (navActiveColor) {
    style['--cms-hover-fg'] = navActiveColor
    classes.push('cms-hover')
  }
  if (classes.length === 0) return null
  return { className: classes.join(' '), style: style as CSSProperties }
}

// Active-link predicate for nav items. The home link ('/') needs strict
// equality — otherwise `pathname.startsWith('/')` would match every
// page on the site and Home would always read as active. Every other
// link matches by prefix so /projects/<any-slug> still highlights the
// Projects entry.
export function isNavLinkActive(href: string, pathname: string): boolean {
  if (!href.startsWith('/')) return false
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

// Resolves an arbitrary stored value to a known theme. Zod's default
// already guards reads through getSetting(), but a hand-edited
// settings row or a future enum extension could still ship an unknown
// string into the renderer; this fallback keeps the public page from
// rendering an un-themed (transparent) bar.
export function resolveHeaderTheme(value: unknown): HeaderThemeClasses {
  if (typeof value === 'string' && value in HEADER_THEMES) {
    return HEADER_THEMES[value as HeaderTheme]
  }
  return HEADER_THEMES.cream
}
