import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { getHubspotCreds, testHubspotConnection } from '@/lib/crm/hubspot'

// POST /api/admin/integrations/hubspot/test
// Pings the HubSpot API with the stored Private App token. CSRF +
// rate-limited because each test fires a real outbound request.

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const creds = await getHubspotCreds()
  if (!creds) {
    return new Response(JSON.stringify({ ok: false, message: 'HubSpot is disabled or token not set.' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const result = await testHubspotConnection(creds)
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
