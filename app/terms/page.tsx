import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { renderCmsPage } from '../_shared/cmsPage'
import { resolveMetadata } from '@/lib/seo/resolve'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  // Same `published=1 AND deleted_at IS NULL` filter as the renderCmsPage
  // call below — an unpublished or trashed Terms row must not leak its
  // draft seo_title / seo_description in the 404 page's <head>.
  const [rows] = (await db.execute(sql`
    SELECT seo_title, seo_description
    FROM pages
    WHERE slug = 'terms'
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
    fallbackTitle: 'Terms of Service — Best World Properties',
    canonicalPath: '/terms',
  })
}

// Pure CMS tree — content lives in db/seeds/systemPageBlocks.ts and is
// fully editable via /admin/pages without touching this file. See
// project CLAUDE.md "#1 RULE — CMS-FIRST".
export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const search = await searchParams
  const tree = await renderCmsPage('terms', { search })
  if (!tree) notFound()
  return tree
}
