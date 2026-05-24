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
import { env } from '@/lib/env'
import { neutralResponse } from '@/lib/leads/neutralResponse'
import { normalizeEmail } from '@/lib/leads/normalizeEmail'
import { logEnqueueFailure } from '@/lib/leads/logEnqueueFailure'
import {
  inquirySalesEmail,
  inquiryAutoReply,
} from '@/lib/email/templates/inquiry'

// Project-specific inquiry intake. Mirrors /contact except it
// validates the target project and joins its name into the email
// templates so the assigned SDR can route the lead correctly.

const Body = z
  .object({
    name: z.string().min(1).max(180),
    email: z.string().email().max(180),
    phone: z.string().max(40).optional(),
    message: z.string().min(1).max(4000),
    project_id: z.coerce.number().int().positive(),
    csrf: z.string().min(8).max(512),
    recaptcha: z.string().max(4000).optional(),
    [HONEYPOT_FIELD]: z.string().max(4000).optional(),
  })
  .strict()

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })

// Body-size pre-cap — see app/api/leads/contact/route.ts for rationale.
const MAX_BODY_BYTES = 64 * 1024

interface ProjectRow {
  id: number
  name: string
}

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
        source: 'inquiry',
        reason: rc.reason,
      }),
    )
  }

  const [projectRows] = (await db.execute(sql`
    SELECT id, name FROM projects
    WHERE id = ${body.project_id}
      AND published = TRUE
      AND deleted_at IS NULL
  `)) as unknown as [ProjectRow[]]
  const project = projectRows[0]
  if (!project) return neutralResponse()

  const normEmail = normalizeEmail(body.email)
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255)
  const salesTo = env.SALES_EMAIL || env.SMTP_FROM || ''

  const [insertResult] = (await db.execute(sql`
    INSERT INTO leads (source, name, email, phone, message, project_id, ip, user_agent)
    VALUES (
      'inquiry', ${body.name}, ${normEmail}, ${body.phone ?? null},
      ${body.message}, ${project.id}, ${ip}, ${userAgent}
    )
  `)) as unknown as [{ insertId: number }]
  const leadId = insertResult?.insertId ?? 0
  if (leadId > 0) {
    await dispatchLeadToCrms({
      leadId,
      source: 'inquiry',
      bwcFields: {
        name: body.name,
        email: normEmail,
        phone: body.phone ?? '',
        message: body.message,
        // project_id is numeric, surfaced as a string for the field-map.
        project_id: String(project.id),
      },
      hutk: headerObj['cookie']?.match(/(?:^|;\s*)hubspotutk=([^;]+)/)?.[1],
      pageUri: headerObj['referer'],
      ipAddress: ip,
    })
  }

  await Promise.allSettled([
    salesTo
      ? enqueueEmail(
          inquirySalesEmail(
            salesTo,
            body.name,
            normEmail,
            body.phone ?? null,
            body.message,
            project.name,
          ),
        ).catch((err) =>
          logEnqueueFailure('inquiry:sales', normEmail, err),
        )
      : Promise.resolve(),
    enqueueEmail(
      inquiryAutoReply(body.name, normEmail, project.name),
    ).catch((err) =>
      logEnqueueFailure('inquiry:auto_reply', normEmail, err),
    ),
  ])

  return neutralResponse()
})
