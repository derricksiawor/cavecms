import { publishPageDraft } from '@/lib/cms/draft'
import { NotFoundError } from '@/lib/cms/saveBlock'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { isDuplicateKey } from '@/lib/db/errors'

// POST /api/cms/pages/[id]/publish — materialise the page's draft overlay
// into the live columns (publishPageDraft). One summary audit row, cache
// revalidation, and a published version bump happen inside the helper's TX.
//
// Admin/editor + CSRF + mutation rate-limit (a publish is a state-changing
// mutation, not a read). The draft → live materialisation can introduce a
// duplicate htmlId that the live `uniq_content_blocks_page_html_id_live`
// UNIQUE index rejects only when the draft rows land in the live columns —
// surfaced here as a 409 html_id_collision (same operator-facing contract
// as the per-block PATCH path).

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'pages', 'write')
  checkMutationRate(ctx.userId)

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1')
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255) || null
  const requestId = getRequestId(req)

  try {
    const { pageVersion, published } = await publishPageDraft({
      pageId: id,
      userId: ctx.userId,
      ip,
      userAgent,
      requestId,
    })
    return new Response(JSON.stringify({ pageVersion, published }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    if (e instanceof NotFoundError) throw new HttpError(404, 'not_found')
    // A draft may have introduced a duplicate htmlId that the live UNIQUE
    // index rejects only when the overlay is materialised into the live
    // columns — surface the documented 409 instead of a raw mysql 500.
    if (isDuplicateKey(e)) throw new HttpError(409, 'html_id_collision')
    throw e
  }
})
