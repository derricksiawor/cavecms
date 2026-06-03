import { withError, getRequestId } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  BatchBody,
  applyPageBatch,
  batchHasDelete,
  batchHasNonDelete,
} from '@/lib/cms/services/pageBatch'

// ─────────────────────────────────────────────────────────────────────
// POST /api/cms/pages/[id]/batch — the AGENT FAST-LANE (thin shim).
//
// Why this endpoint exists, the op vocabulary, bounds, optimistic-lock
// semantics, and per-op write boundary all live in the ENGINE now —
// lib/cms/services/pageBatch.ts — so this route and the in-process MCP
// `edit_page` tool drive the IDENTICAL transaction. This handler keeps only the
// request-coupled concerns: id parse, role gate, CSRF (cookie callers; bearer
// exempt via the apitoken: jti contract), per-op scope (blocks:write for
// create/patch/reorder, blocks:delete for any delete op), and per-op rate.
//
// Reachable by bearer API tokens (path starts with /api/cms/ → tokenAllowedPath)
// AND by the session-cookie dashboard. Roles: admin + editor.
// ─────────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const pageId = parseId(rawId)

  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  const body = BatchBody.parse(await readJsonBody(req))

  // Scope the batch PER-OP against the `blocks` resource, mirroring the
  // dedicated per-block routes (PATCH = blocks:write, DELETE = blocks:delete):
  // a token granted only blocks:write cannot delete via a batch delete op, and
  // a token with no blocks grant cannot create/patch/reorder here. (A
  // null-scope or cookie-session caller is unaffected — requireScope no-ops.)
  if (batchHasNonDelete(body.ops)) requireScope(ctx, 'blocks', 'write')
  if (batchHasDelete(body.ops)) requireScope(ctx, 'blocks', 'delete')

  // Charge the mutation limiter ONE tick PER OP — parity with the per-block
  // routes, and closes the amplification gap where one 50-op batch would cost
  // the same budget as a single PATCH. The charge happens before any DB work,
  // so an over-limit batch 429s without touching the page.
  for (let i = 0; i < body.ops.length; i += 1) checkCmsMutationRate(ctx)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  const result = await applyPageBatch({
    pageId,
    userId: ctx.userId,
    tokenId: ctx.tokenId,
    ops: body.ops,
    pageVersion: body.pageVersion,
    ip,
    userAgent,
    requestId,
  })

  return new Response(
    JSON.stringify({
      pageVersion: result.pageVersion,
      tempIds: result.tempIds,
      results: result.results,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
