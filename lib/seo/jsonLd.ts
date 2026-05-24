import 'server-only'
import { getSetting } from '@/lib/cms/getSettings'
import { env } from '@/lib/env'

// JSON-LD builders. Every public route emits at least one
// <script type="application/ld+json">. The shapes here mirror
// schema.org; renderers must wrap the output of
// JSON.stringify in safeJsonForScript (lib/seo/escape.ts) before
// inlining via dangerouslySetInnerHTML.
//
// SITE_ORIGIN comes from env so staging deploys can override it via
// the deploy environment without code change. Without env override,
// the apex is the canonical production host.

export async function organizationLd(): Promise<Record<string, unknown>> {
  // Both settings are independent; await in parallel. Sequential
  // awaits added one DB round-trip per public CMS page render.
  const [org, contact] = await Promise.all([
    getSetting('organization_json_ld'),
    getSetting('contact_info'),
  ])
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: org.name,
    alternateName: org.altName,
    logo: org.logoUrl.startsWith('http')
      ? org.logoUrl
      : `${env.SITE_ORIGIN}${org.logoUrl}`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: contact.address,
      addressCountry: 'GH',
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
// supplied free-text location as addressLocality and pin the
// country to Ghana (this is a Ghana-market site — the addressCountry
// hint helps Google Maps SERP geo-association).
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
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Residence',
    name: p.name,
    description: p.tagline ?? undefined,
    url: `${env.SITE_ORIGIN}/projects/${p.slug}`,
    image: p.heroImage ?? undefined,
  }
  if (p.location && p.location.trim()) {
    ld.address = {
      '@type': 'PostalAddress',
      addressLocality: p.location.trim(),
      addressCountry: 'GH',
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
  excerpt?: string | null
  heroImage?: string | null
  author: string
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    datePublished: p.publishedAt.toISOString(),
    description: p.excerpt ?? undefined,
    image: p.heroImage ?? undefined,
    author: { '@type': 'Person', name: p.author },
    mainEntityOfPage: `${env.SITE_ORIGIN}/blog/${p.slug}`,
  }
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
