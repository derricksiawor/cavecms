import { z } from 'zod'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { NewsletterTable } from './NewsletterTable'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// Same allow-list as /api/admin/newsletter — accept only the three
// known status enum values. Unknown values from a crafted URL get
// dropped at the boundary, not echoed into the table's <select> nor
// the subsequent network call.
const FilterParams = z.object({
  status: z.enum(['active', 'unsubscribed', 'pending_confirmation']).optional(),
})

// Server page is a thin shim: gate by role (admin/editor/viewer), read
// the status filter searchParam, and hand off to the client table.
// Mirrors /admin/leads/page.tsx — the only differences are the page
// title + the absence of a trashed view (newsletter has no soft-
// delete; unsubscribe is the terminal state).
export default async function NewsletterPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const ctx = await requireRoleOrRedirect(['admin', 'editor', 'viewer'])
  const raw = await searchParams
  const parsed = FilterParams.safeParse(raw)
  const sp = parsed.success ? parsed.data : {}
  return (
    <div className="max-w-6xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        Inbox · Newsletter
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Newsletter
      </h1>
      <p className="mt-3 max-w-xl text-sm text-warm-stone">
        Subscribers from the public footer signup. Confirmed addresses
        appear as <strong className="font-semibold">Active</strong>; pending
        ones are waiting on the confirmation link.
      </p>
      <NewsletterTable
        role={ctx.role}
        initialFilters={{ status: sp.status }}
      />
    </div>
  )
}
