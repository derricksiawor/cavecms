import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { consumePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { honeypotTripped, checkLeadRecaptcha, HONEYPOT_FIELD } from '@/lib/leads/spam'
import { enqueueEmail } from '@/lib/email/queue'
import { neutralResponse } from '@/lib/leads/neutralResponse'
import { normalizeEmail } from '@/lib/leads/normalizeEmail'
import { logEnqueueFailure } from '@/lib/leads/logEnqueueFailure'

// Generic composable-form intake (lx_form / E21). Reuses the lead pipeline:
// rate-limit → honeypot → preCsrf → reCAPTCHA → INSERT lead (source='form')
// → notify by email. The submission is operator-defined fields; the renderer
// sends role-mapped name/email/phone (for the lead columns) plus a JSON
// `payload` of every field {label,value} which we pack into `message`.

const MAX_BODY_BYTES = 96 * 1024
const limit = rateLimit('leads', { limit: 5, windowSec: 900 })

const PayloadItem = z.object({ label: z.string().max(120), value: z.string().max(4000) })
const Body = z.object({
  csrf: z.string().min(8).max(512),
  recaptcha: z.string().max(4000).optional(),
  _name: z.string().max(180).optional(),
  _email: z.string().max(180).optional(),
  _phone: z.string().max(40).optional(),
  _formName: z.string().max(120).optional(),
  // JSON array of { label, value } — every submitted field for the message.
  _payload: z.string().max(20000),
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
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
  const raw = Object.fromEntries(form.entries())
  if (honeypotTripped(raw[HONEYPOT_FIELD] as string | undefined)) return neutralResponse()

  const parsed = Body.safeParse(raw)
  if (!parsed.success) return neutralResponse()
  const body = parsed.data

  const csrfState = await consumePublicPreCsrf(body.csrf)
  if (csrfState === 'expired') return neutralResponse({ hint: 'session_expired' })
  if (csrfState !== 'ok') return neutralResponse()

  const rc = await checkLeadRecaptcha(body.recaptcha, 'lead', ip)
  if (!rc.pass) return neutralResponse()

  let items: Array<{ label: string; value: string }> = []
  try {
    const j = JSON.parse(body._payload)
    const r = z.array(PayloadItem).max(20).safeParse(j)
    if (r.success) items = r.data
  } catch {
    return neutralResponse()
  }
  if (items.length === 0) return neutralResponse()

  const message = items.map((it) => `${it.label}: ${it.value}`).join('\n').slice(0, 4000)
  const name = (body._name || items.find((i) => /name/i.test(i.label))?.value || 'Form submission').slice(0, 180)
  const normEmail = body._email ? normalizeEmail(body._email) : ''
  // leads.phone is varchar(40) — cap to the column width to avoid a
  // truncation error / silent data loss on INSERT.
  const phone = (body._phone || '').slice(0, 40) || null
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255)
  const formName = (body._formName || 'Form').slice(0, 120)

  await db.execute(sql`
    INSERT INTO leads (source, name, email, phone, message, enquiry_type, ip, user_agent)
    VALUES ('form', ${name}, ${normEmail || null}, ${phone}, ${message}, 'enquiry', ${ip}, ${userAgent})
  `)

  // Notify the configured recipient. Best-effort — the lead is already saved.
  try {
    const { getLeadNotificationRecipient } = await import('@/lib/email/transport')
    const to = await getLeadNotificationRecipient()
    if (to) {
      const rows = items
        .map((it) => `<tr><td style="padding:6px 12px;color:#888;">${escapeHtml(it.label)}</td><td style="padding:6px 12px;">${escapeHtml(it.value)}</td></tr>`)
        .join('')
      await enqueueEmail({
        to,
        subject: `New ${formName} submission`,
        html: `<h2>New ${escapeHtml(formName)} submission</h2><table>${rows}</table>`,
        text: items.map((it) => `${it.label}: ${it.value}`).join('\n'),
      })
    }
  } catch (e) {
    await logEnqueueFailure('form', normEmail || 'unknown', e)
  }

  return Response.json({ ok: true })
})
