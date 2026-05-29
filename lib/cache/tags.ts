import 'server-only'

// Single source of truth for revalidateTag names. Saves are expressed in
// the language of "what was edited"; the helpers below translate that into
// the exact tag set the renderer is keyed by — so a renderer change ripples
// here once, not into every save handler.
//
// Naming: lower-case kebab; resource:slug for entity-specific; bare noun
// for collection/index tags.
export const tag = {
  page: (slug: string) => `page:${slug}`,
  project: (slug: string) => `project:${slug}`,
  post: (slug: string) => `post:${slug}`,
  // Pages-CMS dedicated tags. `home` is its own tag (not page:home)
  // because the home row's slug is operator-renameable — coupling the
  // home cache to a literal slug would silently desync after a rename.
  // `pages-index` covers both admin list and any future public index.
  home: 'home',
  pagesIndex: 'pages-index',
  projectsIndex: 'projects-index',
  featuredProjects: 'featured-projects',
  postsIndex: 'posts-index',
  settings: 'settings',
  sitemap: 'sitemap',
  robots: 'robots',
  // Slug → id resolver caches used by the public-side admin bar so
  // the context-aware "Edit X" link can deep-link without re-querying
  // the DB on every render. Per-slug granularity so a single rename
  // doesn't dump every cached resolver entry.
  pageSlugResolver: (slug: string) => `page-slug-resolver:${slug}`,
  projectSlugResolver: (slug: string) => `project-slug-resolver:${slug}`,
  postSlugResolver: (slug: string) => `post-slug-resolver:${slug}`,
} as const

export interface TagSet {
  tags: string[]
}

// Block save tag set. Page slug is always invalidated; for blocks whose
// renderer pulls from cross-cutting indexes (featured_projects bound to the
// projects index + featured fragment) those tags are added too. Renderer
// changes that shift this coupling MUST update this function — there is
// no auto-detect.
export function tagsForBlockSave(
  pageSlug: string,
  blockType?: string,
): TagSet {
  const t = new Set<string>([tag.page(pageSlug)])
  // lx_featured_projects pulls live from the projects table, so a save
  // touching it must also bust the projects-index + featured fragments.
  if (blockType === 'lx_featured_projects') {
    t.add(tag.featuredProjects)
    t.add(tag.projectsIndex)
  }
  return { tags: [...t] }
}

// projects are visible in three surfaces: the entity page, the index, and
// the homepage featured carousel. publish + slug toggles also touch the
// sitemap. Pass `coreChanged` for any name/tagline/hero-image edit so the
// featured carousel re-renders too.
export function tagsForProjectSave(
  slug: string,
  opts: {
    publishedChanged?: boolean
    slugChanged?: boolean
    featuredChanged?: boolean
    coreChanged?: boolean
    /** Required when slugChanged is true. Pre-rename slug whose page
     *  tag AND admin-bar slug-resolver cache must also invalidate so
     *  links to the old slug stop pointing at a stale id. */
    oldSlug?: string
  },
): TagSet {
  // Hard-fail rather than silently no-op when a rename is asserted
  // without the prior slug — that combination ALWAYS leaks stale
  // cache and is never the caller's intent.
  if (opts.slugChanged && !opts.oldSlug) {
    throw new Error('tagsForProjectSave: slugChanged=true requires oldSlug')
  }
  const t = new Set<string>([
    tag.project(slug),
    // Always touch the resolver cache for the current slug. Cheap
    // (one tag per save) and saves us from also invalidating on
    // create/restore/soft-delete via separate code paths.
    tag.projectSlugResolver(slug),
  ])
  if (opts.slugChanged && opts.oldSlug && opts.oldSlug !== slug) {
    t.add(tag.project(opts.oldSlug))
    t.add(tag.projectSlugResolver(opts.oldSlug))
  }
  if (opts.publishedChanged || opts.slugChanged) t.add(tag.sitemap)
  if (opts.publishedChanged || opts.slugChanged || opts.coreChanged) {
    t.add(tag.projectsIndex)
  }
  if (
    opts.publishedChanged ||
    opts.featuredChanged ||
    opts.slugChanged ||
    opts.coreChanged
  ) {
    t.add(tag.featuredProjects)
  }
  return { tags: [...t] }
}

