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
import { pushTo } from '@/lib/sync/orchestrate'

export const runtime = 'nodejs'

// POST /api/cms/sync/push — publish THIS install's content to a remote target.
//
// Body { to?, token?, force?, dryRun? }:
//   • to     — a configured target NAME, or a raw http(s) URL (the latter needs
//              an inline `token`). Omitted → the configured default target.
//   • token  — inline token override (raw-URL form, or a just-rotated target).
//   • force  — overwrite even if the target drifted since this bundle's baseline.
//   • dryRun — validate against the target only; writes nothing.
//
// Admin + CSRF + sync:write + mutation rate. The local bundle is assembled
// in-process; only the target is reached over HTTP. The target's bearer token
// is NEVER echoed in the response.
const Body = z.object({
  to: z.string().min(1).max(300).optional(),
  token: z.string().min(1).max(512).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
})

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'sync', 'write')
  checkCmsMutationRate(ctx)

  const body = Body.parse((await readJsonBody(req)) ?? {})

  let target
  try {
    target = body.to
      ? await resolveTarget(body.to, body.token)
      : await resolveDefaultTarget()
  } catch (e) {
    if (e instanceof TargetNotFoundError) {
      throw new HttpError(400, 'target_not_found')
    }
    if (e instanceof TargetTokenUnreadableError) {
      // Re-encrypted-at-rest token can't be decrypted (key rotated / corrupt) —
      // the operator must re-add the target with a fresh token.
      throw new HttpError(409, 'target_token_unreadable')
    }
    throw e
  }

  const result = await pushTo({ target, force: body.force, dryRun: body.dryRun })

  // A drift refusal is a 409 the caller can retry with force; everything else
  // ok:false maps to a 422 (the target rejected the bundle / the cutover
  // failed). The token is not present in `result`.
  const status = result.ok ? 200 : result.drift ? 409 : 422
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}, { timeoutMs: 600_000 }) // assemble + tar + remote stage/cutover of a large site can exceed the 15s default
