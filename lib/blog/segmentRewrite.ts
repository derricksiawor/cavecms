// PURE, EDGE-SAFE. No '@/db', no 'node:*', no 'server-only' — imported by the
// Edge middleware. Maps a PUBLIC path under an operator-configured permalink
// segment to its CANONICAL internal route (the file-based app/blog/* and
// app/projects/* trees). The visitor's URL bar keeps showing the configured
// segment; the rewrite TARGET is internal (same model as the /cms-render
// rewrite). Defaults preserve today's URLs byte-identically: when a segment
// equals its literal default ('blog'/'projects'), this returns null (NO rewrite)
// so the existing file route serves the path directly — no double-rewrite.
//
// Slug shape is validated here (mirrors lib/cms/slug SLUG_RE — duplicated as a
// local literal to keep this module dependency-free for the Edge bundle) so a
// malformed segment tail falls through to null rather than rewriting to a
// canonical route that would 404 anyway.

import type { BlogStructure } from '@/lib/blog/urls'

// Local copy of the canonical slug regex (lib/cms/slug.SLUG_RE). Kept inline so
// this edge-imported module pulls in nothing else. Single source of truth still
// lives in lib/cms/slug; a unit test asserts they stay identical.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 4-digit year (0001-9999) + 2-digit month (01-12). Loose-but-bounded — the
// canonical /blog/[slug] route resolves the post by SLUG regardless of the
// dated prefix, so this only needs to recognize the shape, not the calendar.
const YYYY_RE = /^\d{4}$/
const MM_RE = /^(0[1-9]|1[0-2])$/

export interface SegmentRewriteInput {
  /** The request pathname (already decoded, leading slash, no query). */
  pathname: string
  /** Resolved blog base segment (e.g. 'blog' or 'news'). */
  blogSegment: string
  /** Resolved projects base segment (e.g. 'projects' or 'work'). */
  projectsSegment: string
  /** Resolved (collision-safe) blog post-path structure. */
  blogStructure: BlogStructure
}

/**
 * Returns the canonical INTERNAL pathname to rewrite to, or null when the path
 * doesn't need a rewrite (caller then proceeds with the generic CMS rewrite /
 * file routing untouched).
 *
 * Two cases produce a rewrite:
 *
 * (1) A NON-DEFAULT blog/projects base segment — the FULL mapping:
 *   /<blogSeg>                       → /blog
 *   /<blogSeg>/category/<s>          → /blog/category/<s>
 *   /<blogSeg>/tag/<s>               → /blog/tag/<s>
 *   /<blogSeg>/feed | feed.xml       → /blog/feed
 *   post (per structure):
 *     postname            /<blogSeg>/<slug>             → /blog/<slug>
 *     year-month-postname /<blogSeg>/<yyyy>/<mm>/<slug> → /blog/<slug>
 *     flat                (normalized to postname upstream — never reaches here)
 *   /<projSeg>                       → /projects
 *   /<projSeg>/<slug>                → /projects/<slug>
 *
 * (2) The DEFAULT 'blog' segment WITH the year-month structure — ONLY the
 *   4-part dated post shape is rewritten, because there is no
 *   app/blog/[yyyy]/[mm]/[slug] file route; the canonical /blog/[slug] route
 *   resolves the post by SLUG regardless of the dated prefix:
 *     /blog/<yyyy>/<mm>/<slug>       → /blog/<slug>
 *   Every NON-dated path under the default segment (/blog, /blog/<slug> 2-part,
 *   /blog/category/<s>, /blog/tag/<s>, /blog/feed) returns null so the existing
 *   file routes serve them unchanged — default + postname stays byte-identical.
 *
 * The reserved sub-segments 'category', 'tag', 'feed' under the blog segment are
 * routed explicitly so a post can never be named one of them on a custom
 * segment (they're matched before the post branch).
 */
export function rewriteConfiguredSegment(input: SegmentRewriteInput): string | null {
  const { pathname, blogSegment, projectsSegment, blogStructure } = input

  // Split into clean segments. A trailing slash or duplicate slashes produce
  // empty members — filter them so '/news/' behaves like '/news'.
  const parts = pathname.split('/').filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const first = parts[0]!

  // ─── Blog: DEFAULT segment + year-month → rewrite ONLY the dated post path ───
  // For the default 'blog' segment we must NOT touch the index, the 2-part
  // /blog/<slug>, /blog/category/<s>, /blog/tag/<s>, or /blog/feed — their file
  // routes serve them directly. The ONLY gap is the 4-part dated shape, which has
  // no file route, so map it to the canonical /blog/<slug>. Gated on STRUCTURE,
  // independent of default-vs-custom. The custom-segment branch below owns the
  // full mapping for non-default segments (this branch never fires for those).
  if (
    blogSegment === 'blog' &&
    first === 'blog' &&
    blogStructure === 'year-month-postname' &&
    parts.length === 4
  ) {
    const [, yyyy, mm, slug] = parts as [string, string, string, string]
    if (YYYY_RE.test(yyyy) && MM_RE.test(mm) && SLUG_RE.test(slug)) {
      return `/blog/${slug}`
    }
    return null
  }

  // ─── Blog segment (only when non-default) ───
  if (blogSegment !== 'blog' && first === blogSegment) {
    // /<blogSeg> → /blog
    if (parts.length === 1) return '/blog'

    const second = parts[1]!

    // /<blogSeg>/feed | feed.xml → /blog/feed
    if (parts.length === 2 && (second === 'feed' || second === 'feed.xml')) {
      return '/blog/feed'
    }

    // /<blogSeg>/category/<slug> → /blog/category/<slug>
    if (parts.length === 3 && second === 'category') {
      const slug = parts[2]!
      return SLUG_RE.test(slug) ? `/blog/category/${slug}` : null
    }
    // /<blogSeg>/tag/<slug> → /blog/tag/<slug>
    if (parts.length === 3 && second === 'tag') {
      const slug = parts[2]!
      return SLUG_RE.test(slug) ? `/blog/tag/${slug}` : null
    }

    // Post detail, per structure.
    if (blogStructure === 'year-month-postname') {
      // /<blogSeg>/<yyyy>/<mm>/<slug> → /blog/<slug>
      if (parts.length === 4) {
        const [, yyyy, mm, slug] = parts as [string, string, string, string]
        if (YYYY_RE.test(yyyy) && MM_RE.test(mm) && SLUG_RE.test(slug)) {
          return `/blog/${slug}`
        }
      }
      return null
    }
    // 'postname' (and 'flat' normalized to postname upstream):
    // /<blogSeg>/<slug> → /blog/<slug>. 'category'/'tag' already handled above.
    if (parts.length === 2) {
      return SLUG_RE.test(second) ? `/blog/${second}` : null
    }
    return null
  }

  // ─── Projects segment (only when non-default) ───
  if (projectsSegment !== 'projects' && first === projectsSegment) {
    // /<projSeg> → /projects
    if (parts.length === 1) return '/projects'
    // /<projSeg>/<slug> → /projects/<slug>
    if (parts.length === 2) {
      const slug = parts[1]!
      return SLUG_RE.test(slug) ? `/projects/${slug}` : null
    }
    return null
  }

  return null
}
