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
import { PostsClient } from './PostsClient'
import { TrashedPostsClient } from './TrashedPostsClient'

export const dynamic = 'force-dynamic'

interface PostListRow {
  id: number
  slug: string
  title: string
  published: number
  // mysql2 may return TIMESTAMP as Date OR ISO string depending on
  // driver config — normalize at render time.
  published_at: Date | string | null
  updated_at: Date | string
}

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
// viewers see the same rows; only admin can publish, but the list is
// the same shape.
//
// `?trashed=1` shows soft-deleted posts with a Restore button.
// Mirrors /admin/projects?archived=1.
type Search = Promise<{ trashed?: string }>

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

  // Client-side AdminTable handles sort + paginate, so we hand it
  // the full active set. Hard cap at 1000 — at that scale we'd move
  // to server-side pagination.
  const [posts] = (await db.execute(sql`
    SELECT id, slug, title, published, published_at, updated_at
    FROM posts
    WHERE deleted_at IS NULL
    ORDER BY updated_at DESC, id DESC
    LIMIT 1000
  `)) as unknown as [PostListRow[]]

  // Surface a "View posts in Trash" link whenever the recovery window
  // is non-empty, so an operator who deleted a post can always find
  // their way back even if the URL handoff isn't obvious.
  const [trashedCountRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM posts
    WHERE deleted_at IS NOT NULL
      AND deleted_at > NOW(3) - INTERVAL 30 DAY
  `)) as unknown as [Array<{ n: number | string }>]
  const trashedCount = Number(trashedCountRows[0]?.n ?? 0)

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
        {/* PR-3 §9 hard-rule: use the PillButton primitive via the
            pillStyle module on `<Link>` (the button component itself
            can't host a Link). Same pattern as /admin/pages "+ New
            page" CTA — closes the §9 "Posts page CTA refactor" item. */}
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

      {trashedCount > 0 && (
        <div className="mb-6">
          <Link
            href="/admin/blog?trashed=1"
            className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone transition-colors hover:border-copper-400 hover:text-near-black"
          >
            <Trash2 size={13} strokeWidth={2.2} />
            {trashedCount} {trashedCount === 1 ? 'post' : 'posts'} in Trash
          </Link>
        </div>
      )}

      <PostsClient
        initial={posts}
        emptyState={
          <EmptyState
            icon={FileText}
            title="Write your first post"
            description="Long stories anchor your brand and help people find you on Google. A launch announcement, a behind-the-scenes look at a development, or a homeowner spotlight are great places to start."
            example="e.g. “Inside the design of Manual Residences”"
            cta={{ label: 'Create a post', href: '/admin/blog/new', icon: Plus }}
          />
        }
      />
    </section>
  )
}