// Create: the new row is unpublished by default, so the public-facing
// indexes / sitemap / featured carousel don't need busting (they
// filter on published=TRUE). The ONLY cache that cares is the bar's
// slug→id resolver — a pre-existing negative cache for this slug
// (visitor probed /projects/X before it existed) would otherwise hide
// the new Edit link for up to 5 minutes.
export function tagsForProjectCreate(slug: string): TagSet {
  return { tags: [tag.projectSlugResolver(slug)] }
}

// Soft-delete: equivalent invalidation to a publish-toggle-off save.
// The resource still exists in the DB but stops being public —
// every public-facing cache that referenced it must drop the
// reference. ALSO invalidates the bar's slug-resolver so the Edit
// link disappears immediately (without this, the bar deep-links to
// /admin/projects/<id> for an already-trashed resource for up to 5
// minutes, which then 404s in admin).
export function tagsForProjectDelete(slug: string): TagSet {
  return {
    tags: [
      tag.project(slug),
      tag.projectSlugResolver(slug),
      tag.projectsIndex,
      tag.featuredProjects,
      tag.sitemap,
    ],
  }
}

// Restore from trash: project comes back UNPUBLISHED, so technically
// only the resolver needs invalidating (the row is invisible to
// public surfaces until explicitly re-published). But the symmetric
// invalidation matches operator expectation: after restore, the bar's
// Edit link works again immediately, AND if there was a stale
// negative cache anywhere in the public layer it clears too.
export function tagsForProjectRestore(slug: string): TagSet {
  return tagsForProjectDelete(slug)
}

// posts are visible in two surfaces: the entity page and the index.
// publish + slug toggles also touch the sitemap. Pass `coreChanged`
// for any title/excerpt/heroImageId edit so the index card re-renders
// without bloating the invalidation surface on body-only saves.
export function tagsForPostSave(
  slug: string,
  opts: {
    publishedChanged?: boolean
    slugChanged?: boolean
    coreChanged?: boolean
    /** Required when slugChanged is true. Pre-rename slug whose page
     *  tag AND admin-bar slug-resolver cache must also invalidate so
     *  links to the old slug stop pointing at a stale id. */
    oldSlug?: string
  },
): TagSet {
  if (opts.slugChanged && !opts.oldSlug) {
    throw new Error('tagsForPostSave: slugChanged=true requires oldSlug')
  }
  const t = new Set<string>([
    tag.post(slug),
    tag.postSlugResolver(slug),
  ])
  if (opts.slugChanged && opts.oldSlug && opts.oldSlug !== slug) {
    t.add(tag.post(opts.oldSlug))
    t.add(tag.postSlugResolver(opts.oldSlug))
  }
  if (opts.publishedChanged || opts.slugChanged) {
    t.add(tag.sitemap)
  }
  if (opts.publishedChanged || opts.slugChanged || opts.coreChanged) {
    t.add(tag.postsIndex)
  }
  return { tags: [...t] }
}

// Create: only the bar's slug-resolver cares; new posts default to
// unpublished and don't appear in public indexes.
export function tagsForPostCreate(slug: string): TagSet {
  return { tags: [tag.postSlugResolver(slug)] }
}

// Soft-delete: same invalidation footprint as a publish-toggle-off
// save; plus the resolver tag so the bar's Edit link disappears.
export function tagsForPostDelete(slug: string): TagSet {
  return {
    tags: [
      tag.post(slug),
      tag.postSlugResolver(slug),
      tag.postsIndex,
      tag.sitemap,
    ],
  }
}

// Restore mirrors delete (symmetric).
export function tagsForPostRestore(slug: string): TagSet {
  return tagsForPostDelete(slug)
}

