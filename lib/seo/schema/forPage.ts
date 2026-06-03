// schemaForEntity — selects + composes the ORDERED array of JSON-LD
// graph objects to emit for a single public entity (page / post /
// project), given:
//   1. the entity's intrinsic fields (title, description, url, dates…),
//   2. an OPTIONAL per-page schema override (the `schemaType` +
//      `schemaData` carried in the entity's `seoMeta` JSON column), and
//   3. the SITEWIDE `seo_schema` defaults (entityType Organization|Person,
//      articleType, breadcrumbsEnabled, websiteSearchAction).
//
// PURITY CONTRACT: like `builders.ts`, this module is data-in / JSON-out.
// It NEVER reads the DB or Settings — the caller resolves those rows and
// hands them in. That keeps the SELECTION LOGIC (the part with branches
// worth testing) decoupled from IO.
//
// SELECTION PRECEDENCE (load-bearing):
//   per-page override  >  type default  >  fallback WebPage
//   • If `seoMeta.schemaType` is set, it WINS — emit that shape, fed by
//     `seoMeta.schemaData`.
//   • Else, fall back to the entity-kind default: a post → Article (its
//     articleType from `seo_schema`), a project → Product-ish / WebPage,
//     a page → the page-jsonld.ts registry shape (home→WebSite,
//     about→AboutPage, …) collapsed here to WebPage for operator pages.
//   • Else, the universal fallback: WebPage.
//
// NO ORGANIZATION DOUBLE-EMIT: the sitewide Organization (and the home
// WebSite) are emitted ONCE in the layout via
// `lib/seo/jsonLd.ts:organizationLd()`. This function MUST NOT re-emit an
// Organization node — it only references the publisher inside Article
// (as an Organization *ref*, not a standalone graph node). The
// `seo_schema.entityType` default is consumed by the LAYOUT, not here; we
// accept it only so a caller can pass the whole defaults object through
// without filtering, and we assert (in tests) that no top-level
// Organization is ever produced.

import {
  articleLd,
  faqPageLd,
  howToLd,
  productLd,
  softwareApplicationLd,
  webPageLd,
  breadcrumbListLd,
  type ArticleType,
  type ArticleInput,
  type FaqItem,
  type HowToInput,
  type ProductInput,
  type SoftwareApplicationInput,
  type BreadcrumbItem,
  type JsonLdObject,
  type OrganizationRefInput,
} from './builders'
import type { SchemaTypeValue } from '@/lib/cms/seoEditorFields'

/** The per-page schema override carried in `seoMeta.schema`. When
 *  `schemaType` is set, it selects the PRIMARY shape for the page and
 *  `schemaData` supplies that shape's fields.
 *
 *  Aliased to the SINGLE source of truth in the client-safe
 *  `lib/cms/seoEditorFields.ts` (`SchemaTypeValue` = the 8 accepted
 *  values) so the Zod enum, the panel tiles, the editor parsers, and this
 *  render-side union can never drift. This module is NOT `server-only`
 *  (see builders.ts), and seoEditorFields.ts only imports `zod`, so the
 *  import keeps forPage render-safe. */
export type PageSchemaType = SchemaTypeValue

export interface PageSchemaOverride {
  schemaType?: PageSchemaType | null
  /** Free-form data feeding the selected builder. Shape depends on
   *  schemaType; validated by the builder it's routed to. */
  schemaData?: Record<string, unknown> | null
}

/** Sitewide SEO defaults (the `seo_schema` settings row). */
export interface SeoSchemaDefaults {
  /** Consumed by the LAYOUT for the sitewide node — accepted here only
   *  so the whole defaults object can flow through untouched. */
  entityType?: 'Organization' | 'Person'
  /** Default Article subtype for posts when no per-page override. */
  articleType?: ArticleType
  breadcrumbsEnabled?: boolean
  /** Sitelinks searchbox URL template; only relevant to the home WebSite
   *  (emitted by the layout), accepted here for pass-through symmetry. */
  websiteSearchAction?: string | null
}

export type EntityKind = 'page' | 'post' | 'project'

/** The intrinsic, already-resolved fields of the entity being rendered.
 *  The caller maps its raw row (page/post/project) onto this. */
