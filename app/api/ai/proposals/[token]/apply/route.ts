import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  applyInlineProposalByToken,
  type ApplyConflict,
} from '@/lib/ai/applyProposal'

// POST /api/ai/proposals/[token]/apply
//
// Operator clicked "Apply" on the inline AI proposal popover. Validates
// the token's pending proposal, dispatches saveBlock through the same
// dual-axis optimistic-lock path the manual editor uses, returns the
// new (blockVersion, pageVersion) cursors so the client reconciler can
// update without a router.refresh.
//
// Response shapes:
//   200 { ok: true, applied: [{blockId, blockVersion}], pageVersion }
//   404 { error: 'not_found' }            token unknown or wrong-user
//   409 { error: 'stale_block_version', conflictingBlockIds: [N] }
//        OR 'stale_page_version', 'block_not_found'
//   410 { error: 'expired' }              proposal aged out
//   422 { error: 'validation_failed' }    re-validation rejected merge
//        OR 'not_pending'                  already accepted / dismissed

export const dynamic = 'force-dynamic'

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/

const Body = z
  .object({
    // For inline, callers always send 'all' — kept as the explicit
    // contract so PR 4 chat can pass acceptance subsets via index.
    accept: z.union([z.literal('all'), z.array(z.number().int().nonnegative()).max(32)]),
  })
  .strict()

type RouteCtx = { params: Promise<{ token: string }> }

interface ConflictMapping {
  status: number
  code: string
  extra?: { conflictingBlockIds?: number[] }
}

function mapConflict(c: ApplyConflict): ConflictMapping {
  switch (c.reason) {
    case 'not_found':
    case 'wrong_user':
      return { status: 404, code: 'not_found' }
    case 'expired':
      return { status: 410, code: 'expired' }
    case 'not_pending':
      return { status: 422, code: 'not_pending' }
    case 'stale_block_version':
      return {
        status: 409,
        code: 'stale_block_version',
        extra: { conflictingBlockIds: c.conflictingBlockIds ?? [] },
      }
    case 'stale_page_version':
      return { status: 409, code: 'stale_page_version' }
    case 'block_not_found':
      return {
        status: 409,
        code: 'block_not_found',
        extra: { conflictingBlockIds: c.conflictingBlockIds ?? [] },
      }
    case 'validation_failed':
      return { status: 422, code: 'validation_failed' }
  }
}

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

  const raw = await readJsonBody(req)
  // pageVersion is the editor's optimistic-lock cursor. Required so
  // saveBlock's pages-axis optimistic check has the right token; an
  // off-by-one against a concurrent peer save surfaces as 409
  // stale_page_version which the client can refresh + retry on.
  const BodyWithPv = Body.extend({
    pageVersion: z.number().int().nonnegative(),
  })
  let body: z.infer<typeof BodyWithPv>
  try {
    body = BodyWithPv.parse(raw)
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  // Inline always accepts the full changeset. PR 4 will plumb the
  // index subset through.
  if (body.accept !== 'all' && body.accept.length === 0) {
    return new Response(JSON.stringify({ error: 'empty_accept' }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  const meta = auditMetaFromRequest(req)
  const result = await applyInlineProposalByToken({
    token,
    userId: ctx.userId,
    pageVersion: body.pageVersion,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  })
  if (result.ok) {
    return new Response(
      JSON.stringify({
        ok: true,
        applied: result.applied,
        pageVersion: result.pageVersion,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    )
  }
  const mapping = mapConflict(result)
  return new Response(
    JSON.stringify({ error: mapping.code, ...(mapping.extra ?? {}) }),
    {
      status: mapping.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  )
})
