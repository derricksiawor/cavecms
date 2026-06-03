import {
  validatePageSlug,
  type ValidateReason,
  type ValidatePageSlugResult,
} from './page-slug'

// Sub-paths that live UNDER the blog segment — `/<blogSeg>/category/<x>`,
// `/<blogSeg>/tag/<x>`, `/<blogSeg>/feed`, and the (future) `/<blogSeg>/page/N`
// pager segment. A category/tag slug that equalled one of these would shadow
// the literal route (e.g. a category slug `feed` would make `/blog/feed`
// ambiguous with the RSS route, and a category slug `category` would make
// `/blog/category/category` route to itself). Reserving them at the term-slug
// boundary makes that collision structurally impossible. Kept SEPARATE from the
// global RESERVED set (which guards top-level page slugs) because these words
// are only dangerous in the taxonomy namespace — a normal page slug `feed`
// is fine, a category slug `feed` is not.
export const TAXONOMY_RESERVED: ReadonlySet<string> = new Set([
  'category',
  'tag',
  'feed',
  'page',
])

export type TermSlugReason = ValidateReason | 'slug_reserved'

export type ValidateTermSlugResult =
  | { ok: true }
  | { ok: false; reason: TermSlugReason }

// Validates a category/tag slug. Layers the taxonomy-scoped reserved set on
// top of the canonical page-slug contract (format + NFKC + ASCII + length +
// global RESERVED + login-path collision). The login path is passed through
// to validatePageSlug for completeness (a term slug equal to the login path is
// harmless on the public blog, but rejecting it keeps the term-slug rules a
// strict superset of the page-slug rules — no surprises if the seam is reused).
export function validateTermSlug(
  input: string,
  loginPath: string,
): ValidateTermSlugResult {
  // Taxonomy-scoped reserved words first, so a `feed`/`category`/`tag`/`page`
  // term slug reports the precise reason instead of falling through to the
  // base validator (which would pass them — they are NOT in the global
  // RESERVED set).
  if (TAXONOMY_RESERVED.has(input)) {
    return { ok: false, reason: 'slug_reserved' }
  }
  const base: ValidatePageSlugResult = validatePageSlug(input, loginPath)
  if (!base.ok) return { ok: false, reason: base.reason }
  return { ok: true }
}
