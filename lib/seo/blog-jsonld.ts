import 'server-only'
import { breadcrumbLd } from './jsonLd'
import { blogIndexUrl, categoryUrl, postUrl } from '@/lib/blog/urls'

// Blog/taxonomy-specific JSON-LD builders. Kept SEPARATE from the shared
// lib/seo/jsonLd.ts (per blog-system spec §11) so the parallel SEO-settings
// worktree's edits to that file never collide with these — the two branches
// touch different files. These compose the shared primitives (breadcrumbLd)
// where useful rather than re-implementing schema.org shapes.
//
// As with the shared helpers, the operator's site origin comes from Settings →
// General. When null, absolute `item`/`url` fields are omitted (a wrong URL is
// worse than no URL for indexers); the helpers below take an already-resolved
// origin so the caller controls the I/O.

/**
 * BreadcrumbList for a post detail page: Home › Blog › [Category] › Post.
 * The category segment is included only when the post has a primary category
 * (the first one assigned). Absolute URLs require the site origin; when it's
 * null the breadcrumb still emits with relative `item` paths (Google accepts
 * relative breadcrumb items on the page they describe).
 */
export function postBreadcrumbLd(p: {
  postTitle: string
  postSlug: string
  /** Primary category for the middle crumb, or null to skip it. */
  primaryCategory?: { name: string; slug: string } | null
  siteOrigin?: string | null
}): Record<string, unknown> {
  const abs = (path: string) =>
    p.siteOrigin ? `${p.siteOrigin}${path}` : path
  const items: Array<{ name: string; url: string }> = [
    { name: 'Home', url: abs('/') },
    { name: 'Blog', url: abs(blogIndexUrl()) },
  ]
  if (p.primaryCategory) {
    items.push({
      name: p.primaryCategory.name,
      url: abs(categoryUrl(p.primaryCategory.slug)),
    })
  }
  items.push({ name: p.postTitle, url: abs(postUrl(p.postSlug)) })
  return breadcrumbLd(items)
}

/**
 * CollectionPage for a category/tag archive. Emits name/description/url so an
 * indexer understands the page is a curated collection. Absolute URLs require
 * the origin; omitted when null.
 */
export function archiveCollectionPageLd(p: {
  termKind: 'category' | 'tag'
  termName: string
  termSlug: string
  description?: string | null
  archivePath: string
  siteOrigin?: string | null
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: p.termName,
    description:
      p.description && p.description.trim() !== ''
        ? p.description
        : `Posts tagged ${p.termName}`,
  }
  if (p.siteOrigin) {
    ld.url = `${p.siteOrigin}${p.archivePath}`
  }
  return ld
}
