import { undoDraft } from '@/lib/cms/draft'
import { NotFoundError } from '@/lib/cms/saveBlock'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'

// POST /api/cms/pages/[id]/undo — step the page's draft overlay back one
// revision (undoDraft). A draft undo is a state-changing mutation, so it
// carries the same admin/editor + CSRF + mutation-rate guards as the sibling
// publish/save routes.

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
  checkMutationRate(ctx.userId)

  try {
    const { ok, draftVersion } = await undoDraft(id, ctx.userId)
    return new Response(JSON.stringify({ ok, draftVersion }), {
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
