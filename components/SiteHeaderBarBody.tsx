import Link from 'next/link'
import type { HeaderThemeClasses, ChromeOverrideProps } from '@/lib/cms/headerTheme'
import type { NavItem } from '@/lib/cms/navTypes'
import { isLikelyExternal } from '@/lib/url/external'
import { SiteHeaderMobile } from './SiteHeaderMobile'
import { SiteHeaderNav } from './SiteHeaderNav'

// The header bar's inner content — logo + brand on the left, nav in the
// centre, CTA on the right, hamburger on mobile. Shared by BOTH header
// modes so they can never drift:
//   - solid:   <SiteHeader> (server) renders it inside a sticky bar
//   - overlay: <SiteHeaderOverlay> (client) renders it inside a fixed
//              bar whose classes + logo flip on scroll
// No 'use client' directive — it stays a server component in the solid
// tree and becomes part of the client tree under the overlay wrapper.
//
// Dual-logo treatment: when `overlayLogoSrc` is set, BOTH <img>s are
// always in the DOM and visibility flips via the `hidden` class — so
// both files are fetched up front and the swap on the first scroll is
// instant, never a flash of missing logo.

interface Cta {
  text: string
  href: string
  openInNew?: boolean
}

interface Project {
  slug: string
  name: string
}

export interface SiteHeaderBarBodyProps {
  theme: HeaderThemeClasses
  brandText: string
  logoSrc: string | null
  logoAlt: string
  logoMaxHeight: number
  /** White/light logo for the transparent overlay state. */
  overlayLogoSrc?: string | null
  /** True while the overlay header is in its transparent top state. */
  showOverlayLogo?: boolean
  navItems: NavItem[]
  projects: Project[]
  pathname: string
  cta: Cta | null
  ctaOverride: ChromeOverrideProps | null
  navColor?: string | null
  navActiveColor?: string | null
}

export function SiteHeaderBarBody({
  theme,
  brandText,
  logoSrc,
  logoAlt,
  logoMaxHeight,
  overlayLogoSrc,
  showOverlayLogo,
  navItems,
  projects,
  pathname,
  cta,
  ctaOverride,
  navColor,
  navActiveColor,
}: SiteHeaderBarBodyProps) {
  const hasCta = cta !== null && cta.text.trim() !== '' && cta.href.trim() !== ''
  const overlayActive = Boolean(overlayLogoSrc && showOverlayLogo)

  return (
    <div className="flex items-center gap-4 px-6 py-4 sm:px-8 lg:px-12">
      <Link
        href="/"
        aria-label={brandText || 'Home'}
        className={`group flex items-center gap-3 ${theme.brand}`}
      >
        {logoSrc || overlayLogoSrc ? (
          <>
            {logoSrc && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt={logoAlt}
                style={{ height: `${logoMaxHeight}px` }}
                className={`w-auto max-w-[280px] object-contain${overlayActive ? ' hidden' : ''}`}
              />
            )}
            {overlayLogoSrc && (
              // Hidden only when the main logo exists to take over — if the
              // operator uploaded ONLY the overlay logo, it stays visible in
              // the solid state too (a blank brand area is never acceptable).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={overlayLogoSrc}
                alt={logoAlt}
                style={{ height: `${logoMaxHeight}px` }}
                className={`w-auto max-w-[280px] object-contain${overlayActive || !logoSrc ? '' : ' hidden'}`}
              />
            )}
          </>
        ) : (
          <span className="font-serif text-xl font-bold tracking-tight">
            {brandText || 'CaveCMS'}
          </span>
        )}
        {(logoSrc || overlayLogoSrc) && brandText && (
          <span className={`hidden font-serif text-base font-semibold tracking-tight sm:inline ${theme.brand}`}>
            {brandText}
          </span>
        )}
      </Link>

      <SiteHeaderNav
        navItems={navItems}
        theme={theme}
        projects={projects}
        initialPathname={pathname}
        navColor={navColor ?? undefined}
        navActiveColor={navActiveColor ?? undefined}
      />

      {hasCta && (
        <Link
          href={cta.href}
          target={cta.openInNew || isLikelyExternal(cta.href) ? '_blank' : undefined}
          rel={cta.openInNew || isLikelyExternal(cta.href) ? 'noopener noreferrer' : undefined}
          className={`ml-auto hidden w-fit items-center gap-2 rounded-full px-5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.22em] transition-all sm:inline-flex lg:ml-6 ${theme.cta}${ctaOverride ? ` ${ctaOverride.className}` : ''}`}
          style={ctaOverride?.style}
        >
          {cta.text}
        </Link>
      )}

      <div className="ml-auto lg:hidden">
        <SiteHeaderMobile
          navItems={navItems}
          cta={hasCta ? cta : null}
          theme={theme}
          projects={projects}
          ctaOverride={ctaOverride}
          navColor={navColor ?? undefined}
          navActiveColor={navActiveColor ?? undefined}
        />
      </div>
    </div>
  )
}
