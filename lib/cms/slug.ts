// Canonical slug shape — single source of truth for every entity slug
// (pages, posts, projects). Per spec §5.1: lowercase ASCII alphanumeric
// segments separated by single hyphens, no leading/trailing hyphen, no
// consecutive hyphens.
//
// SLUG_MAX = 140 mirrors the widest DB column bound (pages.slug,
// posts.slug). Project slugs cap at 120 in their column but use this
// same regex; the route-level Zod also enforces a tighter max where
// applicable.
//
// SLUG_MIN = 2 prevents single-character slugs which collide with the
// dotfile prefix guard in middleware and also produce ambiguous URLs
// (/a vs /admin shape parsing).
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SLUG_MIN = 2
export const SLUG_MAX = 140
