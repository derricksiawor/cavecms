import 'server-only'
import { getSetting } from '@/lib/cms/getSettings'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { resolveMedia } from '@/lib/cms/resolveMedia'

// JSON-LD builders. Every public route emits at least one
// <script type="application/ld+json">. The shapes here mirror
// schema.org; renderers must wrap the output of
// JSON.stringify in safeJsonForScript (lib/seo/escape.ts) before
// inlining via dangerouslySetInnerHTML.
//
// The operator's public site URL comes from Settings → General →
// Site URL (DB-stored). When unset, absolute URLs are omitted from
// the emitted JSON-LD — search engines tolerate that better than
// being given a wrong canonical.

export async function organizationLd(): Promise<Record<string, unknown>> {
  // Settings + site origin are independent; await in parallel. The
  // header is fetched too so the Organization logo can fall back to the
  // site-header logo when the operator hasn't set a dedicated one.
  const [org, contact, header, siteOrigin] = await Promise.all([
    getSetting('organization_json_ld'),
    getSetting('contact_info'),
    getSetting('site_header'),
    getSiteOrigin(),
  ])

  // Logo resolution (no operator URL-typing — see organization_json_ld
  // schema): the dedicated Google logo upload wins; otherwise reuse the
  // site-header logo; otherwise omit `logo` entirely. resolveMedia
  // returns a same-origin variant path, which we make absolute with the
  // site origin (schema.org prefers an absolute logo URL). A media row
  // that's missing or still processing degrades to "no logo".
  const logoMediaId = org.logo?.media_id ?? header.logo?.media_id ?? null
  let logoUrl: string | undefined
  if (logoMediaId != null) {
    const media = await resolveMedia(logoMediaId)
    const path = media?.md ?? media?.lg ?? media?.og ?? media?.thumb ?? null
    if (path) {
      logoUrl = path.startsWith('http')
        ? path
        : siteOrigin
          ? `${siteOrigin}${path}`
          : path
    }
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: org.name,
    alternateName: org.altName,
    // Omitted (undefined → dropped by JSON.stringify) when no logo is
    // configured anywhere — a missing logo beats a broken one.
    logo: logoUrl,
    address: {
      '@type': 'PostalAddress',
      streetAddress: contact.address,
    },
    telephone: contact.phone,
    email: contact.email,
    sameAs: org.sameAs ?? [],
  }
}

// Residence — schema.org/Residence for a real-estate development.
// Some indexers prefer schema.org/RealEstateListing for individual
// units; this site sells whole developments so Residence is correct.
//
// `address` is a schema.org PostalAddress; we emit the operator-
// supplied free-text location as addressLocality. addressCountry is
// intentionally omitted — operators in different markets should set
// it via a future Settings → SEO field (not hardcoded).
//
// `offers` is an AggregateOffer summarising the pricing range when
// numeric prices + currency are present. Indexers use this for
// rich-result eligibility on property listing pages.
export function residenceLd(p: {
  name: string
  tagline?: string | null
  slug: string
  heroImage?: string | null
  location?: string | null
  priceMin?: number
  priceMax?: number
  priceCurrency?: string
  /** Operator's site URL from Settings → General. When null, the
   *  `url` field is omitted entirely (a wrong URL is worse than no
   *  URL for indexers). */
  siteOrigin?: string | null
  // blog-system worktree (Phase 5): optional pre-built same-origin path for the
  // project (segment-aware, from lib/blog/urls.projectUrl). When provided it
  // overrides the literal `/projects/<slug>` so a custom projects segment is
  // honored. Falls back to the literal default when omitted (byte-identical to
  // pre-Phase-5). Localized, additive change — keeps this shared helper mergeable
  // with the parallel SEO worktree (spec §11).
  urlPath?: string
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Residence',
    name: p.name,
    description: p.tagline ?? undefined,
    image: p.heroImage ?? undefined,
  }
  if (p.siteOrigin) {
    ld.url = `${p.siteOrigin}${p.urlPath ?? `/projects/${p.slug}`}`
  }
  if (p.location && p.location.trim()) {
    ld.address = {
      '@type': 'PostalAddress',
      addressLocality: p.location.trim(),
    }
  }
  // Emit offers only when we have both prices (or one + currency).
  // A bare currency with no numbers is meaningless to indexers.
  if (
    p.priceCurrency &&
    (typeof p.priceMin === 'number' || typeof p.priceMax === 'number')
  ) {
    const offer: Record<string, unknown> = {
      '@type': 'AggregateOffer',
      priceCurrency: p.priceCurrency.toUpperCase(),
    }
    if (typeof p.priceMin === 'number') offer.lowPrice = p.priceMin
    if (typeof p.priceMax === 'number') offer.highPrice = p.priceMax
    ld.offers = offer
  }
  return ld
}

export function blogPostingLd(p: {
  title: string
  slug: string
  publishedAt: Date
  // blog-system worktree (Phase 7): the post's last-edit time (posts.updated_at).
  // Additive + optional so the call sites that don't pass it (and the parallel
  // SEO worktree) stay byte-identical — `dateModified` is emitted only when a
  // value is supplied. Localized to this single field per spec §11 to keep the
  // shared helper mergeable.
  modifiedAt?: Date | null
  excerpt?: string | null
  heroImage?: string | null
  author: string
  /** Operator's site URL from Settings → General. Omits
   *  `mainEntityOfPage` when null. */
  siteOrigin?: string | null
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    datePublished: p.publishedAt.toISOString(),
    // blog-system worktree (Phase 7): emit dateModified when updated_at is
    // supplied AND it is a valid date. Google's Article rich-result spec
    // recommends dateModified alongside datePublished; omitting it when absent
    // (rather than defaulting to publishedAt) keeps the signal honest.
    dateModified:
      p.modifiedAt && !Number.isNaN(p.modifiedAt.getTime())
        ? p.modifiedAt.toISOString()
        : undefined,
    description: p.excerpt ?? undefined,
    image: p.heroImage ?? undefined,
    author: { '@type': 'Person', name: p.author },
  }
  if (p.siteOrigin) {
    ld.mainEntityOfPage = `${p.siteOrigin}/blog/${p.slug}`
  }
  return ld
}

export function breadcrumbLd(
  items: ReadonlyArray<{ name: string; url: string }>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: i.name,
      item: i.url,
    })),
  }
}
