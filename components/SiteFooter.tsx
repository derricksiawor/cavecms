import Link from 'next/link'
import { headers } from 'next/headers'
import { ensurePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { getSetting } from '@/lib/cms/getSettings'
import { resolveMedia } from '@/lib/cms/resolveMedia'
import { isLikelyExternal, externalRel } from '@/lib/url/external'
import { NewsletterForm } from '@/components/leads/NewsletterForm'
import { CfSafeMailto } from '@/components/CfSafeMailto'

// Public site footer. Renders the newsletter signup form with a
// freshly-minted HMAC preCsrf nonce so a same-page POST works
// without a separate fetch. Contact + footer columns flow from
// the settings registry (admin-editable in Plan 08).
//
// The component is async + server-only so the nonce, contact info,
// and footer columns all land in the streamed HTML. The newsletter
// signup is a client island (NewsletterForm) that fetches via JS so
// a successful submit doesn't full-page-navigate to the API's JSON
// response — visitor stays on the current page and sees an inline
// "check your inbox" confirmation. The CSRF nonce is minted
// server-side and passed in as a prop so the same-page POST works
// without an extra round trip.
//
// Suppressed on /admin/* via the x-pathname header set by
// middleware. Without this, the root layout's <SiteFooter /> would
// leak under admin pages (route groups don't create their own root
// layout — both layouts apply).
//
// Resilience: every data fetch is wrapped so a transient DB
// outage degrades the footer (no newsletter form, defaulted
// settings) instead of taking the entire site dark — the root
// layout's `error.tsx` boundary does NOT catch errors thrown
// from layout-level components, so any throw here surfaces as a
// site-wide 500.

const DEFAULT_CONTACT = {
  phone: '',
  email: '',
  address: '',
  hours: '',
}
interface FooterShape {
  tagline: string
  columns: Array<{ label: string; links: Array<{ text: string; href: string }> }>
  logo?: { media_id: number; alt: string } | null
  newsletterHeading?: string
  newsletterBody?: string
  newsletterCtaLabel?: string
  copyright?: string
  legalLinks?: Array<{ text: string; href: string }>
}
const DEFAULT_FOOTER: FooterShape = {
  tagline: '',
  columns: [],
  logo: null,
  newsletterHeading: 'Stay informed',
  newsletterBody:
    'Quarterly updates on new launches and project milestones. One click to unsubscribe.',
  newsletterCtaLabel: 'Subscribe',
  copyright: '',
  legalLinks: [],
}

export async function SiteFooter() {
  const pathname = (await headers()).get('x-pathname') ?? ''
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return null
  // Also skip the unsubscribe + confirm surfaces — those pages render
  // their own minimal chrome and the footer's newsletter form on the
  // unsubscribe page would be actively confusing.
  if (pathname === '/unsubscribe') return null
  if (pathname.startsWith('/newsletter/confirm/')) return null

  let csrf = ''
  let contact: typeof DEFAULT_CONTACT = DEFAULT_CONTACT
  let footer: FooterShape = DEFAULT_FOOTER
  let headerBrand = 'CaveCMS'
  let headerLogoId: number | null = null

  // Promise.allSettled — one failed read (e.g. transient mysql blip on
  // the footer row) shouldn't black-hole the entire footer. Each
  // setting degrades to its default independently.
  const settled = await Promise.allSettled([
    ensurePublicPreCsrf(),
    getSetting('contact_info'),
    getSetting('footer'),
    getSetting('site_header'),
    getSetting('mobile_cta'),
  ])
  const logDegraded = (key: string, err: unknown) => {
    // Scrub the log — mysql2 messages can echo SQL fragments + bound
    // parameter values on certain errno classes. Keep only the
    // diagnostic discriminators (name + mysql code).
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code).slice(0, 60)
        : undefined
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'site_footer_degraded',
        key,
        err_name: err instanceof Error ? err.name : 'unknown',
        ...(code ? { mysql_code: code } : {}),
      }),
    )
  }
  if (settled[0].status === 'fulfilled') csrf = settled[0].value
  else logDegraded('preCsrf', settled[0].reason)
  if (settled[1].status === 'fulfilled') contact = settled[1].value
  else logDegraded('contact_info', settled[1].reason)
  if (settled[2].status === 'fulfilled') footer = settled[2].value as FooterShape
  else logDegraded('footer', settled[2].reason)
  if (settled[3].status === 'fulfilled') {
    headerBrand = settled[3].value.brandText || headerBrand
    headerLogoId = settled[3].value.logo?.media_id ?? null
  } else {
    logDegraded('site_header', settled[3].reason)
  }
  // Mobile CTA awareness — when the operator's sticky bottom pill is
  // enabled with at least one button, the footer extends its own dark
  // `bg-near-black` down by the pill's full visual footprint so the
  // gap between footer copyright and pill matches the footer's theme
  // (no cream body-bg seam below the dark footer). md:pb-0 disables
  // on desktop where the pill is hidden.
  let mobileCtaOn = false
  if (settled[4].status === 'fulfilled') {
    const cta = settled[4].value
    mobileCtaOn = cta.enabled && cta.buttons.length > 0
  } else {
    logDegraded('mobile_cta', settled[4].reason)
  }

  // Resolve the footer logo if set, else fall back to the header
  // logo. Either may be null — in which case we render brand text.
  // Same layout-throw concern as SiteHeader — wrap in try/catch.
  const footerLogoId = footer.logo?.media_id ?? headerLogoId
  let resolvedLogo = null
  if (footerLogoId) {
    try {
      resolvedLogo = await resolveMedia(footerLogoId)
    } catch (err) {
      logDegraded('logo_resolve', err)
    }
  }
  const logoSrc = resolvedLogo?.md ?? resolvedLogo?.lg ?? resolvedLogo?.thumb ?? null
  const logoAlt =
    footer.logo?.alt || resolvedLogo?.alt || headerBrand

  const newsletterHeading = footer.newsletterHeading || 'Stay informed'
  const newsletterBody =
    footer.newsletterBody ||
    'Quarterly updates on new launches and project milestones. One click to unsubscribe.'
  const newsletterCtaLabel = footer.newsletterCtaLabel || 'Subscribe'
  const copyrightText = (footer.copyright?.trim() || headerBrand).trim()
  const legalLinks = footer.legalLinks ?? []

  return (
    <footer
      className={`bg-near-black text-cream-50${mobileCtaOn ? ' pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-0' : ''}`}
    >
      <div className="max-w-6xl mx-auto px-6 py-16 grid grid-cols-1 md:grid-cols-3 gap-12">
        <div>
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoSrc}
              alt={logoAlt}
              className="h-12 w-auto max-w-[200px] object-contain brightness-0 invert"
            />
          ) : (
            <p className="font-serif text-2xl font-bold tracking-tight">
              {headerBrand}
            </p>
          )}
          {footer.tagline && (
            <p className="mt-4 text-sm text-cream-50/70 max-w-xs leading-relaxed">
              {footer.tagline}
            </p>
          )}
          {(contact.address || contact.phone || contact.email) && (
            <address className="not-italic mt-6 text-sm text-cream-50/80 leading-relaxed">
              {contact.address && (
                // Address → Google Maps search link so visitors on a
                // phone can tap straight into navigation. encodeURI
                // covers the address punctuation; the search URL
                // works without an API key. min-h ensures the tap
                // target clears Apple HIG 44pt on phones. Audit
                // findings V7 + V8 (Chunk K).
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(contact.address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block min-h-[44px] py-2 hover:text-copper-300 transition-colors"
                >
                  {contact.address}
                </a>
              )}
              {contact.phone && (
                <a
                  href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                  className="block min-h-[44px] py-2 mt-1 hover:text-copper-300 transition-colors"
                >
                  {contact.phone}
                </a>
              )}
              {contact.email && (
                <CfSafeMailto
                  email={contact.email}
                  className="block min-h-[44px] py-2 mt-1 hover:text-copper-300 transition-colors break-all"
                />
              )}
              {contact.hours && (
                <span className="block mt-3 text-xs text-cream-50/50">
                  {contact.hours}
                </span>
              )}
            </address>
          )}
        </div>

        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-400">
            {newsletterHeading}
          </h2>
          <p className="mt-4 text-sm text-cream-50/70 leading-relaxed">
            {newsletterBody}
          </p>
          {csrf ? (
            <NewsletterForm csrf={csrf} ctaLabel={newsletterCtaLabel} />
          ) : (
            // CSRF nonce mint failed (upstream blip). Skip the form
            // rather than render a guaranteed-fail submission UX —
            // the contact block + columns above still render.
            <p className="mt-6 text-sm text-cream-50/50">
              Newsletter signup temporarily unavailable.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6">
          {footer.columns.map((c) => (
            <div key={c.label}>
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.32em] text-copper-400">
                {c.label}
              </h4>
              <ul className="mt-3 space-y-2">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <a
                      href={l.href}
                      target={isLikelyExternal(l.href) ? '_blank' : undefined}
                      rel={externalRel(l.href, true)}
                      className="text-sm text-cream-50/80 hover:text-cream-50 transition-colors"
                    >
                      {l.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-cream-50/10">
        {/* On mobile: stacked + centered (single column, items
           center horizontally). On md+: flex-row with copyright
           left, legal links right (the original layout). The
           md:justify-between brings the desktop split back. */}
        <div className="max-w-6xl mx-auto flex flex-col items-center text-center md:flex-row md:flex-wrap md:items-center md:justify-between md:text-left gap-3 px-6 py-6 text-xs text-cream-50/50">
          <span>
            © {new Date().getFullYear()} {copyrightText}. All rights reserved.
          </span>
          {legalLinks.length > 0 && (
            <nav aria-label="Legal" className="flex flex-wrap items-center gap-4">
              {legalLinks.map((l) => (
                <Link
                  key={`${l.text}-${l.href}`}
                  href={l.href}
                  target={isLikelyExternal(l.href) ? '_blank' : undefined}
                  rel={externalRel(l.href, true)}
                  className="text-cream-50/60 transition-colors hover:text-cream-50"
                >
                  {l.text}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </div>
    </footer>
  )
}
