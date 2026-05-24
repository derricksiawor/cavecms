import 'server-only'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { projects, posts } from '@/db/schema'
import { tag } from '@/lib/cache/tags'

// Resolves a public-site pathname to the admin-editable resource it
// represents, so the admin bar can deep-link "Edit project" /
// "Edit post" without re-querying on every render.
//
// Caching strategy is two-layer:
//   1. React `cache()` dedupes within a single request — the public
//      page's own data fetch can land on the same SQL the bar's
//      resolver runs, sharing the result without coordination.
//   2. `unstable_cache` dedupes across requests with a 5-minute
//      revalidate window AND per-slug tags so a slug rename,
//      soft-delete, or create invalidates exactly the affected
//      entry. The save / delete / restore / create handlers each
//      emit the matching slug-resolver tag — see lib/cache/tags.ts
//      for the canonical helpers.
//
// Returns null for non-resource paths (listings, marketing pages,
// 404s) and for resources that don't exist or are soft-deleted.

// Per spec §5.1 site #9: this regex was originally a divergent shape
// (`/^[a-z0-9](?:-?[a-z0-9])*$/`) which admitted single-char slugs
// AND permitted optional-non-hyphen runs. PR-3 reconciles to the
// canonical lib/cms/slug.ts SLUG_RE so the admin-bar resolver
// matches the same slug shape every server + client validator uses.
// Lost case (`/a`): single-char slugs were already rejected by
// SLUG_MIN=2 at the server-validation layer, so this reconciliation
// loses NOTHING functional.
import { SLUG_RE as SLUG_SHAPE } from '@/lib/cms/slug'
// Length caps mirror the DB column bounds (projects.slug = varchar(120),
// posts.slug = varchar(140)). Capping at the resolver layer prevents an
// authenticated attacker from minting arbitrary-length cache keys by
// probing /projects/<200-char-string>/ — bounded blast radius on the
// Next.js data cache.
const MAX_SLUG_PROJECT = 120
const MAX_SLUG_POST = 140

export type EditTargetKind = 'project' | 'post'

export interface EditTarget {
  kind: EditTargetKind
  id: number
  slug: string
  label: string
}

// `unstable_cache`'s `tags` option is captured at definition time, so
// per-slug invalidation requires a per-slug wrapper. We memoise these
// wrappers in a bounded FIFO map so repeat resolvers for the same slug
// reuse the same `unstable_cache` instance across requests, and the
// per-slug closure count is bounded at 500 entries per resource kind
// (≈ a few KB worst case — function objects are tiny). FIFO eviction
// keys on Map insertion order.
const MAX_WRAPPERS = 500

type CachedLookup = () => Promise<EditTarget | null>

function memoisedFactory(
  resourceLabel: 'project' | 'post',
  table: typeof projects | typeof posts,
  kind: EditTargetKind,
  label: string,
  resolverTag: (slug: string) => string,
) {
  const map = new Map<string, CachedLookup>()
  return function lookup(slug: string): CachedLookup {
    const existing = map.get(slug)
    if (existing) return existing
    const wrapped = unstable_cache(
      async (): Promise<EditTarget | null> => {
        const rows = await db
          .select({ id: table.id })
          .from(table)
          .where(and(eq(table.slug, slug), isNull(table.deletedAt)))
          .limit(1)
        const row = rows[0]
        if (!row) return null
        return { kind, id: row.id, slug, label }
      },
      [`admin-bar-edit-target-${resourceLabel}`, slug],
      { revalidate: 300, tags: [resolverTag(slug)] },
    )
    map.set(slug, wrapped)
    if (map.size > MAX_WRAPPERS) {
      const firstKey = map.keys().next().value
      if (firstKey !== undefined) map.delete(firstKey)
    }
    return wrapped
  }
}

const lookupProject = memoisedFactory(
  'project',
  projects,
  'project',
  'Edit project',
  tag.projectSlugResolver,
)
const lookupPost = memoisedFactory(
  'post',
  posts,
  'post',
  'Edit post',
  tag.postSlugResolver,
)

// Strict pathname patterns. Single-segment slugs only — nested URLs
// (e.g. /projects/[slug]/units/[id]) intentionally do NOT match,
// because the bar's Edit link wouldn't be meaningful for them yet.
const PROJECT_PATH = /^\/projects\/([^/?#]+)$/
const POST_PATH = /^\/blog\/([^/?#]+)$/

function validSlug(raw: string, max: number): string | null {
  if (raw.length === 0 || raw.length > max) return null
  return SLUG_SHAPE.test(raw) ? raw : null
}

export const resolveEditTarget = cache(
  async (pathname: string): Promise<EditTarget | null> => {
    const projectMatch = pathname.match(PROJECT_PATH)
    if (projectMatch) {
      const slug = validSlug(projectMatch[1] ?? '', MAX_SLUG_PROJECT)
      if (!slug) return null
      return lookupProject(slug)()
    }
    const postMatch = pathname.match(POST_PATH)
    if (postMatch) {
      const slug = validSlug(postMatch[1] ?? '', MAX_SLUG_POST)
      if (!slug) return null
      return lookupPost(slug)()
    }
    return null
  },
)
