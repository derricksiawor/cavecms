import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { HttpError } from '@/lib/auth/requireRole'
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
import { signBrochureToken } from '@/lib/auth/brochureToken'
import {
  brochureSalesEmail,
  brochureDelivery,
} from '@/lib/email/templates/brochure'

// Brochure lead intake: a visitor on /projects/[slug] asked to
// download the PDF. We insert a lead, sign a single-use token,
// and email the visitor a download link. The token is gated by
// the CAS in app/api/brochure/[token]/route.ts so it works once.

const Body = z
  .object({
    name: z.string().min(1).max(180),
    email: z.string().email().max(180),
    phone: z.string().max(40).optional(),
    project_id: z.coerce.number().int().positive(),
    csrf: z.string().min(8).max(512),
    recaptcha: z.string().max(4000).optional(),
    [HONEYPOT_FIELD]: z.string().max(4000).optional(),
  })
  .strict()

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })

// Body-size pre-cap — see app/api/leads/contact/route.ts for rationale.
const MAX_BODY_BYTES = 64 * 1024

interface InsertResult {
  insertId: number
}

interface ProjectRow {
  id: number
  slug: string
  name: string
  brochure_pdf_id: number | null
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
        source: 'brochure',
        reason: rc.reason,
      }),
    )
  }

  // Project must be published + have a brochure PDF before we
  // sign anything. Neutral 200 on either gate so an attacker
  // can't enumerate which projects ship brochures.
  const [projectRows] = (await db.execute(sql`
    SELECT id, slug, name, brochure_pdf_id
    FROM projects
    WHERE id = ${body.project_id}
      AND published = TRUE
      AND deleted_at IS NULL
  `)) as unknown as [ProjectRow[]]
  const project = projectRows[0]
  if (!project || !project.brochure_pdf_id) return neutralResponse()

  const normEmail = normalizeEmail(body.email)
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255)
  const { getLeadNotificationRecipient } = await import('@/lib/email/transport')
  const salesTo = await getLeadNotificationRecipient()

  // Lead row FIRST and capture insertId. Single statement —
  // committed before email enqueues so a downstream enqueue
  // failure can't lose the lead.
  const [res] = (await db.execute(sql`
    INSERT INTO leads (source, name, email, phone, project_id, ip, user_agent)
    VALUES (
      'brochure', ${body.name}, ${normEmail},
      ${body.phone ?? null}, ${project.id}, ${ip}, ${userAgent}
    )
  `)) as unknown as [InsertResult]
  const leadId = Number(res.insertId)
  // Defensive: insertId must be a positive integer or the signed
  // token would carry lead_id=0/NaN and the download CAS would
  // never find a matching row. Failing loud lets an operator
  // notice; the visitor sees the neutral 200 either way.
  if (!Number.isInteger(leadId) || leadId <= 0) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'brochure_lead_no_id',
        project_id: project.id,
      }),
    )
    return neutralResponse()
  }
  const token = signBrochureToken({
    lead_id: leadId,
    project_id: project.id,
  })
  const { getSiteOrigin } = await import('@/lib/cms/getSiteOrigin')
  const siteOrigin = await getSiteOrigin()
  if (!siteOrigin) {
    // Without a configured site URL, the brochure link in the email
    // would be relative — unclickable from an email client. Fail
    // loud so the operator notices their Settings → General is
    // unconfigured.
    throw new HttpError(503, 'site_url_not_configured')
  }
  const url = `${siteOrigin}/api/brochure/${token}`

  // CRM dispatch — fire-and-forget. Uses
  // integrations_*.formSourceMap.brochure (no per-instance config
  // for brochure since it isn't a block widget).
  await dispatchLeadToCrms({
    leadId,
    source: 'brochure',
    cavecmsFields: {
      name: body.name,
      email: normEmail,
      phone: body.phone ?? '',
      brochure_project: project.name,
    },
    hutk: headerObj['cookie']?.match(/(?:^|;\s*)hubspotutk=([^;]+)/)?.[1],
    pageUri: headerObj['referer'],
    ipAddress: ip,
  })

  // Per-email parallel enqueue with isolated failure logging.
  // Brochure delivery is the visible artefact — losing it while
  // the sales notification fires (or vice versa) leaves an
  // operator-visible audit trail keyed on the distinct `source`.
  await Promise.allSettled([
    salesTo
      ? enqueueEmail(
          brochureSalesEmail(
            salesTo,
            body.name,
            normEmail,
            body.phone ?? null,
            project.name,
          ),
        ).catch((err) =>
          logEnqueueFailure('brochure:sales', normEmail, err),
        )
      : Promise.resolve(),
    enqueueEmail(
      brochureDelivery(body.name, normEmail, project.name, url),
    ).catch((err) =>
      logEnqueueFailure('brochure:delivery', normEmail, err),
    ),
  ])

  return neutralResponse()
})
