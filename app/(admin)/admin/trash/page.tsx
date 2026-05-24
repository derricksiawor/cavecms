import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { TrashClient } from './TrashClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

interface TrashRow {
  id: number
  block_type: string
  deleted_at: Date
  page_slug: string
  page_title: string | null
}

// /admin/trash surfaces soft-deleted content_blocks within the 30-day
// recovery window — after that, the Plan 09 cron purge hard-removes
// rows with zero media_references and they can no longer be restored.
//
// Archived PROJECTS surface separately at /admin/projects?archived=1
// (T7) — restoring a project requires a different state-machine path
// (re-seed sections, restore preview_epoch) and lives outside this UI.
export default async function Trash() {
  await requireRoleOrRedirect(['admin', 'editor'])
  const [rows] = (await db.execute(sql`
    SELECT cb.id, cb.block_type, cb.deleted_at,
           p.slug AS page_slug, p.seo_title AS page_title
    FROM content_blocks cb
    JOIN pages p ON p.id = cb.page_id
    WHERE cb.deleted_at IS NOT NULL
      AND cb.deleted_at > NOW(3) - INTERVAL 30 DAY
    ORDER BY cb.deleted_at DESC
    LIMIT 1000
  `)) as unknown as [TrashRow[]]

  return (
    <div className="max-w-4xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Trash
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Trash
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        Anything you delete shows up here for 30 days so you can restore
        it. After 30 days, items that aren&rsquo;t being used anywhere on
        the site are cleaned up automatically.
      </p>
      <TrashClient initial={rows} />
    </div>
  )
}
