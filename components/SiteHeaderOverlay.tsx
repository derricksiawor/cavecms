'use client'

import { useEffect, useState } from 'react'
import type { HeaderThemeClasses } from '@/lib/cms/headerTheme'
import {
  SiteHeaderBarBody,
  type SiteHeaderBarBodyProps,
} from './SiteHeaderBarBody'

// Overlay header mode (site_header.headerMode === 'overlay'): the bar
// floats TRANSPARENT over the first section so the hero shows through,
// then turns into the solid themed bar once the page scrolls. The logo
// flips with it — the overlay logo (usually a white version) while
// transparent, the main logo once solid. Both logos are kept in the DOM
// by SiteHeaderBarBody so the swap is instant.
//
// `fixed` (not sticky) so the bar takes no layout space and the hero
// starts at y=0 behind it — that's what makes it an overlay.
//
// Scroll threshold: a few px of give so a trackpad micro-scroll doesn't
// flicker the bar, but the solid state arrives before the hero's edge.
const SCROLL_THRESHOLD = 16

type OverlayProps = Omit<SiteHeaderBarBodyProps, 'theme' | 'showOverlayLogo'> & {
  solidTheme: HeaderThemeClasses
  overlayTheme: HeaderThemeClasses
}

export function SiteHeaderOverlay({
  solidTheme,
  overlayTheme,
  navColor,
  navActiveColor,
  ...bar
}: OverlayProps) {
  // SSR + first paint render the transparent top state (every page
  // load starts at the top; a mid-page reload corrects on mount).
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const theme = scrolled ? solidTheme : overlayTheme

  return (
    <header
      data-site-header
      data-scrolled={scrolled || undefined}
      className={`fixed inset-x-0 top-0 z-30 transition-colors duration-300 ${theme.bar}`}
    >
      <SiteHeaderBarBody
        {...bar}
        theme={theme}
        showOverlayLogo={!scrolled}
        // The operator's nav colour overrides are tuned against the
        // solid themed bar — over the hero photo the tone classes own
        // the colours, so the hex overrides only apply once solid.
        navColor={scrolled ? navColor : undefined}
        navActiveColor={scrolled ? navActiveColor : undefined}
      />
    </header>
  )
}
