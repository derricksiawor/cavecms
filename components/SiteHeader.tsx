import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { env } from '@/lib/env'
import { getSetting } from '@/lib/cms/getSettings'
import type { SettingsValue } from '@/lib/cms/settings-registry'
import { resolveMedia } from '@/lib/cms/resolveMedia'
import {
  resolveHeaderTheme,
  resolveOverlayTopTheme,
  ctaOverrideProps,
} from '@/lib/cms/headerTheme'
import { SiteHeaderBarBody } from './SiteHeaderBarBody'
import { SiteHeaderOverlay } from './SiteHeaderOverlay'

// Public site header — logo + brand text on the left, navigation
// in the centre, optional primary CTA on the right. All operator-
// editable via Settings → Site header.
//
// Server component so the rendered HTML ships with the streamed
// response (no SSR-then-hydrate flash). The mobile drawer behaviour
// lives in a sibling client component <SiteHeaderMobile> that
// receives the same nav payload as props.
//
// Suppressed on /admin/*, the hidden login path, /auth/* etc. via
// the x-pathname header set by middleware. Without this, the root
// layout's <SiteHeader /> would stack on top of the admin shell or
// onto single-purpose auth flows.
//
// SECURITY: the hidden login path is sourced from `env.LOGIN_PATH`
// — NEVER hard-code its literal value here. Per project standards security
// gold standard, the secret login path must not appear in source.

const FIXED_EXCLUDED_PREFIXES = [
  '/admin',
  '/auth',
  '/unsubscribe',
  '/newsletter',
]

function isExcludedPath(pathname: string): boolean {
  if (pathname === '/admin') return true
  for (const p of FIXED_EXCLUDED_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return true
  }
  const loginPath = env.LOGIN_PATH
  if (loginPath) {
    if (
      pathname === `/${loginPath}` ||
      pathname.startsWith(`/${loginPath}/`)
    ) {
      return true
    }
  }
  return false
}

export async function SiteHeader() {
  const pathname = (await headers()).get('x-pathname') ?? ''
  if (isExcludedPath(pathname)) return null

  let header: SettingsValue<'site_header'>
  try {
    header = await getSetting('site_header')
  } catch (err) {
    // Layout-level throws become site-wide 500s (no error boundary
    // catches them). Match SiteFooter's structured log so a degraded
    // header is observable in stderr, then fall back to safe defaults.
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code).slice(0, 60)
        : undefined
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'site_header_degraded',
        err_name: err instanceof Error ? err.name : 'unknown',
        ...(code ? { mysql_code: code } : {}),
      }),
    )
    header = {
      brandText: 'CaveCMS',
      logo: null,
      logoMaxHeight: 40,
      theme: 'cream' as const,
      headerMode: 'solid' as const,
      overlayTone: 'light' as const,
      navItems: [],
      primaryCta: { text: '', href: '' },
    }
  }
  const theme = resolveHeaderTheme(
    (header as { theme?: unknown }).theme,
  )

  // resolveMedia can throw under DB pressure (pool exhaustion, etc).
  // Same layout-level-throw concern as above — wrap in try/catch so a
  // transient media-table blip doesn't 500 every public route.
  let logo = null
  if (header.logo) {
    try {
      logo = await resolveMedia(header.logo.media_id)
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'site_header_logo_degraded',
          media_id: header.logo.media_id,
          err_name: err instanceof Error ? err.name : 'unknown',
        }),
      )
    }
  }
  const logoSrc = logo?.md ?? logo?.lg ?? logo?.thumb ?? null
  const logoAlt = header.logo?.alt || logo?.alt || header.brandText

  // Overlay mode's transparent-state logo (usually a white version).
  // Same degraded-fallback pattern as the main logo above.
  const headerMode = header.headerMode ?? 'solid'
  let overlayLogoSrc: string | null = null
  if (headerMode === 'overlay' && header.overlayLogo) {
    try {
      const om = await resolveMedia(header.overlayLogo.media_id)
      overlayLogoSrc = om?.md ?? om?.lg ?? om?.thumb ?? null
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'site_header_overlay_logo_degraded',
          media_id: header.overlayLogo.media_id,
          err_name: err instanceof Error ? err.name : 'unknown',
        }),
      )
    }
  }

  const cta = header.primaryCta

  // Optional operator colour overrides (Settings → Site header). Null
  // when nothing is set → the theme class set renders unchanged.
  const ctaOv = ctaOverrideProps({
    fill: header.ctaFillColor,
    text: header.ctaTextColor,
    hoverFill: header.ctaHoverFillColor,
    hoverText: header.ctaHoverTextColor,
    radius: header.ctaRadius,
  })
  const navColor = header.navColor
  const navActiveColor = header.navActiveColor

  // Published-projects list for the Projects nav dropdown. Sorted by
  // featured_order (NULLS LAST so curated featured items lead) then
  // alphabetical by name. Same degraded-fallback pattern as the
  // settings/logo fetches above — a DB hiccup collapses the dropdown
  // to a plain link, never 500s the whole site.
  let projectsList: { slug: string; name: string }[] = []
  try {
    const [rows] = (await db.execute(sql`
      SELECT slug, name
      FROM projects
      WHERE published = TRUE AND deleted_at IS NULL
      ORDER BY featured_order IS NULL, featured_order ASC, name ASC
    `)) as unknown as [Array<{ slug: string; name: string }>]
    projectsList = rows
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'site_header_projects_degraded',
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
  }

  // Shared bar-content props — identical for both modes so the two
  // headers can never drift (the bar body is one component).
  const barProps = {
    brandText: header.brandText,
    logoSrc,
    logoAlt,
    logoMaxHeight: header.logoMaxHeight ?? 40,
    navItems: header.navItems,
    projects: projectsList,
    pathname,
    cta: cta ?? null,
    ctaOverride: ctaOv,
    navColor,
    navActiveColor,
  }

  // Overlay mode: transparent bar floating over the first section,
  // turning into the solid themed bar on scroll (client wrapper owns
  // the scroll state + the logo swap).
  if (headerMode === 'overlay') {
    return (
      <SiteHeaderOverlay
        {...barProps}
        overlayLogoSrc={overlayLogoSrc}
        solidTheme={theme}
        overlayTheme={resolveOverlayTopTheme(header.overlayTone, theme)}
      />
    )
  }

  return (
    <header
      data-site-header
      className={`sticky top-0 z-30 ${theme.bar}`}
    >
      {/* Site-wide bar — content spans the viewport with modest edge
         padding (not the max-w-6xl content container the body sections
         use). Operator wants the header to read as part of the chrome,
         not as another centred content block. */}
      <SiteHeaderBarBody {...barProps} theme={theme} />
    </header>
  )
}
