import 'server-only'
import type { Metadata } from 'next'
import { getSetting } from '@/lib/cms/getSettings'

// Three-tier metadata fallback chain:
//   1. entity-level title/description (page row's seo_title / project's
//      seo_description / etc.)
//   2. fallbackTitle / fallbackDescription — caller-provided per-route
//      defaults (e.g. "Services — CaveCMS")
//   3. default_seo setting — site-wide fallback edited in /admin/settings
//
// The resolver is one source of truth so a future field rename only
// touches this file. Open Graph + Twitter card share the resolved
// values so a per-entity title flows through without per-route
// boilerplate.

export interface SeoInput {
  title?: string | null
  description?: string | null
  fallbackTitle?: string
  fallbackDescription?: string
  ogImagePath?: string | null
  canonicalPath: string
}

// Turn a same-origin OG image path into an absolute URL. Open Graph /
// Twitter card scrapers reject relative paths, and no metadataBase is
// configured, so a path like `/uploads/og.webp` must be prefixed with
// the operator's site URL (Settings → General). Absolute https/http
// URLs (and a null) pass through untouched; if no site URL is set, a
// relative path is returned as-is (best effort — same as before).
async function absolutizeOg(url: string | null): Promise<string | null> {
  if (!url || /^https?:\/\//i.test(url)) return url
  const general = await getSetting('site_general')
  const base = general?.siteUrl?.replace(/\/+$/, '') ?? ''
  if (!base) return url
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`
}

export async function resolveMetadata(input: SeoInput): Promise<Metadata> {
  const defaults = await getSetting('default_seo')
  const title =
    (input.title && input.title.trim().length > 0
      ? input.title
      : input.fallbackTitle && input.fallbackTitle.trim().length > 0
        ? input.fallbackTitle
        : defaults.title) ?? defaults.title
  const description =
    (input.description && input.description.trim().length > 0
      ? input.description
      : input.fallbackDescription && input.fallbackDescription.trim().length > 0
        ? input.fallbackDescription
        : defaults.description) ?? defaults.description
  // Open Graph image resolution, in priority order:
  //   1. per-entity override the caller resolved + passed in
  //      (input.ogImagePath) — kept for API compatibility.
  //   2. operator default media pick (default_seo.ogImage) — resolved
  //      from the Media library to its purpose-built `og` variant.
  //   3. legacy default_seo.ogImagePath free-text URL (pre-picker
  //      installs) — honoured so an upgrade never drops a configured
  //      share image.
  // resolveMedia (and the DB client it pulls in) is imported lazily so
  // callers that never configure an ogImage — and the unit suite that
  // mocks getSetting — don't drag the database client into their module
  // graph just to read SEO metadata.
  let og: string | null = input.ogImagePath ?? null
  if (!og && defaults.ogImage?.media_id) {
    const { resolveMedia } = await import('@/lib/cms/resolveMedia')
    const m = await resolveMedia(defaults.ogImage.media_id)
    og = m?.og ?? m?.lg ?? m?.md ?? null
  }
  if (!og) og = defaults.ogImagePath ?? null
  // Social scrapers require ABSOLUTE urls (there is no metadataBase set);
  // prefix a same-origin path with the operator's configured site URL.
  og = await absolutizeOg(og)
  return {
    title,
    description,
    alternates: { canonical: input.canonicalPath },
    openGraph: {
      title,
      description,
      url: input.canonicalPath,
      images: og ? [{ url: og, width: 1200, height: 630 }] : undefined,
      siteName: defaults.title,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: og ? [og] : undefined,
    },
  }
}
