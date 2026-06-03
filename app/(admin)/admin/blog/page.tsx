import Link from 'next/link'
import clsx from 'clsx'
import { sql } from 'drizzle-orm'
import { Plus, FileText, Trash2 } from 'lucide-react'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { EmptyState } from '@/components/inline-edit/EmptyState'
import {
  PILL_BASE,
  VARIANT_CLASS,
  SIZE_CLASS,
  ICON_SIZE,
} from '@/components/admin/pillStyle'
import {
  listPosts,
  fetchTaxonomyFilterCatalog,
  isPostSortColumn,
  clampPerPage,
  clampPage,
  normalizeStatus,
  type PostSortColumn,
  type SortDir,
} from '@/lib/cms/listPosts'
import { PostsClient } from './PostsClient'
import { TrashedPostsClient } from './TrashedPostsClient'

export const dynamic = 'force-dynamic'

interface TrashedPostRow {
  id: number
  slug: string
  title: string
  deleted_at: Date | string
}

// Admin posts list. The (admin) layout already enforces
// requireRole(['admin','editor','viewer']) at the route-group level —
// this duplicate check is defense-in-depth in case the layout is
// ever short-circuited (e.g. dev-time error boundary). Editors and
// viewers see the same rows; only admin can publish/schedule/bulk-act,
// but the list is the same shape.
//
// Phase 8: the active list is now SERVER-DRIVEN — status tabs, search, sortable
// columns, taxonomy filter chips, and bounded pagination all flow through the
// URL query into lib/cms/listPosts. `?trashed=1` keeps the dedicated recovery
// view with Restore (mirrors /admin/projects?archived=1); the Trash status tab
// links to it so counts stay complete.
type Search = Promise<{
  trashed?: string
  status?: string
  q?: string
  sort?: string
  dir?: string
  page?: string
  per?: string
  category?: string
  tag?: string
}>

export default async function AdminBlog({
  searchParams,
}: {
  searchParams: Search
}) {
  await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const sp = await searchParams
  const showTrashed = sp.trashed === '1'

  if (showTrashed) {
    const [trashedRows] = (await db.execute(sql`
      SELECT id, slug, title, deleted_at
      FROM posts
      WHERE deleted_at IS NOT NULL
        AND deleted_at > NOW(3) - INTERVAL 30 DAY
      ORDER BY deleted_at DESC, id DESC
      LIMIT 1000
    `)) as unknown as [TrashedPostRow[]]

    return (
      <section>
        <header className="flex items-center justify-between mb-8">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
              Recovery
            </p>
            <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
              Posts in Trash
            </h1>
            <p className="mt-3 max-w-xl text-sm text-warm-stone">
              Posts you delete show up here for 30 days. Restore one and it
              comes back as a draft — flip the Publish switch to put it
              back on the public blog.
            </p>
          </div>
          <Link
            href="/admin/blog"
            className="text-[11px] font-semibold uppercase tracking-[0.24em] text-warm-stone transition-colors hover:text-near-black"
          >
            ← Back to active posts
          </Link>
        </header>
        <TrashedPostsClient initial={trashedRows} />
      </section>
    )
  }

  // ── Parse + validate the list query from the URL ──────────────────────────
  const status = normalizeStatus(sp.status)
  const q = typeof sp.q === 'string' ? sp.q.slice(0, 120) : ''
  const sort: PostSortColumn = isPostSortColumn(sp.sort) ? sp.sort : 'updated'
  const dir: SortDir = sp.dir === 'asc' ? 'asc' : 'desc'
  const page = clampPage(sp.page ? parseInt(sp.page, 10) : 1)
  const perPage = clampPerPage(sp.per ? parseInt(sp.per, 10) : NaN)
  // At most one taxonomy filter — category wins if somehow both are present.
  const categorySlug =
    typeof sp.category === 'string' && sp.category !== ''
      ? sp.category
      : undefined
  const tagSlug =
    !categorySlug && typeof sp.tag === 'string' && sp.tag !== ''
      ? sp.tag
      : undefined

  // The Trash tab is served by the dedicated ?trashed=1 recovery view (with
  // Restore), so when the operator selects the Trash tab we redirect the data
  // shape there — but still compute counts here for the tab badges. We fetch the
  // list for the CURRENT tab (non-trash) + the catalog in parallel.
  const [list, taxonomy] = await Promise.all([
    listPosts({
      status,
      search: q,
      sort,
      dir,
      page,
      perPage,
      categorySlug,
      tagSlug,
    }),
    fetchTaxonomyFilterCatalog(),
  ])

  const isFiltered =
    q.trim() !== '' ||
    status !== 'all' ||
    categorySlug !== undefined ||
    tagSlug !== undefined

  return (
    <section>
      <header className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Content
          </p>
          <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
            Blog posts
          </h1>
        </div>
        {/* PillButton primitive via the pillStyle module on `<Link>` (the
            button component can't host a Link). Same pattern as /admin/pages. */}
        <Link
          href="/admin/blog/new"
          className={clsx(
            PILL_BASE,
            VARIANT_CLASS['filled'],
            SIZE_CLASS['md'],
          )}
        >
          <Plus size={ICON_SIZE['md']} strokeWidth={2.4} />
          New post
        </Link>
      </header>

      {list.counts.trash > 0 && (
        <div className="mb-6">
          <Link
            href="/admin/blog?trashed=1"
            className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone transition-colors hover:border-copper-400 hover:text-near-black"
          >
            <Trash2 size={13} strokeWidth={2.2} />
            {list.counts.trash} {list.counts.trash === 1 ? 'post' : 'posts'} in
            Trash
          </Link>
        </div>
      )}

      <PostsClient
        rows={list.rows}
        total={list.total}
        counts={list.counts}
        status={status}
        search={q}
        sort={sort}
        dir={dir}
        page={list.page}
        perPage={list.perPage}
        categorySlug={categorySlug ?? null}
        tagSlug={tagSlug ?? null}
        categories={taxonomy.categories}
        tags={taxonomy.tags}
        emptyState={
          isFiltered ? (
            <EmptyState
              icon={FileText}
              title="No posts match"
              description="Try a different search, status tab, or taxonomy filter — or clear the filters to see every post."
            />
          ) : (
            <EmptyState
              icon={FileText}
              title="Write your first post"
              description="Long stories anchor your brand and help people find you on Google. A launch announcement, a behind-the-scenes look at a development, or a homeowner spotlight are great places to start."
              example="e.g. “Inside the design of Manual Residences”"
              cta={{ label: 'Create a post', href: '/admin/blog/new', icon: Plus }}
            />
          )
        }
      />
    </section>
  )
}
