import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { getZohoOauthCreds, testZohoConnection } from '@/lib/crm/zoho'

// POST /api/admin/integrations/zoho/test
// OAuth-mode only — webform mode has no test endpoint (operator
// verifies on first form submit).

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const creds = await getZohoOauthCreds()
  if (!creds) {
    return new Response(JSON.stringify({ ok: false, message: 'Zoho CRM is disabled, not in OAuth mode, or credentials are incomplete.' }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const result = await testZohoConnection(creds)
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
