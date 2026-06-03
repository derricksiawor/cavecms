// Pure JSON-LD (schema.org) builder functions.
//
// PURITY CONTRACT (load-bearing): this module is data-in / JSON-out.
// It has NO `import 'server-only'`, touches NO DB, NO `getSetting`, NO
// DOM — every function takes plain data and returns a plain object whose
// shape mirrors schema.org. That keeps the builders unit-testable in
// vitest's node environment and reusable from any context (server
// component, route handler, sitemap, future edge worker).
//
// RELATIONSHIP TO `lib/seo/jsonLd.ts`:
//   `jsonLd.ts` holds the ORIGINAL server-bound builders
//   (`organizationLd`, `blogPostingLd`, `residenceLd`, `breadcrumbLd`).
//   Those `await` Settings / resolve media and therefore import
//   `server-only`. This module CANNOT import them (server-only would
//   poison the pure graph), so the small amount of overlap is
//   intentional re-expression, NOT divergence:
//     • `breadcrumbListLd` here === the (currently unused) `breadcrumbLd`
//       there, byte-for-byte in output shape. Renamed to the canonical
//       schema.org type name; align on this one going forward.
//     • `articleLd` here is the GENERAL Article/BlogPosting/NewsArticle
//       builder; `blogPostingLd` in jsonLd.ts is the blog-post-specific,
//       Settings-aware variant that delegates the *shape* concept here.
//   Everything else (`faqPageLd`, `howToLd`, `productLd`,
//   `softwareApplicationLd`, `webPageLd`, `websiteLd`) is NEW — there is
//   no prior art to reuse.
//
// ESCAPING IS THE CALLER'S JOB. None of these functions escape their
// string inputs. The renderer must pass the returned object through
// `safeJsonForScript` (lib/seo/escape.ts) before inlining via
// dangerouslySetInnerHTML. Doing the escaping here would double-encode.
//
// UNDEFINED OMISSION. Optional fields are set to `undefined` (never
// `null`, never `""`) so `JSON.stringify` drops them — no
// `"image": null` noise reaches the page. Helper `compact()` strips
// undefined keys from a freshly-built object; nested objects use the
// same discipline inline.

const SCHEMA_CONTEXT = 'https://schema.org' as const

export type JsonLdObject = Record<string, unknown>

/** Drop keys whose value is `undefined` (top level). schema.org
 *  consumers treat a missing key and an explicit `null`/`undefined`
 *  differently for rich-result eligibility — omission is always the
 *  safer signal, so we never emit a key we don't have a real value for. */
function compact<T extends JsonLdObject>(obj: T): T {
  const out = {} as T
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as JsonLdObject)[k] = v
  }
  return out
}

/** Normalise an optional string: trims, and treats empty/whitespace-only
 *  as absent (→ undefined). Mirrors the `default_seo` empty-string-as-absent
 *  convention used in lib/seo/resolve.ts. */
