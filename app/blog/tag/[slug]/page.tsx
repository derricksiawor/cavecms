import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { SLUG_RE } from '@/lib/cms/slug'
import { renderCmsBlogArchive, parseLoopPage } from '@/app/_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'
import { getSiteOrigin } from '@/lib/cms/getSiteOrigin'
import { archiveCollectionPageLd } from '@/lib/seo/blog-jsonld'
import { safeJsonForScript } from '@/lib/seo/escape'
import { tagUrl } from '@/lib/blog/urls'
// blog-system worktree (Phase 5): segment-aware canonical + JSON-LD archive URL.
import { resolveSegments } from '@/lib/blog/resolveSegments'

// /blog/tag/<slug> — a tag archive. Two-segment static route, matched before
// /blog/[slug] (more-specific static segments win). Mirror of the category
// archive route; tags have no description.
export const dynamic = 'force-dynamic'

type Params = Promise<{ slug: string }>
type SearchParams = Promise<Record<string, string | string[] | undefined>>

interface TermRow {
  slug: string
  name: string
}

async function getTag(slug: string): Promise<TermRow | null> {
  if (!SLUG_RE.test(slug)) return null
  const [rows] = (await db.execute(sql`
    SELECT slug, name FROM tags WHERE slug = ${slug} LIMIT 1
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
  const term = await getTag(slug)
  if (!term) return { title: 'Not found' }
  const search = await searchParams
  const page = parseLoopPage(search)
  const segments = await resolveSegments()
  return resolveMetadata({
    title: `${term.name} — Blog`,
    description: `Posts tagged ${term.name}.`,
    fallbackTitle: `${term.name} — Blog`,
    canonicalPath: tagUrl(term.slug, page, segments),
  })
}

export default async function TagArchive({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { slug } = await params
  const term = await getTag(slug)
  if (!term) notFound()

  const search = await searchParams

  const tree = await renderCmsBlogArchive(
    { kind: 'tag', slug: term.slug, name: term.name },
    { search },
  )
  if (!tree) notFound()

  const segments = await resolveSegments()
  const siteOrigin = await getSiteOrigin()
  const ld = archiveCollectionPageLd({
    termKind: 'tag',
    termName: term.name,
    termSlug: term.slug,
    archivePath: tagUrl(term.slug, 1, segments),
    siteOrigin,
  })

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForScript(ld) }}
      />
      {tree}
    </>
  )
}