export interface EntityCore {
  kind: EntityKind
  title: string
  description?: string | null
  /** Canonical absolute URL of the entity page. */
  url?: string | null
  inLanguage?: string | null
  /** Posts: publication + modification timestamps + author + image. */
  datePublished?: string | Date | null
  dateModified?: string | Date | null
  author?: string | null
  image?: string | string[] | null
  /** Publisher ref for Article (resolved from the sitewide org). */
  publisher?: OrganizationRefInput | null
  /** For operator pages whose @type should differ (AboutPage, etc.). */
  webPageType?: string
}

export interface SchemaForEntityArgs {
  entity: EntityCore
  override?: PageSchemaOverride | null
  defaults?: SeoSchemaDefaults | null
  /** Pre-resolved breadcrumb trail. When provided AND
   *  defaults.breadcrumbsEnabled !== false, a BreadcrumbList is appended.
   *  (A single-crumb or empty trail is skipped — a breadcrumb of one is
   *  noise.) */
  breadcrumbs?: ReadonlyArray<BreadcrumbItem> | null
}

// --- per-shape coercion from the free-form `schemaData` ---------------------
//
// The override's `schemaData` is operator-authored JSON; we coerce the
// relevant fields into the typed builder input, FALLING BACK to the
// entity's intrinsic fields when a field is absent. This means an
// operator can flip a page to `Article` and get a sensible result from
// the page's own title/description without re-typing everything.

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

/** Pass a value through ONLY when it is a non-null object — otherwise
 *  undefined. Used to defensively gate operator JSON before it reaches a
 *  builder that expects an object shape (offers, aggregateRating). A scalar
 *  like `offers: 5` becomes `undefined` here so the builder omits it rather
 *  than the cast smuggling a number into an object-typed slot. The builders
 *  ALSO guard, but coercing at the boundary keeps the cast honest. */
function asObject(v: unknown): Record<string, unknown> | undefined {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Pass through ONLY a string[] (every element a non-empty string); otherwise
 *  undefined. Guards `supply`/`tool` where operator JSON might be `"x"` or a
 *  mixed array. */
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  return out.length > 0 ? out : undefined
}

function buildArticle(
  entity: EntityCore,
  type: ArticleType,
  data: Record<string, unknown>,
): JsonLdObject {
  // Coerce a publisher object defensively: only an object with a string `name`
  // is a usable OrganizationRef; anything else falls back to the entity's.
  const dataPublisher = asObject(data.publisher)
  const publisherFromData =
    dataPublisher && typeof dataPublisher.name === 'string'
      ? (dataPublisher as unknown as OrganizationRefInput)
      : undefined

  const input: ArticleInput = {
    type,
    headline: asString(data.headline) ?? entity.title,
    description: asString(data.description) ?? entity.description ?? undefined,
    author:
      asString(data.author) ?? asString(entity.author) ?? 'Editorial Team',
    datePublished:
      asString(data.datePublished) ??
      entity.datePublished ??
      new Date(0).toISOString(),
    dateModified: asString(data.dateModified) ?? entity.dateModified ?? undefined,
    image: asImage(data.image) ?? entity.image ?? undefined,
    mainEntityOfPage: asString(data.mainEntityOfPage) ?? entity.url ?? undefined,
    publisher: publisherFromData ?? entity.publisher ?? undefined,
  }
  return articleLd(input)
}

/** Hard cap on FAQ items / HowTo steps re-serialized into JSON-LD on every
 *  render. `schemaData` is operator-authored, uncapped JSON; without this an
 *  abusive (or accidental) 10k-entry array would balloon the emitted
 *  structured data on EVERY public render of the page (#0.251 graceful cap;
 *  the SchemaPicker also disables Add at this ceiling so the operator never
 *  authors past it). 50 is well above any legitimate FAQ/HowTo and matches
 *  the editor's cap. */
const MAX_SCHEMA_ITEMS = 50

function buildFaq(data: Record<string, unknown>): JsonLdObject | null {
  const raw = Array.isArray(data.items) ? data.items : Array.isArray(data.faqs) ? data.faqs : null
  if (!raw) return null
  const items: FaqItem[] = raw
    .map((r): FaqItem | null => {
      if (r == null || typeof r !== 'object') return null
      const rec = r as Record<string, unknown>
      const q = asString(rec.question) ?? asString(rec.q)
      const a = asString(rec.answer) ?? asString(rec.a)
      return q && a ? { question: q, answer: a } : null
    })
    .filter((x): x is FaqItem => x != null)
    // Bound the emitted node — see MAX_SCHEMA_ITEMS.
    .slice(0, MAX_SCHEMA_ITEMS)
  return items.length > 0 ? faqPageLd(items) : null
}