function str(v: string | null | undefined): string | undefined {
  if (v == null) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

// ---------------------------------------------------------------------------
// Organization reference
// ---------------------------------------------------------------------------

/** A lightweight Organization reference used as `publisher` / `brand`.
 *  This is NOT the full sitewide Organization node (that one lives in
 *  `jsonLd.ts:organizationLd()` and is emitted once in the layout). When
 *  a graph needs to *point at* the publisher, it references it by name
 *  (+ optional logo as an ImageObject) so the relationship is explicit
 *  without re-declaring the whole entity. */
export interface OrganizationRefInput {
  name: string
  logo?: string | null
  url?: string | null
}

export function organizationRefLd(input: OrganizationRefInput): JsonLdObject {
  const logo = str(input.logo)
  return compact({
    '@type': 'Organization',
    name: input.name,
    url: str(input.url),
    logo: logo
      ? { '@type': 'ImageObject', url: logo }
      : undefined,
  })
}

// ---------------------------------------------------------------------------
// Article / BlogPosting / NewsArticle
// ---------------------------------------------------------------------------

export type ArticleType = 'Article' | 'BlogPosting' | 'NewsArticle'

export interface ArticleInput {
  /** Defaults to 'Article' when omitted. */
  type?: ArticleType
  headline: string
  description?: string | null
  /** Author display name → schema.org Person. */
  author: string
  /** ISO 8601 string OR a Date (Date is `.toISOString()`-ed). */
  datePublished: string | Date
  dateModified?: string | Date | null
  /** One image URL or several (schema.org allows string | string[]). */
  image?: string | string[] | null
  /** Canonical URL of the article page → mainEntityOfPage WebPage. */
  mainEntityOfPage?: string | null
  /** Publisher org (rendered as an Organization ref). */
  publisher?: OrganizationRefInput | null
}

function isoDate(v: string | Date | null | undefined): string | undefined {
  if (v == null) return undefined
  if (v instanceof Date) return v.toISOString()
  const t = v.trim()
  return t === '' ? undefined : t
}

function normaliseImage(
  img: string | string[] | null | undefined,
): string | string[] | undefined {
  if (img == null) return undefined
  if (Array.isArray(img)) {
    const cleaned = img.map((s) => str(s)).filter((s): s is string => !!s)
    return cleaned.length === 0
      ? undefined
      : cleaned.length === 1
        ? cleaned[0]
        : cleaned
  }
  return str(img)
}

export function articleLd(input: ArticleInput): JsonLdObject {
  const mainEntity = str(input.mainEntityOfPage)
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': input.type ?? 'Article',
    headline: input.headline,
    description: str(input.description),
    author: { '@type': 'Person', name: input.author },
    datePublished: isoDate(input.datePublished),
    dateModified: isoDate(input.dateModified),
    image: normaliseImage(input.image),
    mainEntityOfPage: mainEntity
      ? { '@type': 'WebPage', '@id': mainEntity }
      : undefined,
    publisher: input.publisher
      ? organizationRefLd(input.publisher)
      : undefined,
  })
}

// ---------------------------------------------------------------------------
// FAQPage
// ---------------------------------------------------------------------------

export interface FaqItem {
  question: string
  answer: string
}

/** Build an FAQPage node, or `null` when there are no items. A FAQPage with an
 *  empty `mainEntity` is invalid schema.org (Google rejects it for rich
 *  results) — returning null lets callers fall back to a saner shape. */
export function faqPageLd(items: ReadonlyArray<FaqItem>): JsonLdObject | null {
  if (items.length === 0) return null
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({
      '@type': 'Question',
      name: it.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: it.answer,
      },
    })),
  }
}

// ---------------------------------------------------------------------------
// HowTo
// ---------------------------------------------------------------------------

export interface HowToStepInput {
  name: string
  text: string
  url?: string | null
  image?: string | null
}

export interface HowToInput {
  name: string
  description?: string | null
  /** ISO 8601 duration, e.g. "PT2H30M". */
  totalTime?: string | null
  /** HowToSupply names (consumed during the task). */
  supply?: ReadonlyArray<string> | null
  /** HowToTool names (reused, not consumed). */
  tool?: ReadonlyArray<string> | null
  steps: ReadonlyArray<HowToStepInput>
}

function namedList(
  type: 'HowToSupply' | 'HowToTool',
  names: ReadonlyArray<string> | null | undefined,
): JsonLdObject[] | undefined {
  if (names == null) return undefined
  const cleaned = names.map((n) => str(n)).filter((n): n is string => !!n)
  if (cleaned.length === 0) return undefined
  return cleaned.map((name) => ({ '@type': type, name }))
}

export function howToLd(input: HowToInput): JsonLdObject {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'HowTo',
    name: input.name,
    description: str(input.description),
    totalTime: str(input.totalTime),
    supply: namedList('HowToSupply', input.supply),
    tool: namedList('HowToTool', input.tool),
    step: input.steps.map((s, i) =>
      compact({
        '@type': 'HowToStep',
        position: i + 1,
        name: s.name,
        text: s.text,
        url: str(s.url),
        image: str(s.image),
      }),
    ),
  })
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface OfferInput {
  price: string | number
  priceCurrency: string
  /** schema.org URL or short token — accepts "InStock" and normalises to
   *  the full schema.org enum URL. */
  availability?: string | null
  url?: string | null
  priceValidUntil?: string | null
}

