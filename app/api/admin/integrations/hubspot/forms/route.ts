import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { getHubspotCreds, listHubspotForms } from '@/lib/crm/hubspot'

// GET /api/admin/integrations/hubspot/forms
// Returns the operator's HubSpot forms list. Powers the form-picker
// dropdown in the inline edit drawer's CRM tab.

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const creds = await getHubspotCreds()
  if (!creds) {
    return new Response(JSON.stringify({ ok: false, forms: [], message: 'HubSpot is disabled or token not set.' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const result = await listHubspotForms(creds)
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
