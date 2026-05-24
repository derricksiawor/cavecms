import { notFound } from 'next/navigation'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { adminPolicy } from '@/lib/auth/adminPolicy'
import { NewPageForm } from './NewPageForm'

export const dynamic = 'force-dynamic'

// /admin/pages/new — create a new page. Gated to admin + editor per
// adminPolicy('createPage'). Viewer reaching this URL via direct
// navigation gets 404 (same hidden-surface treatment as /admin/pages
// per spec §3.2 / §0 role matrix).

export default async function NewPagePage() {
  // requireRole throws 403 on a role outside `createPage` — but we
  // want viewer specifically to 404. Resolve role first then branch.
  const ctx = await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const allowed = adminPolicy('createPage')
  if (!allowed.includes(ctx.role)) notFound()

  return (
    <section className="max-w-2xl">
      <header className="mb-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
          Content
        </p>
        <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black">
          New page
        </h1>
        <p className="mt-3 text-sm text-warm-stone">
          A page is a slow-moving anchor — a long-form story you&rsquo;ll
          edit once a quarter, not once a week. Start blank or clone one
          of the seeded templates to inherit its block structure.
        </p>
      </header>
      <NewPageForm role={ctx.role} />
    </section>
  )
}