export interface AggregateRatingInput {
  ratingValue: string | number
  reviewCount?: string | number | null
  ratingCount?: string | number | null
  bestRating?: string | number | null
  worstRating?: string | number | null
}

export interface ProductInput {
  name: string
  description?: string | null
  image?: string | string[] | null
  /** Brand name → schema.org Brand. */
  brand?: string | null
  offers?: OfferInput | null
  aggregateRating?: AggregateRatingInput | null
}

/** Normalise an availability token to the schema.org enum URL. Accepts
 *  a bare token ("InStock"), a full http(s) URL, or undefined. The URL test
 *  is strict (`/^https?:\/\//`) so a typo like "httptypo://x" is treated as a
 *  bare token and normalised under schema.org rather than passed through as a
 *  bogus absolute URL. */
function availabilityUrl(v: string | null | undefined): string | undefined {
  const t = str(v)
  if (!t) return undefined
  if (/^https?:\/\//.test(t)) return t
  const token = t.replace(/^https?:\/\/schema\.org\//, '')
  return `https://schema.org/${token}`
}

/** Coerce an operator-supplied price (string | number | unknown) to a string,
 *  or undefined when it is neither. Guards against malformed schemaData where
 *  `offers` was, say, `5` (handled upstream) or a missing/odd price field. */
function priceStr(p: unknown): string | undefined {
  if (typeof p === 'number' && Number.isFinite(p)) return String(p)
  if (typeof p === 'string') {
    const t = p.trim()
    return t === '' ? undefined : t
  }
  return undefined
}

/** Build an Offer node DEFENSIVELY. Operator JSON may be malformed (e.g.
 *  `offers: 5`, or an object missing price/currency). We never throw: a
 *  non-object, or an object without BOTH a usable price and currency, yields
 *  `undefined` so the caller simply omits `offers` rather than emitting a
 *  broken node or crashing on `.toUpperCase()` of a missing currency. */
function offerLd(o: unknown): JsonLdObject | undefined {
  if (o == null || typeof o !== 'object') return undefined
  const rec = o as Record<string, unknown>
  const price = priceStr(rec.price)
  const currency =
    typeof rec.priceCurrency === 'string' ? str(rec.priceCurrency) : undefined
  // A schema.org Offer needs at least a price; currency is required for a
  // valid PriceSpecification. Without both, omit the offer entirely.
  if (price === undefined || currency === undefined) return undefined
  return compact({
    '@type': 'Offer',
    price,
    priceCurrency: currency.toUpperCase(),
    availability: availabilityUrl(
      typeof rec.availability === 'string' ? rec.availability : undefined,
    ),
    url: typeof rec.url === 'string' ? str(rec.url) : undefined,
    priceValidUntil:
      typeof rec.priceValidUntil === 'string'
        ? str(rec.priceValidUntil)
        : undefined,
  })
}

/** Coerce a rating value (string | number) — returns undefined for anything
 *  else so a malformed `aggregateRating` can't produce a node without the
 *  required `ratingValue`. */
function ratingNumOrStr(v: unknown): string | number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  return undefined
}

/** Build an AggregateRating node DEFENSIVELY. Returns undefined when the input
 *  is not an object or lacks a usable `ratingValue` (the one required field),
 *  so malformed operator JSON omits the node rather than emitting an invalid
 *  AggregateRating or throwing. */
function aggregateRatingLd(r: unknown): JsonLdObject | undefined {
  if (r == null || typeof r !== 'object') return undefined
  const rec = r as Record<string, unknown>
  const ratingValue = ratingNumOrStr(rec.ratingValue)
  if (ratingValue === undefined) return undefined
  return compact({
    '@type': 'AggregateRating',
    ratingValue,
    reviewCount: ratingNumOrStr(rec.reviewCount),
    ratingCount: ratingNumOrStr(rec.ratingCount),
    bestRating: ratingNumOrStr(rec.bestRating),
    worstRating: ratingNumOrStr(rec.worstRating),
  })
}

export function productLd(input: ProductInput): JsonLdObject {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'Product',
    name: input.name,
    description: str(input.description),
    image: normaliseImage(input.image),
    brand: str(input.brand)
      ? { '@type': 'Brand', name: str(input.brand) }
      : undefined,
    // offerLd / aggregateRatingLd guard internally and return undefined for
    // null/malformed input, so we pass straight through (no pre-ternary needed).
    offers: offerLd(input.offers),
    aggregateRating: aggregateRatingLd(input.aggregateRating),
  })
}

