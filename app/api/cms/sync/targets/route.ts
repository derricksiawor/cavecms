import { z } from 'zod'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError, requireScope } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkReadRate, checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { readJsonBody } from '@/lib/api/jsonBody'
import {
  listTargets,
  upsertTarget,
  removeTarget,
  setDefaultTarget,
} from '@/lib/sync/syncTargets'

export const runtime = 'nodejs'

// /api/cms/sync/targets — manage the named local→remote sync targets.
//
//   GET    → list targets (redacted: never the token, only last4)
//   PUT    → upsert a target {name,url,token,accountLabel?}, OR mark one the
//            default {name, default:true}
//   DELETE → remove a target {name}
//
// Admin-only + CSRF on every mutation + sync scope (read for GET, write for the
// rest). The token NEVER appears in a response — the redacted view carries only
// a last4 stub. The encrypted token lives in the `sync_targets` setting, owned
// exclusively by this route (the generic Settings PATCH never touches it).

// json() so every response shares the no-store content-type contract.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export const GET = withError(async () => {
  const ctx = await requireRole(['admin'])
  requireScope(ctx, 'sync', 'read')
  checkReadRate(ctx.userId)
  const data = await listTargets()
  return json(200, data)
})

// Upsert OR set-default, discriminated by the body shape. An upsert carries
// url+token; a set-default carries `default: true` with just the name.
const UpsertBody = z.object({
  name: z.string().min(1).max(60),
  url: z.string().min(1).max(300),
  token: z.string().min(1).max(512),
  accountLabel: z.string().max(120).optional(),
})
const SetDefaultBody = z.object({
  name: z.string().min(1).max(60),
  default: z.literal(true),
})

export const PUT = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'sync', 'write')
  checkMutationRate(ctx.userId)

  const raw = await readJsonBody(req)

  // Set-default form first (it's the narrower shape).
  const asDefault = SetDefaultBody.safeParse(raw)
  if (asDefault.success) {
    const { ok } = await setDefaultTarget(asDefault.data.name, ctx.userId)
    if (!ok) throw new HttpError(400, 'target_not_found')
    const data = await listTargets()
    return json(200, data)
  }

  const parsed = UpsertBody.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, 'invalid_request')
  // Reject a non-http(s) URL up front with an actionable code (the settings
  // schema would otherwise reject it deeper with an opaque message).
  try {
    if (!new URL(parsed.data.url).protocol.startsWith('http')) {
      throw new HttpError(400, 'target_url_must_be_http')
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'target_url_invalid')
  }
  const saved = await upsertTarget(parsed.data, ctx.userId)
  return json(200, { target: saved })
})

const DeleteBody = z.object({ name: z.string().min(1).max(60) })

export const DELETE = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  requireScope(ctx, 'sync', 'write')
  checkMutationRate(ctx.userId)

  const parsed = DeleteBody.safeParse(await readJsonBody(req))
  if (!parsed.success) throw new HttpError(400, 'invalid_request')
  const { removed } = await removeTarget(parsed.data.name, ctx.userId)
  if (!removed) throw new HttpError(400, 'target_not_found')
  return json(200, { ok: true, removed: parsed.data.name })
})
