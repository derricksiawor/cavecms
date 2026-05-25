import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { consumePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import {
  honeypotTripped,
  checkLeadRecaptcha,
  HONEYPOT_FIELD,
} from '@/lib/leads/spam'
import { enqueueEmail } from '@/lib/email/queue'
import { dispatchLeadToCrms } from '@/lib/crm/dispatch'
import { neutralResponse } from '@/lib/leads/neutralResponse'
import { normalizeEmail } from '@/lib/leads/normalizeEmail'
import { logEnqueueFailure } from '@/lib/leads/logEnqueueFailure'
import { newNewsletterToken } from '@/lib/auth/newsletterToken'
import { newsletterConfirm } from '@/lib/email/templates/newsletter'

// Newsletter subscribe: double opt-in.
//   1. Upsert into newsletter_subscribers inside a TX with
//      FOR UPDATE on the email row, so a concurrent unsubscribe
//      can't rotate the token between INSERT and the follow-up
//      SELECT.
//      - New row → status='pending_confirmation', token=new
//      - Was 'unsubscribed' → flip back to pending (so the user
//        must re-confirm; auto-reactivation is the anti-pattern
//        this prevents — see schema comment).
//      - Was 'active' → keep status + KEEP the old token so the
//        previous unsubscribe link in their existing emails still
//        works.
//      - Was 'pending_confirmation' → token rotates so a stale
//        old confirmation link can't be replayed after a fresh
//        signup.
//   2. enqueue a single confirmation email. The side-effect of
//      confirming a token is keyed on the database row, not the
//      request.
//
// Per-email rate limit (1/hour) gates email-bomb attempts where a
// bot subscribes a victim multiple times from rotating IPs — the
// per-IP bucket alone can't catch this.

const Body = z
  .object({
    email: z.string().email().max(180),
    csrf: z.string().min(8).max(512),
    recaptcha: z.string().max(4000).optional(),
    [HONEYPOT_FIELD]: z.string().max(4000).optional(),
  })
  .strict()

const ipLimit = rateLimit('leads', { limit: 5, windowSec: 900 })
const emailLimit = rateLimit('newsletter_email', { limit: 1, windowSec: 3600 })

// Body-size pre-cap — see app/api/leads/contact/route.ts for rationale.
const MAX_BODY_BYTES = 64 * 1024

export const POST = withError(async (req: Request) => {
  const headerObj: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!ipLimit(ip)) return neutralResponse()

  const contentLength = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return neutralResponse()
  }

  const form = await req.formData()
  const parsed = Body.safeParse(Object.fromEntries(form.entries()))
  if (!parsed.success) return neutralResponse()
  const body = parsed.data

  if (honeypotTripped(body[HONEYPOT_FIELD])) return neutralResponse()

  const csrfState = await consumePublicPreCsrf(body.csrf)
  if (csrfState === 'expired') {
    return neutralResponse({ hint: 'session_expired' })
  }
  if (csrfState !== 'ok') return neutralResponse()

  const rc = await checkLeadRecaptcha(body.recaptcha, 'lead', ip)
  if (!rc.pass) return neutralResponse()
  if (rc.degraded) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'lead_recaptcha_degraded',
        source: 'newsletter',
        reason: rc.reason,
      }),
    )
  }

  const normEmail = normalizeEmail(body.email)
  const token = newNewsletterToken()

  // Pre-flight: refuse the subscribe entirely if no site URL is
  // configured. Without an absolute origin we can't build a
  // clickable confirm link in the email; if we INSERTed the
  // pending row anyway, the visitor would be stuck in a
  // dead-letter state forever (no link ever arrives, re-submit
  // hits the ON DUPLICATE KEY branch without progress).
  const { getSiteOrigin } = await import('@/lib/cms/getSiteOrigin')
  const earlySiteOrigin = await getSiteOrigin()
  if (!earlySiteOrigin) {
    return neutralResponse()
  }

  // Token rotation rules (see comment block above) wrapped in a
  // transaction with FOR UPDATE on the row. Without the lock,
  // a concurrent unsubscribe POST between the upsert and the
  // follow-up SELECT would rotate the token to one we never set,
  // emailing the visitor a stale link that 0-matches at confirm.
  const actualToken = await db.transaction(async (tx) => {
    // Pre-lock the row if it exists. INSERT ... ON DUPLICATE KEY
    // can't take FOR UPDATE directly; we SELECT first to acquire
    // the lock, then upsert. The SELECT either matches (row exists,
    // X-lock acquired) or returns nothing (no row → INSERT path).
    await tx.execute(sql`
      SELECT id FROM newsletter_subscribers
      WHERE email = ${normEmail}
      FOR UPDATE
    `)
    await tx.execute(sql`
      INSERT INTO newsletter_subscribers (email, unsubscribe_token, status, source)
      VALUES (${normEmail}, ${token}, 'pending_confirmation', 'public_form')
      ON DUPLICATE KEY UPDATE
        unsubscribe_token = IF(status = 'active', unsubscribe_token, VALUES(unsubscribe_token)),
        status = IF(status = 'active', 'active', 'pending_confirmation')
    `)
    const [rows] = (await tx.execute(sql`
      SELECT unsubscribe_token FROM newsletter_subscribers
      WHERE email = ${normEmail}
    `)) as unknown as [Array<{ unsubscribe_token: string }>]
    const firstRow = rows[0]
    if (rows.length !== 1 || !firstRow) {
      // Schema invariant broken (email column should be UNIQUE).
      // Fall back to the freshly-generated token so the caller
      // can still send a usable confirmation; loud log surfaces
      // the inconsistency.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'newsletter_upsert_unexpected_row_count',
          count: rows.length,
        }),
      )
      return token
    }
    return firstRow.unsubscribe_token
  })

  // Per-email bucket consumed AFTER the TX commits so a rare TX
  // deadlock (withError surfaces as 409 retryable) doesn't burn
  // a legitimate visitor's 1/hr slot. Bot pre-occupation requires
  // a successful TX which still serializes on the row lock, so
  // the security model is preserved.
  if (!emailLimit(normEmail)) return neutralResponse()

  // siteOrigin already validated at the top of the handler.
  const confirmUrl = `${earlySiteOrigin}/newsletter/confirm/${actualToken}`
  const unsubUrl = `${earlySiteOrigin}/unsubscribe?token=${actualToken}`
  await enqueueEmail(
    newsletterConfirm(normEmail, confirmUrl, unsubUrl),
  ).catch((err) =>
    logEnqueueFailure('newsletter:confirm', normEmail, err),
  )

  // CRM dispatch — fire-and-forget. Newsletter doesn't write to
  // the leads table (separate newsletter_subscribers table), so
  // leadId=0 → NULL on the dispatch log row. Uses
  // integrations_*.formSourceMap.newsletter.
  await dispatchLeadToCrms({
    leadId: 0,
    source: 'newsletter',
    cavecmsFields: { email: normEmail },
    hutk: headerObj['cookie']?.match(/(?:^|;\s*)hubspotutk=([^;]+)/)?.[1],
    pageUri: headerObj['referer'],
    ipAddress: ip,
  })

  return neutralResponse()
})