function buildHowTo(
  entity: EntityCore,
  data: Record<string, unknown>,
): JsonLdObject | null {
  const rawSteps = Array.isArray(data.steps) ? data.steps : null
  if (!rawSteps) return null
  const steps = rawSteps
    .map((s) => {
      if (s == null || typeof s !== 'object') return null
      const rec = s as Record<string, unknown>
      const name = asString(rec.name)
      const text = asString(rec.text) ?? asString(rec.description)
      if (!name || !text) return null
      return {
        name,
        text,
        url: asString(rec.url) ?? undefined,
        image: asString(rec.image) ?? undefined,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    // Bound the emitted node — see MAX_SCHEMA_ITEMS.
    .slice(0, MAX_SCHEMA_ITEMS)
  if (steps.length === 0) return null
  const input: HowToInput = {
    name: asString(data.name) ?? entity.title,
    description: asString(data.description) ?? entity.description ?? undefined,
    totalTime: asString(data.totalTime) ?? undefined,
    supply: asStringArray(data.supply),
    tool: asStringArray(data.tool),
    steps,
  }
  return howToLd(input)
}

/** Coerce a possibly-malformed `image` field: a string or string[] passes;
 *  anything else (number, object) → undefined so it falls back to the entity. */
function asImage(v: unknown): string | string[] | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return v as string[]
  }
  return undefined
}

function buildProduct(
  entity: EntityCore,
  data: Record<string, unknown>,
): JsonLdObject {
  // `asObject` verifies offers/aggregateRating are objects BEFORE the cast, so
  // a scalar like `offers: 5` becomes undefined here (the cast is now honest;
  // the builders guard again as defence in depth).
  const input: ProductInput = {
    name: asString(data.name) ?? entity.title,
    description: asString(data.description) ?? entity.description ?? undefined,
    image: asImage(data.image) ?? entity.image ?? undefined,
    brand: asString(data.brand) ?? undefined,
    offers: asObject(data.offers) as ProductInput['offers'],
    aggregateRating: asObject(
      data.aggregateRating,
    ) as ProductInput['aggregateRating'],
  }
  return productLd(input)
}

function buildSoftware(
  entity: EntityCore,
  data: Record<string, unknown>,
): JsonLdObject {
  const input: SoftwareApplicationInput = {
    name: asString(data.name) ?? entity.title,
    description: asString(data.description) ?? entity.description ?? undefined,
    applicationCategory: asString(data.applicationCategory) ?? undefined,
    operatingSystem: asString(data.operatingSystem) ?? undefined,
    image: asImage(data.image) ?? entity.image ?? undefined,
    offers: asObject(data.offers) as SoftwareApplicationInput['offers'],
    aggregateRating: asObject(
      data.aggregateRating,
    ) as SoftwareApplicationInput['aggregateRating'],
  }
  return softwareApplicationLd(input)
}

function buildWebPage(entity: EntityCore): JsonLdObject {
  return webPageLd({
    type: entity.webPageType,
    name: entity.title,
    description: entity.description ?? undefined,
    url: entity.url ?? undefined,
    inLanguage: entity.inLanguage ?? undefined,
  })
}

/** Resolve the PRIMARY shape for the entity, honouring the precedence
 *  chain. Returns the single primary JSON-LD object. */
function resolvePrimary(
  entity: EntityCore,
  override: PageSchemaOverride | null | undefined,
  defaults: SeoSchemaDefaults | null | undefined,
): JsonLdObject {
  const data = (override?.schemaData ?? {}) as Record<string, unknown>
  const overrideType = override?.schemaType ?? null

  // 1. Per-page override wins.
  if (overrideType) {
    return resolveOverrideShape(entity, overrideType, data)
  }

  // 2. Type (entity-kind) default.
  if (entity.kind === 'post') {
    return buildArticle(entity, defaults?.articleType ?? 'BlogPosting', data)
  }

  // 3. Universal fallback — WebPage (projects + operator pages without an
  //    override land here; a project page is a content surface, not
  //    inherently a Product, so WebPage is the safe default unless the
  //    operator flips it via the override).
  return buildWebPage(entity)
}

/**
 * Compose the ordered JSON-LD graph for one entity. Order: [primary,
 * BreadcrumbList?]. The sitewide Organization + home WebSite are emitted
 * separately by the layout and intentionally NOT included here.
 *
 * NOTE: the public PER-PAGE routes do NOT call this anymore — they call
 * {@link extraSchemaForEntity} (additions-only) because each route already
 * emits its own legacy PRIMARY node (`blogPostingLd` / `residenceLd` /
 * `jsonLdForPage`). Emitting BOTH a legacy primary AND this function's
 * default primary produced TWO primary nodes for one URL (a duplicate-
 * structured-data SEO smell). This full builder stays exported because the
 * unit tests + any future single-source caller still exercise the complete
 * precedence chain; the routes use the additions-only variant.
 */
export function schemaForEntity(args: SchemaForEntityArgs): JsonLdObject[] {
  const { entity, override, defaults, breadcrumbs } = args
  const out: JsonLdObject[] = []

  out.push(resolvePrimary(entity, override, defaults))

  out.push(...breadcrumbExtra(defaults, breadcrumbs))

  return out
}

/**
 * Additions-only graph: ONLY (a) the BreadcrumbList (when enabled + ≥2
 * crumbs) and (b) the EXPLICIT per-page override shape when
 * `override.schemaType` is set. It NEVER emits a default primary
 * (WebPage / Article / home WebSite) — the per-page routes already emit
 * their own legacy primary node, so this prevents a duplicate primary for
 * one URL (the JSON-LD double-emission the review flagged).
 *
 * Contract:
 *   • `schemaType` UNSET  → returns ONLY the breadcrumbs (or [] when none).
 *   • `schemaType` SET    → returns [overrideShape, ...breadcrumbs]. The
 *     override shape is the SAME builder selection `resolvePrimary` would
 *     pick for an explicit type — but it is NOT a default. (A FAQ/HowTo
 *     with no usable items still falls back to WebPage here, mirroring the
 *     primary selection, because an operator who explicitly chose FAQPage
 *     wants SOME node for that intent; that node is an ADDITION the legacy
 *     primary doesn't cover.)
 */
export function extraSchemaForEntity(args: SchemaForEntityArgs): JsonLdObject[] {
  const { entity, override, defaults, breadcrumbs } = args
  const out: JsonLdObject[] = []

  // (b) Explicit per-page override ONLY — never the entity-kind default.
  const overrideType = override?.schemaType ?? null
  if (overrideType) {
    const data = (override?.schemaData ?? {}) as Record<string, unknown>
    out.push(resolveOverrideShape(entity, overrideType, data))
  }

  // (a) Breadcrumbs (same gate as schemaForEntity).
  out.push(...breadcrumbExtra(defaults, breadcrumbs))

  return out
}

/** Shared breadcrumb gate used by both the full + additions-only builders.
 *  Appended when enabled (default true) AND the trail has ≥ 2 crumbs (a
 *  one-item breadcrumb is meaningless). `breadcrumbListLd` ALSO guards
 *  (< 2 → null); the outer length check is a cheap early-out and we push
 *  only a non-null result — the two guards agree, no double-guard break. */
function breadcrumbExtra(
  defaults: SeoSchemaDefaults | null | undefined,
  breadcrumbs: ReadonlyArray<BreadcrumbItem> | null | undefined,
): JsonLdObject[] {
  const breadcrumbsEnabled = defaults?.breadcrumbsEnabled !== false
  if (breadcrumbsEnabled && breadcrumbs && breadcrumbs.length >= 2) {
    const bc = breadcrumbListLd(breadcrumbs)
    if (bc) return [bc]
  }
  return []
}

/** Build the shape for an EXPLICIT operator-chosen schemaType (the same
 *  selection `resolvePrimary` makes for an override, factored out so the
 *  additions-only path reuses it without re-running the type-default /
 *  fallback branches). */
function resolveOverrideShape(
  entity: EntityCore,
  overrideType: PageSchemaType,
  data: Record<string, unknown>,
): JsonLdObject {
  switch (overrideType) {
    case 'Article':
    case 'BlogPosting':
    case 'NewsArticle':
      return buildArticle(entity, overrideType, data)
    case 'FAQPage':
      return buildFaq(data) ?? buildWebPage(entity)
    case 'HowTo':
      return buildHowTo(entity, data) ?? buildWebPage(entity)
    case 'Product':
      return buildProduct(entity, data)
    case 'SoftwareApplication':
      return buildSoftware(entity, data)
    case 'WebPage':
      return buildWebPage(entity)
  }
}
