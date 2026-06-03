import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { SLUG_RE } from '@/lib/cms/slug'
import { renderCmsBlogArchive, parseLoopPage } from '@/app/_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { archiveCollectionPageLd } from '@/lib/seo/blog-jsonld'
import { safeJsonForScript } from '@/lib/seo/escape'
import { categoryUrl } from '@/lib/blog/urls'
// blog-system worktree (Phase 5): segment-aware canonical + JSON-LD archive URL.
import { resolveSegments } from '@/lib/blog/resolveSegments'

// /blog/category/<slug> — a category archive. This two-segment STATIC route is
// matched by Next BEFORE the single-segment dynamic /blog/[slug] (more-specific
// static path segments win), so /blog/category/x resolves here, not to the
// post detail. force-dynamic mirrors /blog (the loop reads ?page= + the data is
// small + revalidateTag busts it). The literal `/blog` segment is Phase-5
// configurable; lib/blog/urls is the seam.
export const dynamic = 'force-dynamic'

type Params = Promise<{ slug: string }>
type SearchParams = Promise<Record<string, string | string[] | undefined>>

interface TermRow {
  slug: string
  name: string
  description: string | null
}

// Resolve a category by slug. Returns null for a malformed slug (without a DB
// hit) or an unknown term. Shared by generateMetadata + the page render.
async function getCategory(slug: string): Promise<TermRow | null> {
  if (!SLUG_RE.test(slug)) return null
  const [rows] = (await db.execute(sql`
    SELECT slug, name, description FROM categories WHERE slug = ${slug} LIMIT 1
  `)) as unknown as [TermRow[]]
  return rows[0] ?? null
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug } = await params
  const term = await getCategory(slug)
  if (!term) return { title: 'Not found' }
  const search = await searchParams
  const page = parseLoopPage(search)
  const segments = await resolveSegments()
  // Page 2+ canonicalises to its own paginated archive URL so duplicate-content
  // signals stay clean — mirrors /blog's metadata discipline.
  return resolveMetadata({
    title: `${term.name} — Blog`,
    description:
      term.description && term.description.trim() !== ''
        ? term.description
        : `Posts in ${term.name}.`,
    fallbackTitle: `${term.name} — Blog`,
    canonicalPath: categoryUrl(term.slug, page, segments),
  })
}

export default async function CategoryArchive({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug } = await params
  const term = await getCategory(slug)
  if (!term) notFound()

  const search = await searchParams

  const tree = await renderCmsBlogArchive(
    { kind: 'category', slug: term.slug, name: term.name, description: term.description },
    { search },
  )
  // A null tree means the `blog` system page row is missing — a seed/deploy bug
  // (not a user-facing 404). Surface it as notFound() so it's at least visible.
  if (!tree) notFound()

  const segments = await resolveSegments()
  const siteOrigin = await getSiteOrigin()
  const ld = archiveCollectionPageLd({
    termKind: 'category',
    termName: term.name,
    termSlug: term.slug,
    description: term.description,
    archivePath: categoryUrl(term.slug, 1, segments),
    siteOrigin,
  })

  return (
    <>
      <script
        type="application/ld+json"
        // safeJsonForScript escapes </script>, --> and U+2028/U+2029 so the
        // admin-controlled term name/description can never break out.
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
      {tree}
    </>
  )
}
