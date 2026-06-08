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
import { signFileDeliveryToken } from '@/lib/auth/fileDeliveryToken'
import { lxFormActionsSchema } from '@/lib/cms/block-registry'

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
  // The lx_form block instance id — lets the route load the form's after-submit
  // actions (deliver_file) server-side. Optional / back-compat.
  _blockId: z.string().max(20).optional(),
  // JSON map of fieldName → value, for CRM field-mapping keyed by the form's
  // own slug names. Optional / back-compat.
  _fields: z.string().max(20000).optional(),
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
  // Only store a syntactically-valid email. The generic form's `_email` is
  // intentionally NOT .email()-validated at the schema (so a typo doesn't
  // reject + drop the whole lead) — but a garbage value must not pollute
  // leads.email. Invalid → '' (lead still captured; just no reply-to).
  const normEmail =
    body._email && z.string().email().safeParse(body._email.trim()).success
      ? normalizeEmail(body._email)
      : ''
  // leads.phone is varchar(40) — cap to the column width to avoid a
  // truncation error / silent data loss on INSERT.
  const phone = (body._phone || '').slice(0, 40) || null
  const userAgent = (headerObj['user-agent'] ?? '').slice(0, 255)
  const formName = (body._formName || 'Form').slice(0, 120)

  const [insertRes] = (await db.execute(sql`
    INSERT INTO leads (source, name, email, phone, message, payload, enquiry_type, ip, user_agent)
    VALUES ('form', ${name}, ${normEmail || null}, ${phone}, ${message}, ${JSON.stringify(items)}, 'enquiry', ${ip}, ${userAgent})
  `)) as unknown as [{ insertId: number }]
  const leadId = Number(insertRes.insertId)

  // ── deliver_file after-submit actions ────────────────────────────────
  // Load the form block's actions SERVER-SIDE (never trust a client-supplied
  // media id), then run any deliver_file action: sign a download token and
  // either email the link (email mode) or hand it back for an on-screen
  // download (instant). manual mode delivers nothing here — the lead is saved
  // + the team notified below, exactly as before.
  // Load the lx_form block ONCE — its `data` JSON carries BOTH the deliver_file
  // actions AND the per-instance crmDestinations, so the delivery step here and
  // the CRM dispatch below share this single read.
  //
  // SECURITY NOTE: `_blockId` is client-supplied and validated only as a real
  // lx_form id — it is NOT bound to the form actually submitted. So a deliver_file
  // lead magnet is gated on "any valid lead submission" (a lead row is always
  // created first), NOT on "this specific form": a submitter could pass another
  // lx_form's id and receive that form's instant download link. This is intended
  // for the lead-magnet threat model (the operator trades the file for an email,
  // and an email/lead is still captured); the signed token unforgeably binds
  // lead_id+media_id, so no arbitrary media is reachable. To enforce a strict
  // per-form gate, bake the block id into the server-issued preCsrf token.
  let blockData: Record<string, unknown> | null = null
  const blockId = body._blockId ? Number(body._blockId) : NaN
  if (Number.isInteger(blockId) && blockId > 0 && Number.isInteger(leadId) && leadId > 0) {
    try {
      const [brows] = (await db.execute(sql`
        SELECT data FROM content_blocks
        WHERE id = ${blockId} AND block_type = 'lx_form' AND deleted_at IS NULL
      `)) as unknown as [Array<{ data: unknown }>]
      const braw = brows[0]?.data
      if (braw != null) {
        const parsed = typeof braw === 'string' ? JSON.parse(braw) : braw
        if (parsed && typeof parsed === 'object') {
          blockData = parsed as Record<string, unknown>
        }
      }
    } catch {
      // best-effort; the lead is already saved
    }
  }

  const downloads: Array<{ url: string; name: string }> = []
  let emailedFile = false
  if (blockData) {
    try {
      const actions = lxFormActionsSchema.safeParse(
        (blockData as { actions?: unknown }).actions ?? [],
      )
      const deliverActions = actions.success
        ? actions.data.filter((a) => a.kind === 'deliver_file' && a.mode !== 'manual')
        : []
      if (deliverActions.length > 0) {
        // getSiteOrigin + the SMTP probe are ONLY needed for email-mode actions —
        // gate them so an instant-only form can never lose its download to a
        // settings read throwing. SMTP is operator-configured (Settings → Email)
        // and absent on a fresh install; there an emailed link enqueues but never
        // sends, so email mode must fall back to the on-screen download.
        const hasEmail = deliverActions.some((a) => a.mode === 'email')
        const { getSiteOrigin } = await import('@/lib/cms/getSiteOrigin')
        const { getActiveSmtpConfig } = await import('@/lib/email/transport')
        const siteOrigin = hasEmail ? await getSiteOrigin() : null
        const smtpReady = hasEmail
          ? (await getActiveSmtpConfig().catch(() => null)) !== null
          : false
        for (const action of deliverActions) {
          // Per-action isolation — one malformed action can't drop the others.
          try {
            const token = signFileDeliveryToken({
              lead_id: leadId,
              media_id: action.file.media_id,
            })
            const rel = `/api/files/deliver/${token}`
            const name = action.file.alt || 'Your download'
            if (action.mode === 'email' && normEmail && siteOrigin && smtpReady) {
              const sent = await enqueueEmail({
                to: normEmail,
                subject: action.emailSubject || `Your download: ${name}`,
                html:
                  `<p>${escapeHtml(action.emailBody || 'Thanks — here is your download.')}</p>` +
                  `<p><a href="${siteOrigin}${rel}">Download ${escapeHtml(name)}</a></p>` +
                  `<p style="color:#888;font-size:12px;">This link works for 7 days.</p>`,
                text: `${action.emailBody || 'Here is your download.'}\n\n${siteOrigin}${rel}\n\nThis link works for 7 days.`,
              })
                .then(() => true)
                .catch((e) => {
                  void logEnqueueFailure('form:deliver', normEmail || 'unknown', e)
                  return false
                })
              // Only claim "check your inbox" when the email actually queued;
              // a failed enqueue degrades to the on-screen download below.
              if (sent) emailedFile = true
              else downloads.push({ url: rel, name })
            } else {
              // instant mode, OR email mode with no valid email / site URL /
              // configured SMTP → hand back an on-screen download so the file is
              // NEVER lost (the feature's invariant).
              downloads.push({ url: rel, name })
            }
          } catch (e) {
            console.error(JSON.stringify({
              level: 'error',
              msg: 'deliver_file_action_failed',
              leadId,
              blockId,
              err: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
            }))
          }
        }
      }
    } catch (e) {
      // Delivery is best-effort; the lead is already saved — but LOG so a broken
      // delivery is discoverable (it's the feature's whole point; every sibling
      // best-effort path logs too).
      console.error(JSON.stringify({
        level: 'error',
        msg: 'deliver_file_failed',
        leadId,
        blockId,
        err: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
      }))
    }
  }

  // CRM dispatch — best-effort, keyed by the form's own field names. Per-instance
  // crmDestinations on the lx_form block (resolved server-side), else the site
  // formSourceMap['form'] default. Never blocks the lead.
  try {
    const cavecmsFields: Record<string, string> = {}
    try {
      const fj = JSON.parse(body._fields || '{}') as unknown
      if (fj && typeof fj === 'object') {
        for (const [k, v] of Object.entries(fj as Record<string, unknown>)) {
          if (typeof v === 'string') cavecmsFields[k] = v
        }
      }
    } catch {
      // ignore a malformed _fields map
    }
    if (name) cavecmsFields.name ??= name
    if (normEmail) cavecmsFields.email ??= normEmail
    if (phone) cavecmsFields.phone ??= phone
    const { dispatchLeadToCrms } = await import('@/lib/crm/dispatch')
    await dispatchLeadToCrms({
      leadId,
      source: 'form',
      blockId: Number.isInteger(blockId) && blockId > 0 ? blockId : undefined,
      // Reuse the single block read above — pass the already-parsed
      // crmDestinations so dispatch doesn't re-SELECT the same row. `null` =
      // "block read, no per-instance destinations"; `undefined` = "no block read".
      blockCrmDestinations: blockData ? (blockData.crmDestinations ?? null) : undefined,
      cavecmsFields,
      hutk: headerObj['cookie']?.match(/(?:^|;\s*)hubspotutk=([^;]+)/)?.[1],
      pageUri: headerObj['referer'],
      ipAddress: ip,
    })
  } catch {
    // CRM dispatch is fire-and-forget; never block the lead.
  }

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

  return Response.json({ ok: true, downloads, emailed: emailedFile })
})
