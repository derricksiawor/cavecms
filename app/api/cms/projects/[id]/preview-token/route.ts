import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { rateLimit } from '@/lib/auth/rateLimit'
import { signPreviewJwt } from '@/lib/auth/jwt'

// Two-axis preview-token rate limit — mirrors the pages endpoint. A
// leaked editor session is otherwise a forwardable URL factory at
// 300/min (the generic mutation rate). 10/min/project + 30/min total
// caps the blast radius to "1 forwardable link every ~3s, hardened
// against drift across multiple projects".
const limitPerProjectPerUser = rateLimit('preview-token:project-user', {
  limit: 10,
  windowSec: 60,
})
const limitPerUserTotal = rateLimit('preview-token:project-user-total', {
  limit: 30,
  windowSec: 60,
})

const ID_PATTERN = /^[1-9][0-9]{0,9}$/
function parseId(raw: string): number {
  if (!ID_PATTERN.test(raw)) throw new HttpError(400, 'invalid_id')
  return Number(raw)
}

type RouteCtx = { params: Promise<{ id: string }> }

// Mints a short-lived (15 min) preview JWT bound to (project_id,
// preview_epoch). The epoch is bumped on every unpublish + slug rename
// + soft-delete, so a forwarded preview link is revoked the moment any
// of those happen. verifyPreviewJwt rejects on mismatch.
//
// CSRF-protected even though this is technically a GET-shaped read —
// the token is a state-bearing capability and we want every issuance
// tied to a fresh CMS session.
export const POST = withError<RouteCtx>(async (req, { params }) => {
  const { id: rawId } = await params
  const id = parseId(rawId)
  const ctx = await requireRole(['admin', 'editor'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)
  if (
    !limitPerProjectPerUser(`${ctx.userId}:${id}`) ||
    !limitPerUserTotal(String(ctx.userId))
  ) {
    throw new HttpError(429, 'rate_limited')
  }

  const [rows] = (await db.execute(sql`
    SELECT id, slug, preview_epoch
    FROM projects
    WHERE id = ${id} AND deleted_at IS NULL
  `)) as unknown as [
    Array<{ id: number; slug: string; preview_epoch: number }>,
  ]
  const p = rows[0]
  if (!p) throw new HttpError(404, 'not_found')

  const token = await signPreviewJwt(String(ctx.userId), {
    type: 'project',
    id: p.id,
    epoch: p.preview_epoch,
  })

  return new Response(
    JSON.stringify({ url: `/projects/${p.slug}?preview=${token}` }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    },
  )
})
