import 'server-only'
import type { PageRawRow } from '@/lib/cms/types'

// Per-page JSON-LD registry (spec §2.8). The four registered shapes
// (home / about / services / contact) are authored FRESH in this
// module — there is no "verbatim migration" from the static routes
// being deleted in this PR (those routes do not emit JSON-LD today;
// verified via `grep -rn 'application/ld+json' app/`). Operator-
// created pages fall through to the generic WebPage shape.
//
// Coexistence with `lib/seo/jsonLd.ts:organizationLd()` is intentional:
// the layout emits Organization site-wide so every public route
// inherits the brand identity; this registry emits page-scoped
// structured data (WebSite for the home, AboutPage for about, etc).
// Search engines support multiple `application/ld+json` script tags
// per document and merge them at index time.
//
// URL DISCIPLINE (load-bearing): every `url` field reads
// `page.url_path` — the canonical STORED generated column. The
// nullish coalesce branch computes from (is_home, slug) when the
// column surfaces NULL (TS-only nullable per Drizzle 0.36 + MariaDB
// STORED-generated-column limitations).
//
// SNAKE_CASE ACCESSORS: this helper consumes the raw mysql2 row
// shape (`PageRawRow`), matching the codebase convention for raw
// `db.execute(sql\`SELECT *\`)` reads. DO NOT introduce a camelCase
// row alias — Drizzle's raw-SQL path returns mysql2 rows VERBATIM
// (no field mapping), so accessing `.urlPath` / `.isHome` would
// always be `undefined` at runtime.

interface JsonLdContext {
  page: PageRawRow
  baseUrl: string
}

type JsonLdShape = (ctx: JsonLdContext) => Record<string, unknown>

function pageUrl(ctx: JsonLdContext): string {
  // url_path is the canonical STORED generated column; at runtime it's
  // deterministic and never NULL. The TS-only nullable surface (per
  // Drizzle 0.36 + MariaDB STORED generated columns) makes the
  // fallback branch dead code in practice. If the column ever does
  // surface NULL (schema drift, manual driver override), compute the
  // canonical path from `is_home` + `slug` rather than blindly
  // collapsing to `/` — collapsing every page to the root URL would
  // train search engines that every canonical URL is `/`, causing
  // silent indexing collapse.
  const fallback = ctx.page.is_home === 1 ? '/' : `/${ctx.page.slug}`
  const path = ctx.page.url_path ?? fallback
  return `${ctx.baseUrl}${path}`
}

const REGISTRY: Record<string, JsonLdShape> = {
  home: (ctx) => ({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: ctx.page.title,
    url: pageUrl(ctx),
    inLanguage: 'en',
  }),
  about: (ctx) => ({
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: ctx.page.title,
    description: ctx.page.seo_description ?? undefined,
    url: pageUrl(ctx),
    inLanguage: 'en',
  }),
  services: (ctx) => ({
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: ctx.page.title,
    description: ctx.page.seo_description ?? undefined,
    url: pageUrl(ctx),
  }),
  contact: (ctx) => ({
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: ctx.page.title,
    description: ctx.page.seo_description ?? undefined,
    url: pageUrl(ctx),
    inLanguage: 'en',
  }),
}

export function jsonLdForPage(ctx: JsonLdContext): Record<string, unknown> {
  // Home-row lookup keys on `is_home=1` rather than the slug since the
  // home row may have been renamed away from `home`. Non-home rows
  // key on slug (the registry only knows about the seeded system
  // slugs; operator-renamed pages fall through to WebPage).
  const slug = ctx.page.is_home === 1 ? 'home' : ctx.page.slug
  const shape = REGISTRY[slug]
  if (shape) return shape(ctx)
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: ctx.page.title,
    description: ctx.page.seo_description ?? undefined,
    url: pageUrl(ctx),
    inLanguage: 'en',
  }
}
