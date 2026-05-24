import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { renderCmsPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  // Filter `published = 1` AND `deleted_at IS NULL` so an unpublished
  // or trashed contact row does NOT leak its draft SEO fields in the
  // 404 page's <head>. Mirrors the renderCmsPage filter below and the
  // dynamic _page/[slug] resolver semantics.
  const [rows] = (await db.execute(sql`
    SELECT seo_title, seo_description
    FROM pages
    WHERE slug = 'contact'
      AND deleted_at IS NULL
      AND published = 1
    LIMIT 1
  `)) as unknown as [
    Array<{ seo_title: string | null; seo_description: string | null }>,
  ]
  const r = rows[0]
  return resolveMetadata({
    title: r?.seo_title ?? null,
    description: r?.seo_description ?? null,
    fallbackTitle: 'Contact — Best World Properties',
    canonicalPath: '/contact',
  })
}

// Pure CMS tree — the contact-info <address> card and the message form
// are both CMS blocks now (icon_box × 3 for the channels grid and the
// new `contact_form` block for the lead capture). This means cloning
// the Contact source page produces a complete, working clone instead
// of a page with hardcoded sections that the cloning system can't see.
// See MEMORY: feedback_cms_block_everything.md.
export default async function ContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const search = await searchParams
  const tree = await renderCmsPage('contact', { search })
  if (!tree) notFound()
  return tree
}
