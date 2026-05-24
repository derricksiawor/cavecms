import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import { newNewsletterToken } from '@/lib/auth/newsletterToken'

const IdParam = z.coerce.number().int().positive().max(2 ** 31 - 1)

// Manual unsubscribe is the only mutation an operator can perform on
// this table — the active → unsubscribed flip mirrors what the public
// /unsubscribe page does, but skips the token-check + email-render
// path. Token still rotates per the schema invariant ("rotated on
// every status change so a forwarded confirmation can't be replayed").
//
// pending_confirmation → unsubscribed and active → unsubscribed are
// both legal admin transitions; unsubscribed is terminal here. Re-
// subscribing requires the visitor to opt in again via the public form
// (auto-reactivation is the anti-pattern the schema comment guards
// against).
const Patch = z
  .object({
    status: z.literal('unsubscribed'),
  })
  .strict()

export const PATCH = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin', 'editor'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const { id } = await params
    const subId = IdParam.parse(id)
    const body = Patch.parse(await readJsonBody(req))

    return db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT status FROM newsletter_subscribers
        WHERE id = ${subId}
        FOR UPDATE
      `)) as unknown as [Array<{ status: string }>]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const currentStatus = rows[0].status

      // No-op short-circuit: already unsubscribed → 200 without
      // writing a redundant UPDATE or audit row. Matches the leads
      // PATCH no-op contract so the client sees consistent behaviour
      // on a double-click. Defer auditMetaFromRequest() to after the
      // short-circuit so a double-click doesn't pay the header walk.
      if (currentStatus === 'unsubscribed') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
          },
        })
      }

      const meta = auditMetaFromRequest(req)
      const nextToken = newNewsletterToken()
      await tx.execute(sql`
        UPDATE newsletter_subscribers
        SET status = ${body.status},
            unsubscribe_token = ${nextToken}
        WHERE id = ${subId}
      `)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'update',
        resourceType: 'newsletter_subscriber',
        resourceId: String(subId),
        diff: {
          status: { from: currentStatus, to: body.status },
        } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'private, no-store',
        },
      })
    })
  },
)

// Hard delete. Admin only. There is NO soft-delete column on this
// table (unsubscribe is terminal for marketing flows), so the GDPR /
// "delete my data" path is a real DELETE — the row goes away, the
// email is no longer retrievable. Audit row stores only the last-
// known status (no email, no token) so the ledger can prove a
// deletion happened without retaining the PII the request was
// asking us to remove.
export const DELETE = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)
    const { id } = await params
    const subId = IdParam.parse(id)
    const meta = auditMetaFromRequest(req)

    return db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT status FROM newsletter_subscribers
        WHERE id = ${subId}
        FOR UPDATE
      `)) as unknown as [Array<{ status: string }>]
      if (!rows[0]) throw new HttpError(404, 'not_found')
      const lastStatus = rows[0].status

      await tx.execute(sql`
        DELETE FROM newsletter_subscribers WHERE id = ${subId}
      `)

      await tx.insert(auditLog).values({
        userId: ctx.userId,
        action: 'delete',
        resourceType: 'newsletter_subscriber',
        resourceId: String(subId),
        diff: { status: lastStatus } as unknown as object,
        ip: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      })

      return new Response(null, { status: 204 })
    })
  },
)
