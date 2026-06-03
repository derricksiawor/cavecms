import 'server-only'
import type { Metadata } from 'next'
import { getSetting } from '@/lib/cms/getSettings'
import { resolveTemplate } from '@/lib/seo/templates/resolve'
import type { TemplateContext } from '@/lib/seo/templates/types'

// Central metadata resolver. Three-tier fallback for title/description:
//   1. entity-level seo_title / seo_description (operator override)
//   2. the per-content-type TEMPLATE from the `seo_titles` setting
//      (e.g. `%title% %sep% %sitename%`) resolved against the entity +
//      site context — when a `contentType` is supplied
//   3. caller fallback (fallbackTitle/Description) → site-wide default_seo
//
// It ALSO applies the SEO-suite signals every route shares: per-entity
// robots (noindex/nofollow) + the global "discourage search engines"
// kill-switch, per-entity canonical override, per-entity OG/Twitter
// title+description overrides, and the site-wide social defaults
// (Twitter card type / @site / @creator / og:locale / fb:app_id).
//
// Every SEO-suite field on SeoInput is OPTIONAL — a caller that passes
// only the original {title, description, canonicalPath, …} gets exactly
// the previous behaviour, so existing routes keep working unchanged.

export interface SeoInput {
  title?: string | null
  description?: string | null
  fallbackTitle?: string
  fallbackDescription?: string
  ogImagePath?: string | null
  canonicalPath: string

  // ─── SEO suite (all optional) ───
  /** Content type → selects the title/description template from seo_titles. */
  contentType?:
    | 'home'
    | 'page'
    | 'post'
    | 'project'
    | 'blogIndex'
    | 'projectsIndex'
    | 'search'
    | 'notFound'
  /** Extra template variables (entity title, excerpt, category, page…). */
  templateVars?: Partial<TemplateContext>
  /** Per-entity robots directives (from robots_noindex / robots_nofollow). */
  noindex?: boolean
  nofollow?: boolean
  /** Per-entity canonical override (absolute URL or same-origin path). */
  canonicalOverride?: string | null
  /** Per-entity OG/Twitter overrides (from the seo_meta JSON column). */
  ogTitle?: string | null
  ogDescription?: string | null
  twitterTitle?: string | null
  twitterDescription?: string | null
}

function nonEmpty(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0
}

