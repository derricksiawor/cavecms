import 'server-only'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { ArrowUpRight } from 'lucide-react'
import { db } from '@/db/client'
import { getSetting } from '@/lib/cms/getSettings'
import { resolveSegments } from '@/lib/blog/resolveSegments'
import { blogIndexUrl, postUrl } from '@/lib/blog/urls'
import { RevealOnView } from '@/components/project-sections/_shared/RevealOnView'

// Server-rendered "related posts" rail for the post detail page. Mirrors
// components/project-sections/SimilarProjectsRail faithfully (same markup,
// styling, stagger animation, "null when none" behaviour) — the user asked for
// "related posts on detail page just like related projects on projects page.
// beautiful like that, you can reuse that component."
//
// RANKING (spec §9 — shared category FIRST, then shared tag, then recency):
//   bucket 0 — shares >=1 category with the current post
//   bucket 1 — shares >=1 tag with the current post (and not already bucket 0)
//   bucket 2 — recency fallback (any other published post)
// Within a bucket, newest-first (published_at DESC, id DESC). Computed in ONE
// bounded SQL query: two correlated EXISTS subqueries drive a CASE rank, so the
// post's full taxonomy never crosses into app memory and there's no N+1.
//
// GATES
//   - Current post is always excluded (p.id <> currentPostId).
//   - Only PUBLISHED, non-trashed posts (published = TRUE AND deleted_at IS NULL).
//   - Cap = blog_settings.relatedPostsCount (0 -> render nothing, like WP's
//     "show 0 related"). Clamped 0..6 by the registry; Math.min is belt-and-braces.
//
// Returns null when the cap is 0 OR no other published post exists — better than
// an empty "Keep reading" headline with no cards underneath (same rationale as
// the projects rail).

interface RailRow {
  slug: string
  title: string
  excerpt: string | null
  published_at: Date | string | null
  variants: string | { md?: string; lg?: string } | null
}

export async function SimilarPostsRailSection({
  postId,
}: {
  postId: number
}): Promise<ReactNode> {
  const [blog, segments] = await Promise.all([
    getSetting('blog_settings'),
    resolveSegments(),
  ])

  // relatedPostsCount is Zod-clamped 0..6; the extra clamp defends against a
  // malformed row. 0 -> the operator turned related posts off -> render nothing.
  const limit = Math.min(6, Math.max(0, Math.floor(blog.relatedPostsCount)))
  if (limit === 0) return null

  // Drizzle binds postId/limit as positional params; no string interpolation
  // hits the SQL. The two EXISTS subqueries share the post_categories/post_tags
  // junctions (PK + idx_pc_category/idx_pt_tag indexed) against the CURRENT
  // post's term sets, so ranking is sargable and bounded by LIMIT.
  const [rows] = (await db.execute(sql`
    SELECT
      p.slug,
      p.title,
      p.excerpt,
      p.published_at,
      m.variants
    FROM posts p
    LEFT JOIN media m
      ON m.id = p.hero_image_id AND m.deleted_at IS NULL
    WHERE p.published = TRUE
      AND p.deleted_at IS NULL
      AND p.id <> ${postId}
    ORDER BY
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM post_categories pc_self
          JOIN post_categories pc_other
            ON pc_other.category_id = pc_self.category_id
          WHERE pc_self.post_id = ${postId}
            AND pc_other.post_id = p.id
        ) THEN 0
        WHEN EXISTS (
          SELECT 1
          FROM post_tags pt_self
          JOIN post_tags pt_other
            ON pt_other.tag_id = pt_self.tag_id
          WHERE pt_self.post_id = ${postId}
            AND pt_other.post_id = p.id
        ) THEN 1
        ELSE 2
      END,
      p.published_at DESC,
      p.id DESC
    LIMIT ${limit}
  `)) as unknown as [RailRow[]]

  if (rows.length === 0) return null

  const items = rows.map((r) => {
    // Defensive parse — a malformed media.variants cell should collapse to a
    // placeholder thumb, not 500 the page. Mirrors the projects rail + hydrate.
    let v: { md?: string; lg?: string } | null = null
    if (typeof r.variants === 'string') {
      try {
        v = JSON.parse(r.variants) as { md?: string; lg?: string }
      } catch {
        v = null
      }
    } else {
      v = r.variants as { md?: string; lg?: string } | null
    }
    // Stable UTC date label (yyyy-mm-dd), matching the detail chrome's <time>.
    const published = r.published_at ? new Date(r.published_at) : null
    const dateLabel =
      published && !Number.isNaN(published.getTime())
        ? published.toISOString().slice(0, 10)
        : null
    return {
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      dateLabel,
      // Segment + structure-aware detail URL (honors a custom blog segment).
      href: postUrl(r.slug, segments, r.published_at),
      thumb: v?.md ?? v?.lg ?? null,
    }
  })

  return (
    <RevealOnView
      as="section"
      animation="slide-up"
      className="bg-cream py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
              Keep reading
            </p>
            <h2 className="mt-3 font-serif text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight text-near-black">
              Related posts
            </h2>
          </div>
          <Link
            href={blogIndexUrl(1, segments)}
            className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-near-black underline-offset-4 hover:text-copper-700 hover:underline min-h-[44px]"
          >
            See every post
            <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
          </Link>
        </div>

        <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p, i) => (
            <li
              key={p.slug}
              className="cavecms-stagger-item animate-cavecms-fade-in"
              style={{ ['--stagger-index' as string]: i }}
            >
              <Link
                href={p.href}
                className="group block overflow-hidden rounded-2xl border border-near-black/8 bg-cream-50 shadow-sm shadow-near-black/5 transition-all duration-standard ease-standard hover:-translate-y-1 hover:shadow-xl hover:shadow-near-black/10 hover:border-copper-300"
              >
                <div className="relative aspect-[4/3] overflow-hidden bg-cream-200">
                  {p.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumb}
                      alt={p.title}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-elegant ease-standard group-hover:scale-105"
                    />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center text-warm-stone">
                      <span className="text-xs uppercase tracking-[0.28em]">
                        No image yet
                      </span>
                    </div>
                  )}
                </div>
                <div className="p-6">
                  <h3 className="font-serif text-xl font-semibold tracking-tight text-near-black">
                    {p.title}
                  </h3>
                  {p.excerpt && (
                    <p className="mt-2 line-clamp-2 text-sm text-warm-stone leading-relaxed">
                      {p.excerpt}
                    </p>
                  )}
                  {p.dateLabel && (
                    <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-700">
                      {p.dateLabel}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </RevealOnView>
  )
}
