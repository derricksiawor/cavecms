import Link from 'next/link'
import clsx from 'clsx'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { Plus, FileEdit, Trash2 } from 'lucide-react'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { EmptyState } from '@/components/inline-edit/EmptyState'
import {
  PILL_BASE,
  VARIANT_CLASS,
  SIZE_CLASS,
  ICON_SIZE,
} from '@/components/admin/pillStyle'
import { PagesClient, type PageListRow } from './PagesClient'
import { TrashedPagesClient, type TrashedPageRow } from './TrashedPagesClient'

export const dynamic = 'force-dynamic'

// Admin pages list. The (admin) layout enforces requireRole at the
// route-group level; this defense-in-depth call also lets us read
// `ctx.role` so viewer sessions land on 404 INSTEAD of 403. The 404
// hides the surface from a probing viewer per spec §3.2 (the role
// matrix in §0 specifies: viewer → 404, not 403).

type Search = Promise<{ trashed?: string }>

export default async function AdminPages({
  searchParams,
}: {
  searchParams: Search
}) {
  const ctx = await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  // Spec §3.2: viewer never sees the surface exists. The role gate
  // throws 403 for unrecognised roles; for viewer specifically we
  // surface 404 manually so the response is indistinguishable from
  // a missing route.
  if (ctx.role === 'viewer') notFound()

  const sp = await searchParams
  const showTrashed = sp.trashed === '1'

  if (showTrashed) {
    const [trashedRows] = (await db.execute(sql`
      SELECT p.id, p.slug, p.title, p.deleted_at, p.url_path, p.is_home, p.system,
             u.email AS updated_by_email
      FROM pages p
      LEFT JOIN users u ON u.id = p.updated_by
      WHERE p.deleted_at IS NOT NULL
        AND p.deleted_at > NOW(3) - INTERVAL 30 DAY
      ORDER BY p.deleted_at DESC, p.id DESC
      LIMIT 1000
    `)) as unknown as [TrashedPageRow[]]

    return (
      <section>
        <header className="flex items-center justify-between mb-8">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
              Recovery
            </p>
            <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
              Pages in Trash
            </h1>
            <p className="mt-3 max-w-xl text-sm text-warm-stone">
              Pages you delete show up here for 30 days. Restoring brings
              one back as a draft — flip the Publish switch in the editor
              to put it back on the public site.
            </p>
          </div>
          <Link
            href="/admin/pages"
            className="text-[11px] font-semibold uppercase tracking-[0.24em] text-warm-stone transition-colors hover:text-near-black"
          >
            ← Back to active pages
          </Link>
        </header>
        <TrashedPagesClient
          initial={trashedRows}
          canRestore={ctx.role === 'admin'}
        />
      </section>
    )
  }

  // Active list. Sort `is_home DESC` first so the home row visually
  // anchors the table; then by updated_at desc. The client-side
  // AdminTable lets the operator re-sort by any column — initial sort
  // is the "natural" view.
  const [rows] = (await db.execute(sql`
    SELECT p.id, p.slug, p.title, p.is_home, p.system, p.published,
           p.published_at, p.updated_at, p.url_path, p.version,
           u.email AS updated_by_email
    FROM pages p
    LEFT JOIN users u ON u.id = p.updated_by
    WHERE p.deleted_at IS NULL
    ORDER BY p.is_home DESC, p.updated_at DESC, p.id DESC
    LIMIT 1000
  `)) as unknown as [PageListRow[]]

  const [trashedCountRows] = (await db.execute(sql`
    SELECT COUNT(*) AS n FROM pages
    WHERE deleted_at IS NOT NULL
      AND deleted_at > NOW(3) - INTERVAL 30 DAY
  `)) as unknown as [Array<{ n: number | string }>]
  const trashedCount = Number(trashedCountRows[0]?.n ?? 0)

  const canCreate = ctx.role === 'admin' || ctx.role === 'editor'

  return (
    <section>
      <header className="flex items-center justify-between mb-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Content
          </p>
          <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
            Pages
          </h1>
        </div>
        {canCreate && (
          // Use the PillButton style primitives via Link rather than the
          // PillButton button component — `<Link>` wrapping a `<button>`
          // is invalid HTML, and the pillStyle module is the documented
          // surface for non-button consumers per components/admin/PillButton.tsx.
          // Spec §3.2 + §9 mandate PillButton variant='filled' size='md'
          // for this CTA.
          <Link
            href="/admin/pages/new"
            className={clsx(
              PILL_BASE,
              VARIANT_CLASS['filled'],
              SIZE_CLASS['md'],
            )}
          >
            <Plus size={ICON_SIZE['md']} strokeWidth={2.4} />
            New page
          </Link>
        )}
      </header>

      {trashedCount > 0 && (
        <div className="mb-6">
          <Link
            href="/admin/pages?trashed=1"
            className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone transition-colors hover:border-copper-400 hover:text-near-black"
          >
            <Trash2 size={13} strokeWidth={2.2} />
            {trashedCount} {trashedCount === 1 ? 'page' : 'pages'} in Trash
          </Link>
        </div>
      )}

      <PagesClient
        initial={rows}
        role={ctx.role}
        emptyState={
          <EmptyState
            icon={FileEdit}
            title="Create your first page"
            description="Pages are the slow-moving anchors on your site — Home, About, Services, and anything else that doesn't change with every campaign. Start with a blank canvas or clone one of the seeded templates."
            example="e.g. “Our Process”, “Investment opportunities”"
            cta={
              canCreate
                ? { label: 'Create a page', href: '/admin/pages/new', icon: Plus }
                : undefined
            }
          />
        }
      />
    </section>
  )
}
