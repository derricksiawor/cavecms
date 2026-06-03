// Client-side slug suggestion from a free-text name/title. Produces a
// candidate that conforms to the canonical SLUG_RE shape (lowercase ASCII
// alphanumerics + single hyphens, no leading/trailing/consecutive hyphens) —
// the SAME transform the SlugInput auto-suggest used inline. Extracted here so
// every "auto-fill the slug from the name" affordance (post slug, page slug,
// category/tag slug) shares one implementation instead of re-deriving it.
//
// This is a UX convenience only — the authoritative validation is server-side
// (validatePageSlug / validateTermSlug). A name with only non-ASCII characters
// produces an empty string; the caller treats that as "operator must type a
// slug manually".
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
