import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { getZohoOauthCreds, listZohoModuleFields } from '@/lib/crm/zoho'

// GET /api/admin/integrations/zoho/modules/[module]/fields
// OAuth-mode only. Returns the module's field schema for the
// edit-drawer field-map UI. Webform-mode operators map fields by
// reading the labels off their Zoho form HTML.

const ALLOWED = new Set(['Leads', 'Contacts', 'Deals'])

export const GET = withError(async (
  _req: Request,
  { params }: { params: Promise<{ module: string }> },
) => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const { module } = await params
  if (!ALLOWED.has(module)) throw new HttpError(400, 'invalid_module')

  const creds = await getZohoOauthCreds()
  if (!creds) {
    return new Response(JSON.stringify({
      ok: false, fields: [],
      message: 'OAuth credentials required to fetch field schemas (webform mode does not expose this API).',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const result = await listZohoModuleFields(creds, module)
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
