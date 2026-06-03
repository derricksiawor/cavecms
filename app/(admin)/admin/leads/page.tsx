import { z } from 'zod'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { LeadsTable } from './LeadsTable'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// Same allow-list as /api/admin/leads — accept only the four known
// source / status enum values. Unknown values from a crafted URL get
// dropped at the boundary, not echoed into the table's <select> nor
// the subsequent network call.
const FilterParams = z.object({
  source: z.enum(['contact', 'brochure', 'inquiry', 'form']).optional(),
  status: z.enum(['new', 'contacted', 'won', 'lost']).optional(),
  trashed: z.enum(['0', '1']).optional(),
})

// Server page is a thin shim: gate by role (admin/editor/viewer), read
// filter searchParams, and hand off to the client table. The table
// fetches its own data so changing filters never round-trips through
// the server render path.
export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; status?: string; trashed?: string }>
}) {
  const ctx = await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const raw = await searchParams
  // .safeParse so a crafted `?source=<script>` lands cleanly on the
  // default view instead of crashing the page render.
  const parsed = FilterParams.safeParse(raw)
  const sp = parsed.success ? parsed.data : {}
  const showTrashed = sp.trashed === '1'
  return (
    <div className="max-w-6xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        {showTrashed ? 'Recovery' : 'Inbox'}
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        {showTrashed ? 'Leads in Trash' : 'Leads'}
      </h1>
      {showTrashed && (
        <p className="mt-3 max-w-xl text-sm text-warm-stone">
          Leads you delete show up here for 30 days. Restore one and it
          rejoins the inbox.
        </p>
      )}
      <LeadsTable
        role={ctx.role}
        initialFilters={{ source: sp.source, status: sp.status }}
        showTrashed={showTrashed}
      />
    </div>
  )
}