// pages surfaces: the entity page (`tag.page(slug)`), the home route
// (`tag.home`), the admin list (`tag.pagesIndex`), the sitemap, and
// the admin-bar slug→id resolver (`tag.pageSlugResolver(slug)`).
// `oldSlug` is required when `slugChanged=true` so the pre-rename tag
// entries get invalidated alongside the new slug. `wasHome`/`isHome`
// are independent flags rather than a single `wasHome` because the
// home-flip touches BOTH rows' caches (the prior home's `url_path`
// recomputes to `/{slug}`; the new home's recomputes to `/`).
export function tagsForPageSave(
  slug: string,
  opts: {
    publishedChanged?: boolean
    slugChanged?: boolean
    coreChanged?: boolean
    isHomeChanged?: boolean
    wasHome?: boolean
    isHome?: boolean
    /** Required when slugChanged is true. Pre-rename slug whose page
     *  tag AND admin-bar slug-resolver cache must also invalidate so
     *  links to the old slug stop pointing at a stale id. */
    oldSlug?: string | null
  } = {},
): TagSet {
  // Hard-fail rather than silently no-op when a rename is asserted
  // without the prior slug — that combination ALWAYS leaks stale
  // cache and is never the caller's intent. The explicit
  // null/undefined/empty-string check defeats a future caller that
  // builds `oldSlug = row.slug ?? ''` (where `!opts.oldSlug` would
  // truthily pass the empty-string case and let the guard slip).
  if (
    opts.slugChanged &&
    (opts.oldSlug === null ||
      opts.oldSlug === undefined ||
      opts.oldSlug.length === 0)
  ) {
    throw new Error('tagsForPageSave: slugChanged=true requires oldSlug')
  }
  const t = new Set<string>([
    tag.page(slug),
    tag.pageSlugResolver(slug),
  ])
  if (opts.oldSlug && opts.oldSlug !== slug) {
    t.add(tag.page(opts.oldSlug))
    t.add(tag.pageSlugResolver(opts.oldSlug))
  }
  // Home tag fires on either side of an `is_home` transition AND on
  // any save under the current home row (so a SEO/title edit to the
  // home page refreshes `/`).
  if (opts.wasHome || opts.isHome) {
    t.add(tag.home)
  }
  // Index + sitemap fire on any user-visible structural change. The
  // admin list (pagesIndex) also refreshes on coreChanged so a title
  // edit shows up immediately.
  if (opts.publishedChanged || opts.slugChanged || opts.isHomeChanged) {
    t.add(tag.pagesIndex)
    t.add(tag.sitemap)
  }
  if (opts.coreChanged) {
    t.add(tag.pagesIndex)
  }
  return { tags: [...t] }
}

// Create: new pages always start with `is_home=false`, but `published`
// may be true (admin role only — editor schema strips the field).
// Admin list refreshes unconditionally; sitemap + per-slug + home
// tags only on `published=true` first-write (a true draft is invisible
// to public surfaces).
export function tagsForPageCreate(
  slug: string,
  opts: { published?: boolean } = {},
): TagSet {
  const t = new Set<string>([
    tag.pagesIndex,
    tag.pageSlugResolver(slug),
  ])
  if (opts.published) {
    t.add(tag.page(slug))
    t.add(tag.sitemap)
  }
  return { tags: [...t] }
}

// Soft-delete: every public-facing cache that referenced this slug
// drops the reference; the admin list refreshes so the row disappears
// from the live tab and surfaces under `?trashed=1` instead. The
// `wasHome` flag drives `tag.home` invalidation; per §4.4 step 2 the
// row's `is_home` is cleared in the same UPDATE statement, so the
// home tag must fire even though the now-trashed row no longer
// reports is_home=1.
export function tagsForPageDelete(
  slug: string,
  opts: { wasHome?: boolean } = {},
): TagSet {
  const t = new Set<string>([
    tag.page(slug),
    tag.pageSlugResolver(slug),
    tag.pagesIndex,
    tag.sitemap,
  ])
  if (opts.wasHome) t.add(tag.home)
  return { tags: [...t] }
}

// Restore: lands the row as draft (§4.5 step 4 sets published=0 AND
// is_home=0). The asSlug-rename case requires the pre-restore slug
// for cache invalidation; pass `oldSlug` only when it differs from
// the restored slug.
export function tagsForPageRestore(
  slug: string,
  opts: { oldSlug?: string | null; wasHome?: boolean } = {},
): TagSet {
  const t = new Set<string>([
    tag.page(slug),
    tag.pageSlugResolver(slug),
    tag.pagesIndex,
    tag.sitemap,
  ])
  if (opts.oldSlug && opts.oldSlug !== slug) {
    t.add(tag.page(opts.oldSlug))
    t.add(tag.pageSlugResolver(opts.oldSlug))
  }
  if (opts.wasHome) t.add(tag.home)
  return { tags: [...t] }
}
