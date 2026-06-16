import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog, passwordResetTokens } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { generateResetToken, RESET_TTL_MS } from '@/lib/auth/passwordReset'
import { getSiteOrigin, getSiteName } from '@/lib/cms/getSiteOrigin'
import { enqueueEmail } from '@/lib/email/queue'
import { passwordResetEmail } from '@/lib/email/templates/passwordReset'
import { logEnqueueFailure } from '@/lib/leads/logEnqueueFailure'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'

// Admin issues a single-use password-reset link for ANOTHER user.
//
// We mint a 32-byte token, store only its SHA-256, and return the
// link PATH (e.g. "/auth/reset/<raw>"). The client builds the
// absolute URL from window.location.origin for the copy modal — so
// the feature works even before the operator has set their Site URL.
//
// If the Site URL IS configured we ALSO email the absolute link to
// the target (fire-and-forget via the queue). emailed:false signals
// the UI to lean on the copyable link.
//
// Guards mirror the sibling user-management routes; self-target is
// refused (the admin uses Settings → change-password for themselves).

const IdParam = z.coerce.number().int().positive().max(2 ** 31 - 1)

export const POST = withError(
  async (req, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await requireRole(['admin'])
    // A programmatic Bearer token must never issue a human's reset link — this
    // is a human-operator action behind the admin UI.
    if (ctx.viaApiToken) throw new HttpError(403, 'forbidden')
    await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
    checkMutationRate(ctx.userId)

    const { id } = await params
    const targetId = IdParam.parse(id)
    if (targetId === ctx.userId) {
      throw new HttpError(409, 'cannot_modify_self')
    }

    const [rows] = (await db.execute(sql`
      SELECT id, email FROM users WHERE id = ${targetId} LIMIT 1
    `)) as unknown as [Array<{ id: number; email: string }>]
    const target = rows[0]
    if (!target) throw new HttpError(404, 'not_found')

    const { raw, hash } = generateResetToken()
    const expiresAt = new Date(Date.now() + RESET_TTL_MS)
    const meta = auditMetaFromRequest(req)

    // One live link per user: drop the target's prior UNCONSUMED tokens,
    // then insert the fresh one. Consumed rows are kept (audit trail).
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM password_reset_tokens
        WHERE user_id = ${targetId} AND consumed_at IS NULL
      `)
      await tx.insert(passwordResetTokens).values({
        userId: targetId,
        tokenHash: hash,
        expiresAt,
        createdBy: ctx.userId,
      })
    })

    const path = `/auth/reset/${raw}`

    // Email the absolute link only when the operator has set a Site URL.
    // We await the ENQUEUE (a single INSERT, not the SMTP send — the queue
    // delivers in the background per #0.599), so `emailed` reflects whether
    // the email was actually queued, not merely attempted. A failed enqueue
    // (e.g. the pending_emails INSERT erroring) is logged via the same
    // forensic path every other enqueueEmail caller uses, instead of being
    // silently swallowed — the copyable link is the always-present fallback.
    let emailed = false
    const origin = await getSiteOrigin()
    if (origin) {
      const siteName = await getSiteName()
      const absoluteUrl = `${origin.replace(/\/+$/, '')}${path}`
      try {
        // enqueueEmail returns the pending_emails row id; a dev-allowlist
        // drop returns -1 (recipient intentionally not delivered in dev).
        const enqueuedId = await enqueueEmail(
          passwordResetEmail(target.email, absoluteUrl, siteName),
        )
        emailed = enqueuedId > 0
      } catch (err) {
        await logEnqueueFailure('admin:reset_link', target.email, err)
      }
    }

    // Audit row carries NO token.
    await db.insert(auditLog).values({
      userId: ctx.userId,
      action: 'update',
      resourceType: 'user',
      resourceId: String(targetId),
      diff: { action: 'send_reset_link', emailed } as unknown as object,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    })

    return new Response(JSON.stringify({ ok: true, path, emailed }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'private, no-store',
      },
    })
  },
)
