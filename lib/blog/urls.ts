// Single source of truth for blog/project URL construction.
//
// Phase 5 makes the base segment operator-configurable (permalink_blog.segment /
// permalink_projects.segment + the blog post-path structure). The url helpers
// below stay SYNCHRONOUS and take an optional resolved-segments object — they are
// called from `components/blocks/LxPosts/render.tsx`, a synchronous view that
// ALSO runs inside the client editor canvas (an async server component would
// throw there). The async settings read happens ONCE per request via
// `resolveSegments()` (lib/blog/resolveSegments.ts), whose result is threaded
// down to these helpers (or baked onto hydrated items at hydrate time).
//
// When the `segments` arg is omitted, the helpers fall back to the LITERAL
// defaults ('blog' / 'projects' / 'postname') so EVERY un-threaded call site
// stays byte-identical to today — a fresh/unconfigured install behaves EXACTLY
// as it did before Phase 5.
//
// All inputs are caller-validated slugs (SLUG_RE). These helpers do NOT encode —
// a slug that reached here already passed the slug contract (lowercase
// alphanumerics + single hyphens), which is URL-safe by construction.

/** Post-path structure for the blog permalink (permalink_blog.structure). */
export type BlogStructure = 'postname' | 'year-month-postname' | 'flat'

/** Resolved permalink segments for one request/render. Resolve ONCE via
 *  `resolveSegments()` and thread this object to the url helpers below. */
export interface PermalinkSegments {
  blog: string
  projects: string
  structure: BlogStructure
}

// Literal defaults — preserve today's URLs exactly. Exported so non-request
// callers (CLI scripts, the editor's illustrative preview string) and the
// fallback path share one source of truth.
export const DEFAULT_BLOG_SEGMENT = 'blog'
export const DEFAULT_PROJECTS_SEGMENT = 'projects'
export const DEFAULT_BLOG_STRUCTURE: BlogStructure = 'postname'

export const DEFAULT_SEGMENTS: PermalinkSegments = {
  blog: DEFAULT_BLOG_SEGMENT,
  projects: DEFAULT_PROJECTS_SEGMENT,
  structure: DEFAULT_BLOG_STRUCTURE,
}

function blogSeg(s?: PermalinkSegments): string {
  return s?.blog || DEFAULT_BLOG_SEGMENT
}
function projSeg(s?: PermalinkSegments): string {
  return s?.projects || DEFAULT_PROJECTS_SEGMENT
}

/** The blog index URL. `page` 1 → `/<seg>`; page >1 → `/<seg>?page=N`. */
export function blogIndexUrl(page = 1, segments?: PermalinkSegments): string {
  const base = `/${blogSeg(segments)}`
  return page <= 1 ? base : `${base}?page=${page}`
}

// Stable UTC year/month for the dated post prefix, regardless of whether the
// driver handed us a Date or a raw MariaDB datetime string.
//
// The bug this guards (L2): `new Date('2026-06-30 23:30:00')` parses a string
// WITHOUT a timezone in the runtime's LOCAL zone, so a value near a day boundary
// lands in the wrong UTC month/year (e.g. behind UTC, that string becomes
// 2026-07-01T0X:30Z → month 07, not 06). The stored value is always UTC, so:
//   - a Date object → already correct; read via getUTC*.
//   - a string with an explicit zone (`Z` / ±HH:MM) → parse, read via getUTC*.
//   - a string with NO zone (the MariaDB shape, space- OR T-separated) → parse
//     the y/m components directly as UTC, never via the local-time Date parser.
function yearMonthUtc(value: Date | string): { yyyy: string; mm: string } | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return {
      yyyy: String(value.getUTCFullYear()).padStart(4, '0'),
      mm: String(value.getUTCMonth() + 1).padStart(2, '0'),
    }
  }
  // Zone-naive MariaDB string: `YYYY-MM-DD[ T]HH:MM:SS[.fff]` with no trailing
  // `Z` / `±HH:MM`. Read year+month off the literal prefix (they're UTC as
  // stored) — no Date parse, so the local-zone day-boundary drift can't happen.
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?$/.exec(value)
  if (naive) {
    return { yyyy: naive[1]!, mm: naive[2]! }
  }
  // Anything else (string carrying an explicit zone, ISO with `Z`/offset):
  // a normal Date parse is unambiguous; read via UTC getters.
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return {
    yyyy: String(d.getUTCFullYear()).padStart(4, '0'),
    mm: String(d.getUTCMonth() + 1).padStart(2, '0'),
  }
}

/** A single post detail URL. Honors the configured post-path structure:
 *  - `postname` (default) → `/<seg>/<slug>`
 *  - `year-month-postname` → `/<seg>/<yyyy>/<mm>/<slug>` (requires publishedAt)
 *  - `flat` → today routes as `postname` (see resolveSegments + the settings
 *    note); when flat ships fully this becomes `/<slug>`.
 *  `publishedAt` is required only for the year-month structure; when absent
 *  (un-published draft preview) the helper falls back to the post-name form so
 *  a link never breaks. */
export function postUrl(
  slug: string,
  segments?: PermalinkSegments,
  publishedAt?: Date | string | null,
): string {
  const seg = blogSeg(segments)
  const structure = segments?.structure ?? DEFAULT_BLOG_STRUCTURE
  if (structure === 'year-month-postname' && publishedAt) {
    const ym = yearMonthUtc(publishedAt)
    if (ym) return `/${seg}/${ym.yyyy}/${ym.mm}/${slug}`
  }
  // 'flat' currently routes as 'postname' (collision-safety fallback — see
  // lib/blog/resolveSegments.ts). 'postname' and the year-month fallback both
  // land here.
  return `/${seg}/${slug}`
}

/** Category archive URL. `page` 1 → bare; page >1 → `?page=N`. */
export function categoryUrl(slug: string, page = 1, segments?: PermalinkSegments): string {
  const base = `/${blogSeg(segments)}/category/${slug}`
  return page <= 1 ? base : `${base}?page=${page}`
}

/** Tag archive URL. `page` 1 → bare; page >1 → `?page=N`. */
export function tagUrl(slug: string, page = 1, segments?: PermalinkSegments): string {
  const base = `/${blogSeg(segments)}/tag/${slug}`
  return page <= 1 ? base : `${base}?page=${page}`
}

/** RSS/Atom feed URL (Phase 7 serves it; the seam exists now). */
export function feedUrl(segments?: PermalinkSegments): string {
  return `/${blogSeg(segments)}/feed`
}

/** A single project detail URL. */
export function projectUrl(slug: string, segments?: PermalinkSegments): string {
  return `/${projSeg(segments)}/${slug}`
}
