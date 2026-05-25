import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog, users } from '@/db/schema'
import { withError } from '@/lib/api/withError'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { checkMutationRate } from '@/lib/auth/cmsRateLimit'
import { auditMetaFromRequest } from '@/lib/api/auditMeta'
import {
  getTransporter,
  getFromHeader,
  getActiveSmtpConfig,
  stripCrLf,
} from '@/lib/email/transport'
import { eq } from 'drizzle-orm'

// POST /api/admin/email/test — sends a one-line test message to the
// currently-logged-in admin's email address using the saved SMTP
// settings. Used by the Settings → Email "Send test email" button to
// give the operator a fast feedback loop after saving credentials.
//
// We deliberately send to the operator's OWN email (not an arbitrary
// recipient from the request body) so the test can't be abused to
// send mail to arbitrary addresses through our SMTP relay.

export const dynamic = 'force-dynamic'

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })
  checkMutationRate(ctx.userId)

  // Email is taken from the user row, not the request — same-session
  // operators can't redirect the test send to an external address.
  const [u] = await db.select().from(users).where(eq(users.id, ctx.userId))
  if (!u || !u.email) {
    throw new HttpError(404, 'no_user')
  }

  const cfg = await getActiveSmtpConfig()
  if (!cfg) {
    return new Response(
      JSON.stringify({ error: 'smtp_not_configured' }),
      {
        status: 422,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    )
  }
  const transporter = await getTransporter()
  const from = await getFromHeader()
  if (!transporter || !from) {
    throw new HttpError(500, 'smtp_resolve_failed')
  }

  const subject = stripCrLf('CaveCMS test email')
  const text = `This is a test message from CaveCMS.\n\nIf you're reading this, your email settings are working correctly.\n\nYou can now expect to receive:\n - New lead notifications\n - Password reset links\n - Update available alerts\n\nNothing else to do.`
  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; color: #1f1d1b;">
  <h1 style="font-family: Georgia, serif; font-size: 24px; margin: 0 0 16px;">CaveCMS test email</h1>
  <p style="font-size: 15px; line-height: 1.6;">If you're reading this, your email settings are working correctly.</p>
  <p style="font-size: 14px; line-height: 1.6; color: #4a4540; margin-top: 24px;">You can now expect to receive:</p>
  <ul style="font-size: 14px; line-height: 1.7; color: #4a4540;">
    <li>New lead notifications</li>
    <li>Password reset links</li>
    <li>Update available alerts</li>
  </ul>
  <p style="font-size: 13px; color: #8a7e74; border-top: 1px solid #e5dfd6; padding-top: 16px; margin-top: 32px;">Sent by CaveCMS · <code>${cfg.host}</code></p>
</body></html>`

  try {
    await transporter.sendMail({
      from,
      to: u.email,
      subject,
      text,
      html,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : String(err)
    console.error(
      JSON.stringify({ level: 'error', msg: 'email_test_send_failed', err: message }),
    )
    return new Response(
      JSON.stringify({ error: 'send_failed', detail: message }),
      {
        status: 502,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    )
  }

  const meta = auditMetaFromRequest(req)
  await db.insert(auditLog).values({
    userId: ctx.userId,
    action: 'email_test',
    resourceType: 'settings',
    resourceId: 'smtp_config',
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  })
  // Suppress unused-import lint when sql isn't referenced.
  void sql

  return new Response(
    JSON.stringify({ ok: true, to: u.email, host: cfg.host }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  )
})
