import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkCmsMutationRate } from '@/lib/auth/cmsRateLimit'
import { readJsonBody } from '@/lib/api/jsonBody'
import {
  resolveTarget,
  resolveDefaultTarget,
  TargetNotFoundError,
  TargetTokenUnreadableError,
} from '@/lib/sync/syncTargets'
import { pullFrom } from '@/lib/sync/orchestrate'

export const runtime = 'nodejs'

// POST /api/cms/sync/pull — pull a remote source's content INTO this install.
//
// Body { from?, token? }:
//   • from  — a configured target NAME, or a raw http(s) URL (the latter needs
//             an inline `token`). Omitted → the configured default target.
//   • token — inline token override (raw-URL form, or a just-rotated target).
//
// Admin + CSRF + sync:write + mutation rate. The source is read over HTTP; the
// apply is fully in-process (the shared stage path + cutover, under the op-lock).
// The source's bearer token is NEVER echoed in the response.
const Body = z.object({
  from: z.string().min(1).max(300).optional(),
  token: z.string().min(1).max(512).optional(),
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'sync', 'write')
  checkCmsMutationRate(ctx)

  const body = Body.parse((await readJsonBody(req)) ?? {})

  let source
  try {
    source = body.from
      ? await resolveTarget(body.from, body.token)
      : await resolveDefaultTarget()
  } catch (e) {
    if (e instanceof TargetNotFoundError) {
      throw new HttpError(400, 'target_not_found')
    }
    if (e instanceof TargetTokenUnreadableError) {
      throw new HttpError(409, 'target_token_unreadable')
    }
    throw e
  }

  const result = await pullFrom({ source, userId: ctx.userId })

  // A drift refusal (this install changed mid-pull) is a 409; everything else
  // ok:false maps to 422. The token is not present in `result`.
  const status = result.ok ? 200 : result.drift ? 409 : 422
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}, { timeoutMs: 600_000 }) // remote export + media download + in-process apply/cutover can exceed the 15s default
