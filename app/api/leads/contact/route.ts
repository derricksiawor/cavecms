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
import { env } from '@/lib/env'
import { neutralResponse } from '@/lib/leads/neutralResponse'
import { normalizeEmail } from '@/lib/leads/normalizeEmail'
import { logEnqueueFailure } from '@/lib/leads/logEnqueueFailure'
import { dispatchLeadToCrms } from '@/lib/crm/dispatch'
import {
  contactSalesEmail,
  contactAutoReply,
} from '@/lib/email/templates/contact'

// Public lead intake: /contact form. Returns 200 in all cases that
// aren't a hard server error — neutral responses prevent a bot
// from probing which check fired.
//
// Pipeline:
//   1. rate-limit by IP (5 / 15 min, shared bucket across all 4
//      lead routes so a single source can't saturate the others).
//   2. parse the multipart form into a Zod-typed object.
//   3. honeypot — non-empty hidden field → silent 200.
//   4. preCsrf — `'ok' | 'expired' | 'invalid'`. 'expired' surfaces
//      a refresh hint so a slow visitor sees a sharp error; the
//      other states are silent 200.
//   5. reCAPTCHA — fail-open on missing/verify_failed (logged
//      degraded for ops visibility), fail-closed on low_score /
//      wrong_action.
//   6. INSERT lead (single statement — committed before enqueue
//      so an email-enqueue failure can't roll the lead back).
//   7. enqueueEmail × 2 in parallel via Promise.allSettled with
//      per-email failure logging.

const Body = z
  .object({
    name: z.string().min(1).max(180),
    email: z.string().email().max(180),
    phone: z.string().min(1).max(40),
    enquiry_type: z.enum(['enquiry', 'tour', 'brochure']).default('enquiry'),
    // message required for enquiry; optional for tour/brochure (validated
    // via superRefine below — hidden fields still submit empty strings).
    message: z.string().max(4000).optional(),
    tour_date: z.string().max(10).optional(),
    tour_time: z.string().max(8).optional(),
    brochure_project: z.string().max(100).optional(),
    // Optional CMS block id the form was rendered from. When present
    // we look up the block's `data.crmDestinations` and override the
    // site-wide integrations_*.formSourceMap.contact default. Absent
    // for any contact form rendered outside the block tree.
    // Strict-integer regex prevents `0x10` (Number-coercion accepts
    // hex literals) and other unexpected coercions. Empty string is
    // tolerated then dropped by the `.transform(s => s ? Number(s) : undefined)`.
    block_id: z
      .string()
      .regex(/^\d{1,10}$/, 'must_be_positive_integer')
      .transform((s) => Number(s))
      .optional(),
    csrf: z.string().min(8).max(512),
    recaptcha: z.string().max(4000).optional(),
    // Honeypot. Off-screen input the visitor never sees; bots
    // auto-fill every field. Non-empty value → silent drop.
    [HONEYPOT_FIELD]: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.enquiry_type === 'enquiry' && !d.message?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'message required for enquiries',
        path: ['message'],
      })
    }
    if (d.enquiry_type === 'tour') {
      if (!d.tour_date?.trim())
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tour_date'], message: 'required' })
      if (!d.tour_time?.trim())
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tour_time'], message: 'required' })
    }
    if (d.enquiry_type === 'brochure' && !d.brochure_project?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['brochure_project'], message: 'required' })
    }
  })

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })

// Cap inbound body size BEFORE parsing. `req.formData()` buffers the
// entire body in memory before Zod's `.max(4000)` field cap can reject
// anything; without a pre-check a 1 GB urlencoded POST with one huge
// `message` field would balloon the worker's heap. 64 KB is well above
// any legitimate lead-form payload (message=4000 + email/phone/name
// fields totals to ~5 KB). Pre-check beats post-parse rejection.
const MAX_BODY_BYTES = 64 * 1024

export const POST = withError(async (req: Request) => {
  const headerObj: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) return neutralResponse()

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
        source: 'contact',
        reason: rc.reason,
      }),
    )
  }

  // Normalize before storage so case/whitespace variants don't
  // create distinct rows that bypass per-email rate-limits (Plan
  // 08 inbox de-dupe) — see lib/leads/normalizeEmail.
  const normEmail = normalizeEmail(body.email)
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255)
  const salesTo = env.SALES_EMAIL || env.SMTP_FROM || ''

  const msgVal = body.message?.trim() || null
  const tourDateVal = body.tour_date?.trim() || null
  const tourTimeVal = body.tour_time?.trim().slice(0, 5) || null
  const brochureProjectVal = body.brochure_project?.trim() || null

  // Lead row FIRST. Single statement, no transaction — committed
  // independently of the email enqueues so a downstream enqueue
  // failure can't lose the lead.
  const [insertResult] = (await db.execute(sql`
    INSERT INTO leads
      (source, name, email, phone, message, enquiry_type, tour_date, tour_time, brochure_project, ip, user_agent)
    VALUES (
      'contact', ${body.name}, ${normEmail},
      ${body.phone}, ${msgVal},
      ${body.enquiry_type}, ${tourDateVal}, ${tourTimeVal}, ${brochureProjectVal},
      ${ip}, ${userAgent}
    )
  `)) as unknown as [{ insertId: number }]
  const leadId = insertResult?.insertId ?? 0

  // CRM dispatch — fire-and-forget after the local INSERT. Reads
  // per-instance crmDestinations from the contact_form block when
  // block_id is present, else the integrations_*.formSourceMap.contact
  // default. Failures land in crm_dispatch_log; the user's submit
  // response is never delayed.
  if (leadId > 0) {
    // Awaited briefly so pending log rows are inserted synchronously
    // (~5-10ms) before outbound HTTP fires inside queueMicrotask.
    // Closes the worker-recycle window where a SIGTERM between the
    // local INSERT and the HTTP would have lost the dispatch.
    await dispatchLeadToCrms({
      leadId,
      source: 'contact',
      bwcFields: {
        name: body.name,
        email: normEmail,
        phone: body.phone,
        message: msgVal,
        enquiry_type: body.enquiry_type,
        tour_date: tourDateVal,
        tour_time: tourTimeVal,
        brochure_project: brochureProjectVal,
      },
      blockId: body.block_id,
      // Leading-delimiter check prevents false-positive matches like
      // `my_hubspotutk=evil` poisoning the attribution.
      hutk: headerObj['cookie']?.match(/(?:^|;\s*)hubspotutk=([^;]+)/)?.[1],
      pageUri: headerObj['referer'],
      ipAddress: ip,
    })
  }

  // Per-email parallel enqueue with isolated failure logging.
  // Promise.allSettled never rejects — the route returns 200
  // regardless of email-enqueue outcomes.
  await Promise.allSettled([
    salesTo
      ? enqueueEmail(
          contactSalesEmail(
            salesTo,
            body.name,
            normEmail,
            body.phone,
            body.enquiry_type,
            msgVal,
            tourDateVal,
            tourTimeVal,
            brochureProjectVal,
          ),
        ).catch((err) =>
          logEnqueueFailure('contact:sales', normEmail, err),
        )
      : Promise.resolve(),
    enqueueEmail(contactAutoReply(body.name, normEmail)).catch((err) =>
      logEnqueueFailure('contact:auto_reply', normEmail, err),
    ),
  ])

  return neutralResponse()
})
