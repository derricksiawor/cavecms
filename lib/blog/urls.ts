// Single source of truth for blog/project URL construction. Phase 4 uses the
// literal `/blog` + `/projects` segment defaults that ship today; Phase 5 makes
// the base segment operator-configurable (permalink_blog.segment /
// permalink_projects.segment) — at that point these helpers read the cached
// setting and EVERY link in the app updates from one place (post detail pills,
// archive headers, the loop pager, the sitemap, JSON-LD). The seam exists now
// so callers reference `categoryUrl(slug)` rather than hard-coding
// `/blog/category/${slug}`, and Phase 5 is a one-file change.
//
// All inputs are caller-validated slugs (SLUG_RE). These helpers do NOT encode
// — a slug that reached here already passed the slug contract (lowercase
// alphanumerics + single hyphens), which is URL-safe by construction.

// Literal default segments. Phase 5 replaces these constants with a cached
// getSetting('permalink_blog').segment / getSetting('permalink_projects').segment
// read (async), and the helpers below become async. Today they are sync +
// constant so every call site is trivially correct and pays no I/O.
export const BLOG_SEGMENT = 'blog'
export const PROJECTS_SEGMENT = 'projects'

/** The blog index URL. `page` 1 → `/blog`; page >1 → `/blog?page=N`. */
export function blogIndexUrl(page = 1): string {
  return page <= 1 ? `/${BLOG_SEGMENT}` : `/${BLOG_SEGMENT}?page=${page}`
}

/** A single post detail URL. */
export function postUrl(slug: string): string {
  return `/${BLOG_SEGMENT}/${slug}`
}

/** Category archive URL. `page` 1 → bare; page >1 → `?page=N`. */
export function categoryUrl(slug: string, page = 1): string {
  const base = `/${BLOG_SEGMENT}/category/${slug}`
  return page <= 1 ? base : `${base}?page=${page}`
}

/** Tag archive URL. `page` 1 → bare; page >1 → `?page=N`. */
export function tagUrl(slug: string, page = 1): string {
  const base = `/${BLOG_SEGMENT}/tag/${slug}`
  return page <= 1 ? base : `${base}?page=${page}`
}

/** RSS/Atom feed URL (Phase 7 serves it; the seam exists now). */
export function feedUrl(): string {
  return `/${BLOG_SEGMENT}/feed`
}

/** A single project detail URL. */
export function projectUrl(slug: string): string {
  return `/${PROJECTS_SEGMENT}/${slug}`
}
