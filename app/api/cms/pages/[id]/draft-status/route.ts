import { getPageDraftStatus } from '@/lib/cms/draft'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'

// GET /api/cms/pages/[id]/draft-status — report whether the page has a
// pending draft, its draft cursor, the count of changed rows, and whether
// undo/redo are available (getPageDraftStatus). Drives the admin-bar
// DraftBar: the "N unpublished" count, the Undo/Redo enabled state, and the
// advisory "draft changed elsewhere" signal.
//
// Admin/editor only. NO CSRF — this is a read GET; CSRF guards mutations.
// Read rate-limit, matching the sibling page-load GET.

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

export const GET = withError<RouteCtx>(async (_req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  requireScope(ctx, 'pages', 'read')
  checkReadRate(ctx.userId)

  const { hasDraft, draftVersion, changeCount, canUndo, canRedo } =
    await getPageDraftStatus(id)
  return new Response(
    JSON.stringify({ hasDraft, draftVersion, changeCount, canUndo, canRedo }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
