import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { TaxonomyClient } from './TaxonomyClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface CategoryRow {
  id: number
  slug: string
  name: string
  description: string | null
  parent_id: number | null
  position: number
  version: number
  post_count: number | string
}
interface TagRow {
  id: number
  slug: string
  name: string
  post_count: number | string
}

// Taxonomy management surface (Categories | Tags tabs). Mirrors the admin
// posts list: server reads the full row set (taxonomy is small — hard cap
// 1000), the client wraps AdminTable for sort/paginate + custom create/edit
// modals + custom delete confirmation (NEVER native dialogs). admin + editor
// reach it; viewers do not (mutations are admin/editor, deletes admin-only).
export default async function AdminTaxonomy() {
  const ctx = await requireRoleOrRedirect(['admin', 'editor'])
  // Delete is admin-only (the DELETE route gates to ['admin']); editors create
  // + edit but can't remove a term. Gate the UI affordance to match so an
  // editor never sees a Delete button that would 403.
  const canDelete = ctx.role === 'admin'

  const [[catRows], [tagRows]] = await Promise.all([
    db.execute(sql`
      SELECT c.id, c.slug, c.name, c.description, c.parent_id, c.position, c.version,
             (SELECT COUNT(*) FROM post_categories pc WHERE pc.category_id = c.id) AS post_count
      FROM categories c
      ORDER BY COALESCE(c.parent_id, c.id), (c.parent_id IS NOT NULL), c.position, c.id
      LIMIT 1000
    `) as unknown as Promise<[CategoryRow[]]>,
    db.execute(sql`
      SELECT t.id, t.slug, t.name,
             (SELECT COUNT(*) FROM post_tags pt WHERE pt.tag_id = t.id) AS post_count
      FROM tags t
      ORDER BY t.name, t.id
      LIMIT 1000
    `) as unknown as Promise<[TagRow[]]>,
  ])

  const categories = catRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    parentId: r.parent_id,
    position: r.position,
    version: r.version,
    postCount: Number(r.post_count ?? 0),
  }))
  const tags = tagRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    postCount: Number(r.post_count ?? 0),
  }))

  return (
    <section>
      <header className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Content
          </p>
          <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
            Categories &amp; tags
          </h1>
          <p className="mt-3 max-w-xl text-sm text-warm-stone">
            Group your posts so readers can browse by topic. Categories are the
            main sections of your blog; tags are lighter labels you can sprinkle
            across posts. Each one gets its own archive page on your site.
          </p>
        </div>
        <Link
          href="/admin/blog"
          className="text-[11px] font-semibold uppercase tracking-[0.24em] text-warm-stone transition-colors hover:text-near-black"
        >
          ← Back to posts
        </Link>
      </header>

      <TaxonomyClient
        initialCategories={categories}
        initialTags={tags}
        canDelete={canDelete}
      />
    </section>
  )
}
