import { z } from 'zod'
import { requireRoleOrRedirect } from '@/lib/auth/requireRoleOrRedirect'
import { ActivityClient } from './ActivityClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { robots: { index: false, follow: false } }
}

// Mirrors the API's allow-lists — keep both in sync. A crafted URL
// (?kind=<script>) lands as the empty default rather than echoing
// into the <select defaultValue> attribute. React would escape but
// defense-in-depth keeps the surface tight.
const ActivityParams = z.object({
  tab: z.enum(['audit', 'alerts']).optional(),
  kind: z
    .enum(['smtp', 'revalidate', 'recaptcha', 'rbac', 'hydrate', 'runtime', 'crm'])
    .optional(),
  resource_type: z
    .enum([
      'content_block',
      'project',
      'project_section',
      'post',
      'team_member',
      'lead',
      'user',
      'setting',
      'auth',
      // ai_proposal lets the "AI activity" chip persist across reload
      // — the activity feed's API already accepts arbitrary lowercase
      // resource_type values; we also tighten the page-level enum so
      // a crafted URL can't echo an unexpected value into the form.
      'ai_proposal',
    ])
    .optional(),
})

export default async function Activity({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; kind?: string; resource_type?: string }>
}) {
  await requireRoleOrRedirect(['admin'])
  const raw = await searchParams
  const parsed = ActivityParams.safeParse(raw)
  const sp = parsed.success ? parsed.data : {}
  // Dashboard alerts card deep-links to ?kind=smtp; if a kind is
  // present the alerts tab is the natural default. Otherwise show
  // the audit log first (it's the more useful page for day-to-day).
  const initialTab = sp.tab === 'alerts' || sp.kind ? 'alerts' : 'audit'

  return (
    <div className="max-w-6xl">
      <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
        History
      </p>
      <h1 className="mt-4 font-serif text-4xl font-bold tracking-tight text-near-black sm:text-5xl">
        Activity
      </h1>
      <p className="mt-4 max-w-2xl text-sm font-medium leading-relaxed text-warm-stone">
        See who changed what, and catch anything that quietly went wrong
        in the background — like an email that didn&rsquo;t send, or a
        page that didn&rsquo;t refresh — so you can clear it up.
      </p>
      <ActivityClient
        initialTab={initialTab}
        initialKind={sp.kind ?? ''}
        initialResourceType={sp.resource_type ?? ''}
      />
    </div>
  )
}
