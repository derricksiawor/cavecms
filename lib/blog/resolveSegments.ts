import 'server-only'
import { getSetting } from '@/lib/cms/getSettings'
import {
  DEFAULT_SEGMENTS,
  type BlogStructure,
  type PermalinkSegments,
} from '@/lib/blog/urls'

// Cached runtime resolvers for the operator-configurable permalink segments,
// modeled on lib/security/getResolvedLoginPath.ts: each reads a settings row via
// getSetting (which is unstable_cache'd + tag-revalidated, busted by the
// settings PATCH route on save) and falls back to the literal default. Resolve
// ONCE per request/render and thread the result (a small plain object) into the
// synchronous url helpers (lib/blog/urls.ts) — the renderer (LxPosts) is sync +
// runs in the editor canvas, so it can never await these itself.
//
// FLAT-STRUCTURE COLLISION SAFETY (decision recorded here, single source):
// `flat` would map `/<slug>` directly to a post, which RISKS shadowing a real
// page/system slug. CaveCMS resolves bare single-segment paths to PAGES via the
// middleware CMS rewrite (→ /cms-render/<slug> → the pages table). Making flat
// collision-safe would require the cms-render route to fall through to a POST
// lookup after a page miss — a change to a shared, security-sensitive route
// outside Phase 5's localized scope. Per the build brief's explicit fallback
// clause, flat is therefore DEGRADED to 'postname' for ROUTING + URL generation:
// the schema still accepts 'flat' (so a future phase can light it up without a
// migration), but `getBlogStructure()` and `resolveSegments()` normalize it to
// 'postname' and log a one-time note. The settings UI shows the operator that
// flat is "treated as post-name today". This guarantees a real page slug is
// NEVER shadowed by a post.

let flatFallbackWarned = false
function normalizeStructure(raw: BlogStructure): BlogStructure {
  if (raw === 'flat') {
    if (!flatFallbackWarned) {
      flatFallbackWarned = true
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'permalink_flat_structure_degraded_to_postname',
          detail:
            'permalink_blog.structure=flat is treated as postname for routing (collision-safety); post URLs render as /<seg>/<slug>.',
        }),
      )
    }
    return 'postname'
  }
  return raw
}

/** Resolve all permalink segments for the current request in ONE call. The
 *  returned object is threaded into the lib/blog/urls.ts helpers + baked onto
 *  hydrated post/loop items so the synchronous renderer never awaits. */
export async function resolveSegments(): Promise<PermalinkSegments> {
  const [blog, projects] = await Promise.all([
    getSetting('permalink_blog'),
    getSetting('permalink_projects'),
  ])
  return {
    blog: blog.segment || DEFAULT_SEGMENTS.blog,
    projects: projects.segment || DEFAULT_SEGMENTS.projects,
    structure: normalizeStructure(blog.structure),
  }
}

/** Just the projects base segment. Used by app/projects/page.tsx (the only
 *  call site that needs the projects segment without the full resolve). */
export async function getProjectsSegment(): Promise<string> {
  const v = await getSetting('permalink_projects')
  return v.segment || DEFAULT_SEGMENTS.projects
}

/** The DYNAMIC reserved-slug set for validatePageSlug: the configured blog +
 *  projects segments WHEN they differ from the literal defaults ('blog' /
 *  'projects' are already in the static RESERVED set, so including them is
 *  redundant). A page/post slug can never claim a configured permalink segment.
 *  Returns an empty set on a fresh/default install (zero overhead added to slug
 *  validation). Lowercased for direct .has() against a SLUG_RE-lowercased slug. */
export async function getCustomSegmentReservedSet(): Promise<ReadonlySet<string>> {
  const s = await resolveSegments()
  const out = new Set<string>()
  if (s.blog !== DEFAULT_SEGMENTS.blog) out.add(s.blog.toLowerCase())
  if (s.projects !== DEFAULT_SEGMENTS.projects) out.add(s.projects.toLowerCase())
  return out
}