// Turn a same-origin OG image path into an absolute URL. OG/Twitter
// scrapers reject relative paths and no metadataBase is configured, so a
// path like `/uploads/og.webp` must be prefixed with the operator's site
// URL. Absolute http(s) URLs (and null) pass through; if no site URL is
// set, a relative path is returned as-is (best effort).
async function absolutize(url: string | null): Promise<string | null> {
  if (!url || /^https?:\/\//i.test(url)) return url
  const general = await getSetting('site_general')
  const base = general?.siteUrl?.replace(/\/+$/, '') ?? ''
  if (!base) return url
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`
}

export async function resolveMetadata(input: SeoInput): Promise<Metadata> {
  // Read the settings this resolver consumes. getSetting fails closed to
  // the registry default, so each is always a well-formed object.
  const [defaults, titles, social, indexing, general] = await Promise.all([
    getSetting('default_seo'),
    getSetting('seo_titles'),
    getSetting('seo_social'),
    getSetting('seo_indexing'),
    getSetting('site_general'),
  ])

  // Template context shared by the title + description templates.
  // Every settings read is optional-chained: getSetting fails closed to
  // the registry default (so these are always well-formed at runtime),
  // but symmetric `?.` keeps a single regressed read from 500-ing a page
  // render — it degrades to the bundled fallback instead.
  const ctx: TemplateContext = {
    siteName: general?.siteName || defaults?.title || '',
    siteDesc: defaults?.description || '',
    separator: titles?.separator || '–',
    ...input.templateVars,
  }

  // ── Title ──
  // 1) explicit entity seo_title → 2) per-type template → 3) caller
  // fallback → 4) site default.
  let title: string
  if (nonEmpty(input.title)) {
    title = input.title
  } else {
    // `contentType` is a deliberate SUPERSET of the seo_titles template
    // keys (it still names `search` / `notFound`, which have no template —
    // there is no /search route and 404 uses static metadata). Index
    // through a partial-record view so a superset member resolves to
    // undefined (→ caller/site-default fallback) instead of a type error.
    const tmplMap = titles as
      | Partial<Record<NonNullable<typeof input.contentType>, { title: string; description: string }>>
      | undefined
    const template = input.contentType ? tmplMap?.[input.contentType]?.title : undefined
    const templated = template ? resolveTemplate(template, ctx).trim() : ''
    title = templated || (nonEmpty(input.fallbackTitle) ? input.fallbackTitle : defaults?.title ?? '')
  }
  // A page must never render an EMPTY <title> (a hand-blanked siteName +
  // empty default_seo.title could otherwise produce ''). Fall back to the
  // site name, then a bundled last resort.
  if (!nonEmpty(title)) title = ctx.siteName || 'CaveCMS'

  // ── Description ──
  let description: string
  if (nonEmpty(input.description)) {
    description = input.description
  } else {
    const tmplMap = titles as
      | Partial<Record<NonNullable<typeof input.contentType>, { title: string; description: string }>>
      | undefined
    const template = input.contentType ? tmplMap?.[input.contentType]?.description : undefined
    const templated = template ? resolveTemplate(template, ctx).trim() : ''
    description =
      templated ||
      (nonEmpty(input.fallbackDescription) ? input.fallbackDescription : defaults?.description ?? '')
  }

  // ── OG image (priority: caller override → operator default media → legacy path) ──
  let og: string | null = input.ogImagePath ?? null
  if (!og && defaults?.ogImage?.media_id) {
    const { resolveMedia } = await import('@/lib/cms/resolveMedia')
    const m = await resolveMedia(defaults.ogImage.media_id)
    og = m?.og ?? m?.lg ?? m?.md ?? null
  }
  if (!og) og = defaults?.ogImagePath ?? null
  og = await absolutize(og)

  // ── Robots ── per-entity noindex/nofollow OR the global discourage
  // kill-switch. When the operator flips "discourage search engines", the
  // whole site is noindex,nofollow regardless of per-entity flags.
  const discourage = indexing?.discourageSearchEngines === true
  const noindex = discourage || input.noindex === true
  const nofollow = discourage || input.nofollow === true

  // ── Canonical ── per-entity override beats the computed path.
  const canonical = nonEmpty(input.canonicalOverride) ? input.canonicalOverride : input.canonicalPath

  // ── Social blocks ──
  const ogTitle = nonEmpty(input.ogTitle) ? input.ogTitle : title
  const ogDescription = nonEmpty(input.ogDescription) ? input.ogDescription : description
  const twTitle = nonEmpty(input.twitterTitle) ? input.twitterTitle : title
  const twDescription = nonEmpty(input.twitterDescription) ? input.twitterDescription : description
  // Normalise handles to the leading-@ form Twitter expects.
  const atHandle = (h: string | undefined): string | undefined =>
    nonEmpty(h) ? (h.startsWith('@') ? h : `@${h}`) : undefined

  const meta: Metadata = {
    title,
    description,
    alternates: { canonical },
    robots: { index: !noindex, follow: !nofollow },
    openGraph: {
      title: ogTitle,
      description: ogDescription,
      url: canonical,
      images: og ? [{ url: og, width: 1200, height: 630 }] : undefined,
      siteName: ctx.siteName || defaults?.title || undefined,
      locale: social?.ogLocale || undefined,
    },
    twitter: {
      card: social?.twitterCard || 'summary_large_image',
      title: twTitle,
      description: twDescription,
      images: og ? [og] : undefined,
      site: atHandle(social?.twitterSite),
      creator: atHandle(social?.twitterCreator),
    },
  }

  // Facebook app id isn't a first-class Next Metadata field — emit it via
  // `other` only when configured (avoids an empty fb:app_id tag).
  if (nonEmpty(social?.facebookAppId)) {
    meta.other = { 'fb:app_id': social.facebookAppId }
  }

  return meta
}
