import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { getHubspotCreds, getHubspotFormFields } from '@/lib/crm/hubspot'

// GET /api/admin/integrations/hubspot/forms/[formId]/fields
// Returns the form's field schema so the edit-drawer can render a
// BWC-field → HubSpot-field mapping UI.

export const GET = withError(async (
  _req: Request,
  { params }: { params: Promise<{ formId: string }> },
) => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const { formId } = await params
  // GUID shape — accept HubSpot UUIDs only. Anything else is a
  // path-traversal / SSRF attempt.
  if (!/^[0-9a-f-]{8,40}$/i.test(formId)) throw new HttpError(400, 'invalid_form_id')

  const creds = await getHubspotCreds()
  if (!creds) {
    return new Response(JSON.stringify({ ok: false, fields: [], message: 'HubSpot is disabled or token not set.' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const result = await getHubspotFormFields(creds, formId)
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
