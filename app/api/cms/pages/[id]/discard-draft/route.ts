import { discardPageDraft } from '@/lib/cms/draft'
import { NotFoundError } from '@/lib/cms/saveBlock'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'

// POST /api/cms/pages/[id]/discard-draft — drop the page's entire draft
// overlay (discardPageDraft): hard-delete rows added-in-draft, revert
// modified/removed rows to their published state, clear the page flag.
//
// Admin/editor + CSRF + mutation rate-limit (discarding the draft mutates
// the content_blocks rows). A missing page surfaces as 404 not_found.

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

  try {
    const result = await discardPageDraft({ pageId: id, userId: ctx.userId })
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    if (e instanceof NotFoundError) throw new HttpError(404, 'not_found')
    throw e
  }
})
