import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'

// GET /api/admin/integrations/zoho/modules
// Returns the static module list. Zoho's REST list-all-modules
// endpoint exists but for v1 the three core modules cover every
// lead-capture pattern. Custom modules can be added later by
// extending the registry's enum.

const MODULES = ['Leads', 'Contacts', 'Deals']

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  return new Response(JSON.stringify({ ok: true, modules: MODULES }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
