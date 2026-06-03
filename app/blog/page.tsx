import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { renderCmsPage, parseLoopPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
// blog-system worktree (Phase 5): segment-aware canonical for the blog index.
import { resolveSegments } from '@/lib/blog/resolveSegments'
// Phase 7 adds feedUrl for the RSS <link rel="alternate"> auto-discovery hint.
import { blogIndexUrl, feedUrl } from '@/lib/blog/urls'

// /blog stays force-dynamic to mirror /projects: the underlying data is
// small and rarely changes, but the CMS save path fires
// revalidateTag('posts-index') without a downstream cache layer to
// invalidate, and the Blog Loop reads `?page=` at request time. If a
// CDN/edge cache is added later the tag wiring is already correct.
export const dynamic = 'force-dynamic'

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const search = await searchParams
  const page = parseLoopPage(search)

  // Pull SEO fields from the CMS page row (mirrors app/projects/page.tsx).
  // Filter `published = 1 AND deleted_at IS NULL AND kind = 'page'` so a
  // soft-deleted / unpublished row — or a hidden post_body page that somehow
  // shared the slug — never leaks draft SEO fields into the <head>.
  const [rows] = (await db.execute(sql`
    SELECT seo_title, seo_description
    FROM pages
    WHERE slug = 'blog'
      AND deleted_at IS NULL
      AND published = 1
      AND kind = 'page'
    LIMIT 1
  `)) as unknown as [
    Array<{ seo_title: string | null; seo_description: string | null }>,
  ]
  const r = rows[0]
  const segments = await resolveSegments()

  // Page 2+ canonicalises to its own paginated URL so duplicate-content
  // signals stay clean across the archive. No rel=prev/next <head> hints:
  // Next.js renders Metadata.other as `<meta name>`, NOT the `<link rel>`
  // those hints require, and Google deprecated rel=prev/next anyway. The
  // in-content Blog Loop pager already carries the rel=prev/next links.
  const base = await resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? null,
    fallbackTitle: 'Blog — CaveCMS',
    fallbackDescription: 'Updates, milestones and stories from CaveCMS.',
    canonicalPath: blogIndexUrl(page, segments),
  })

  // Phase 7: RSS auto-discovery. Next renders Metadata.alternates.types as
  // `<link rel="alternate" type="<key>" href="<value>">` in <head>, which is
  // exactly the feed-discovery hint readers + browsers look for. The href is
  // segment-aware (feedUrl honors a custom blog segment). Merged onto the
  // resolved base so the canonical from resolveMetadata is preserved.
  return {
    ...base,
    alternates: {
      ...base.alternates,
      types: {
        'application/rss+xml': [
          { url: feedUrl(segments), title: `${r?.seo_title ?? 'Blog'} RSS Feed` },
        ],
      },
    },
  }
}

// CMS-driven /blog index. The hero, intro, and CTA live as content_blocks;
// the post listing inside the page (via the loop-mode `lx_posts` block) reads
// the `posts` table at hydrate time, so the cards stay data-driven while the
// surrounding page is editable from /admin/pages. See project CLAUDE.md
// "#1 RULE — CMS-FIRST".
export default async function BlogIndex({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const search = await searchParams
  const tree = await renderCmsPage('blog', { search })
  if (!tree) notFound()
  return tree
}
