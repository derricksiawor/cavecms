import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { resolveMetadata } from '@/lib/seo/resolve'

// /blog stays force-dynamic to mirror /projects: the underlying data
// is small and rarely changes, but the CMS save path fires
// revalidateTag('posts-index') without a downstream cache layer to
// invalidate. If a CDN/edge cache is added later the tag wiring is
// already correct.
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return resolveMetadata({
    canonicalPath: '/blog',
    fallbackTitle: 'News — CaveCMS',
    fallbackDescription:
      'Updates, milestones and stories from CaveCMS.',
  })
}

interface PostListRow {
  slug: string
  title: string
  excerpt: string | null
  // mysql2 may return TIMESTAMP as Date OR ISO string — normalize
  // at render time. Same pattern as /blog/[slug]/page.tsx.
  published_at: Date | string | null
  hero_image_id: number | null
  variants: { md?: string } | null
}

// Public blog index. Lists every published, not-soft-deleted post in
// reverse-chronological order. Hero variant comes from the joined
// media row; when the media has no `md` variant the card renders a
// neutral placeholder.
export default async function BlogIndex() {
  const [rows] = (await db.execute(sql`
    SELECT p.slug, p.title, p.excerpt, p.published_at, p.hero_image_id, m.variants
    FROM posts p
    LEFT JOIN media m ON m.id = p.hero_image_id AND m.deleted_at IS NULL
    WHERE p.published = TRUE AND p.deleted_at IS NULL
    ORDER BY p.published_at DESC, p.id DESC
    LIMIT 50
  `)) as unknown as [
    Array<PostListRow & { variants: string | { md?: string } | null }>,
  ]
  const posts: PostListRow[] = rows.map((r) => ({
    ...r,
    variants:
      typeof r.variants === 'string'
        ? (JSON.parse(r.variants) as { md?: string })
        : (r.variants as { md?: string } | null),
  }))

  return (
    <main className="py-12 px-4 max-w-6xl mx-auto">
      <h1 className="text-3xl font-semibold tracking-tight mb-8">News</h1>
      {posts.length === 0 ? (
        <p className="text-warm-stone">More coming soon.</p>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {posts.map((p) => (
            <li key={p.slug}>
              <a href={`/blog/${p.slug}`} className="block group">
                {p.variants?.md ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.variants.md}
                    alt={p.title}
                    className="w-full h-56 object-cover rounded transition-transform group-hover:scale-[1.02]"
                  />
                ) : (
                  <div className="w-full h-56 bg-cream-200 rounded-xl" />
                )}
                <h2 className="mt-3 font-medium">{p.title}</h2>
                {p.excerpt && (
                  <p className="text-sm text-warm-stone mt-1">{p.excerpt}</p>
                )}
                {p.published_at &&
                  (() => {
                    const d = new Date(p.published_at)
                    return (
                      <time
                        className="text-[11px] uppercase tracking-wide text-copper-600 mt-2 inline-block"
                        dateTime={d.toISOString()}
                      >
                        {d.toISOString().slice(0, 10)}
                      </time>
                    )
                  })()}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
