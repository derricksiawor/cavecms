import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { ProjectsTable } from './ProjectsTable'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface ProjectRow {
  id: number
  slug: string
  name: string
  status: string
  published: number
  featured_order: number | null
  deleted_at: Date | null
  version: number
  updated_at: Date
}

// Admin projects table. Editor + Admin only — viewer browses public
// site instead. Sort order matches the public list (featured_order
// ascending with NULLs last, then alphabetical). The deleted_at
// filter is conditional on the archived query param so the same
// page powers the "archived" view (cheap toggle, no second route).
export default async function AdminProjects({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>
}) {
  const ctx = await requireRoleOrRedirect(['admin', 'editor'])
  const sp = await searchParams
  const showArchived = sp.archived === '1'

  const [rows] = (await db.execute(
    showArchived
      ? sql`
          SELECT id, slug, name, status, published, featured_order,
                 deleted_at, version, updated_at
          FROM projects
          WHERE deleted_at IS NOT NULL
            AND deleted_at > NOW(3) - INTERVAL 30 DAY
          ORDER BY deleted_at DESC
        `
      : sql`
          SELECT id, slug, name, status, published, featured_order,
                 deleted_at, version, updated_at
          FROM projects
          WHERE deleted_at IS NULL
          ORDER BY (featured_order IS NULL), featured_order, name
        `,
  )) as unknown as [ProjectRow[]]

  return (
    <div className="max-w-5xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Catalogue
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Projects
      </h1>
      <ProjectsTable
        role={ctx.role as 'admin' | 'editor'}
        initial={rows}
        showArchived={showArchived}
      />
    </div>
  )
}
