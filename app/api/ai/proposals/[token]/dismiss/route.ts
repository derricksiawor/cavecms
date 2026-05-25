import { withError } from '@/lib/api/withError'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { dismissProposalByToken } from '@/lib/ai/applyProposal'

// POST /api/ai/proposals/[token]/dismiss
//
// Mark a pending inline AI proposal as dismissed (operator clicked
// "Dismiss" on the popover OR closed it without applying — the client
// fires this for both). No tree mutation; one audit_log row.
//
// Response shapes:
//   200 { ok: true }
//   404 { error: 'not_found' }          token unknown or wrong-user
//   410 { error: 'expired' }            already aged out
//   422 { error: 'not_pending' }        already accepted / dismissed

export const dynamic = 'force-dynamic'

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

type RouteCtx = { params: Promise<{ token: string }> }

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { token } = await params
  if (!TOKEN_RE.test(token)) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  const meta = auditMetaFromRequest(req)
  const result = await dismissProposalByToken({
    token,
    userId: ctx.userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  })
  if (result.ok) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  if (result.reason === 'expired') {
    return new Response(JSON.stringify({ error: 'expired' }), {
      status: 410,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  if (result.reason === 'not_pending') {
    return new Response(JSON.stringify({ error: 'not_pending' }), {
      status: 422,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
})
