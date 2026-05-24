import 'server-only'
import type { Metadata } from 'next'
import { getSetting } from '@/lib/cms/getSettings'

// Three-tier metadata fallback chain:
//   1. entity-level title/description (page row's seo_title / project's
//      seo_description / etc.)
//   2. fallbackTitle / fallbackDescription — caller-provided per-route
//      defaults (e.g. "Services — Best World Properties")
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
  const og = input.ogImagePath ?? defaults.ogImagePath ?? null
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