// ---------------------------------------------------------------------------
// SoftwareApplication
// ---------------------------------------------------------------------------

export interface SoftwareApplicationInput {
  name: string
  description?: string | null
  /** e.g. "BusinessApplication", "WebApplication". */
  applicationCategory?: string | null
  /** e.g. "Web", "Windows, macOS, Linux". */
  operatingSystem?: string | null
  image?: string | string[] | null
  offers?: OfferInput | null
  aggregateRating?: AggregateRatingInput | null
}

export function softwareApplicationLd(
  input: SoftwareApplicationInput,
): JsonLdObject {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'SoftwareApplication',
    name: input.name,
    description: str(input.description),
    applicationCategory: str(input.applicationCategory),
    operatingSystem: str(input.operatingSystem),
    image: normaliseImage(input.image),
    offers: offerLd(input.offers),
    aggregateRating: aggregateRatingLd(input.aggregateRating),
  })
}

// ---------------------------------------------------------------------------
// WebPage / WebSite
// ---------------------------------------------------------------------------

export interface WebPageInput {
  name: string
  description?: string | null
  url?: string | null
  inLanguage?: string | null
  /** Overrides the @type — allows AboutPage / ContactPage / etc. while
   *  keeping the same shape, aligning with page-jsonld.ts's registry. */
  type?: string
}

export function webPageLd(input: WebPageInput): JsonLdObject {
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': input.type ?? 'WebPage',
    name: input.name,
    description: str(input.description),
    url: str(input.url),
    inLanguage: str(input.inLanguage) ?? 'en',
  })
}

export interface WebSiteInput {
  name: string
  url?: string | null
  inLanguage?: string | null
  /** When set, emit a sitelinks-searchbox SearchAction. The string is
   *  the search-results URL template; `{search_term_string}` is the
   *  required query placeholder. If omitted, no potentialAction is
   *  emitted (a SearchAction pointing at a non-existent search page
   *  produces a Google Search Console warning). */
  searchUrlTemplate?: string | null
}

export function websiteLd(input: WebSiteInput): JsonLdObject {
  const tmpl = str(input.searchUrlTemplate)
  return compact({
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    name: input.name,
    url: str(input.url),
    inLanguage: str(input.inLanguage) ?? 'en',
    potentialAction: tmpl
      ? {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: tmpl,
          },
          // schema.org requires this exact `query-input` form for the
          // sitelinks searchbox; the name matches the {search_term_string}
          // placeholder in the urlTemplate.
          'query-input': 'required name=search_term_string',
        }
      : undefined,
  })
}

// ---------------------------------------------------------------------------
// BreadcrumbList
// ---------------------------------------------------------------------------

export interface BreadcrumbItem {
  name: string
  url: string
}

/** Canonical BreadcrumbList builder. Positions are 1-indexed and
 *  sequential. This SUPERSEDES the (unused) `breadcrumbLd` in
 *  `lib/seo/jsonLd.ts` — identical output shape, canonical name. */
export function breadcrumbListLd(
  items: ReadonlyArray<BreadcrumbItem>,
): JsonLdObject | null {
  // A BreadcrumbList needs at least 2 crumbs to be meaningful — a single
  // "Home" (or an empty trail) is noise that Google flags. Return null so the
  // caller simply omits the node.
  if (items.length < 2) return null
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  }
}
