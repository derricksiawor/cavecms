import { z } from 'zod'
import { withError, getRequestId } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  acquireEditLock,
  takeoverEditLock,
  releaseEditLock,
  EDIT_LOCK_HEARTBEAT_MS,
} from '@/lib/cms/editLock'

// POST /api/cms/pages/[id]/edit-lock — the advisory edit-lock lifecycle for
// the inline editor. One endpoint, three actions:
//   acquire  — claim the lock (also the heartbeat: acquire renews when the
//              lock is already ours). { locked:false, holder } means another
//              operator is editing and the client shows the takeover prompt.
//   takeover — forcibly reassign the lock to the caller (audited). The
//              previous holder's next heartbeat sees { locked:false } and
//              their editor surfaces the "taken over" notice.
//   release  — clear the lock on exit (only when the caller still holds it).
//
// Advisory by design: block-write APIs never check the lock, so API tokens
// and agents edit headlessly and a stale lock can never brick a page.

const ID_PATTERN = /^[1-9][0-9]{0,9}$/

const Body = z.object({
  action: z.enum(['acquire', 'takeover', 'release']),
})

type RouteCtx = { params: Promise<{ id: string }> }

export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  if (!ID_PATTERN.test(rawId)) throw new HttpError(400, 'invalid_id')
  const pageId = Number(rawId)

  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'pages', 'write')
  checkMutationRate(ctx.userId)

  const { action } = Body.parse(await req.json())

  if (action === 'release') {
    await releaseEditLock(pageId, ctx.userId)
    return json({ released: true })
  }

  if (action === 'takeover') {
    const headerObj: Record<string, string | undefined> = {}
    req.headers.forEach((v, k) => {
      headerObj[k] = v
    })
    const result = await takeoverEditLock(pageId, ctx.userId, {
      ip: clientIpFromHeaders(headerObj, '127.0.0.1'),
      userAgent: (headerObj['user-agent'] ?? '').slice(0, 255) || null,
      requestId: getRequestId(req),
    })
    return json({ ...result, heartbeatMs: EDIT_LOCK_HEARTBEAT_MS })
  }

  const result = await acquireEditLock(pageId, ctx.userId)
  return json({ ...result, heartbeatMs: EDIT_LOCK_HEARTBEAT_MS })
})

function json(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
}
