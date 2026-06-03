import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { renderCmsPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  // Filter `published = 1 AND deleted_at IS NULL` so an unpublished
  // or trashed Projects row never leaks draft SEO fields into the
  // <head>. Mirrors the renderCmsPage filter below + the dynamic
  // _page/[slug] resolver semantics.
  const [rows] = (await db.execute(sql`
    SELECT title, seo_title, seo_description
    FROM pages
    WHERE slug = 'projects'
      AND deleted_at IS NULL
      AND published = 1
    LIMIT 1
  `)) as unknown as [
    Array<{
      title: string | null
      seo_title: string | null
      seo_description: string | null
    }>,
  ]
  const r = rows[0]
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? null,
    fallbackTitle: 'Projects — CaveCMS',
    canonicalPath: '/projects',
    contentType: 'projectsIndex',
    templateVars: { title: r?.title ?? 'Projects' },
  })
}

// CMS-driven /projects index. The hero, intro, and CTA live as
// content_blocks; the project listing inside the page (via the
// `featured_projects` block) still reads the `projects` table at
// render time, so the cards stay data-driven while the surrounding
// page is editable from /admin/pages. See project CLAUDE.md
// "#1 RULE — CMS-FIRST".
export default async function ProjectsIndex({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const search = await searchParams
  const tree = await renderCmsPage('projects', { search })
  if (!tree) notFound()
  return tree
}
