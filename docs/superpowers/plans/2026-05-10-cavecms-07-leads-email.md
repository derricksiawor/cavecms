# CaveCMS Plan 07 — Lead Forms + Email

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** 4 lead-source POST endpoints (contact, brochure, inquiry, newsletter), `pending_emails` persist-on-enqueue queue, nodemailer transport with retries + circuit breaker, pre-auth CSRF for public forms, honeypot + reCAPTCHA, unsubscribe with double-opt-in re-subscribe.

**Architecture:** Each public form page server-renders a fresh `preNonce` into a hidden field + sets `__Host-cavecms_pre_csrf` (httpOnly). POST validates body vs cookie + consumes the single-use nonce. After Zod + spam checks, INSERTs the lead + emails in one TX; queue runner sweeps and sends.

**Prerequisites:** Plans 01–06.

---

### Task 1: Schemas

**Files:** Create `db/schema/leads.ts`; modify `db/schema/index.ts`.

- [ ] **Step 1: write**

```ts
// db/schema/leads.ts
import { mysqlTable, int, varchar, text, mediumtext, timestamp, index, uniqueIndex } from 'drizzle-orm/mysql-core'
import { projects } from './projects'
import { users } from './users'

export const leads = mysqlTable('leads', {
  id: int('id').primaryKey().autoincrement(),
  source: varchar('source', { length: 16, enum: ['contact','brochure','inquiry'] }).notNull(),
  name: varchar('name', { length: 180 }),
  email: varchar('email', { length: 180 }),
  phone: varchar('phone', { length: 40 }),
  message: text('message'),
  projectId: int('project_id').references(() => projects.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 16, enum: ['new','contacted','won','lost'] }).notNull().default('new'),
  notes: text('notes'),
  brochureTokenUsedAt: timestamp('brochure_token_used_at', { fsp: 3 }),
  ip: varchar('ip', { length: 45 }),
  userAgent: varchar('user_agent', { length: 255 }),
  statusChangedAt: timestamp('status_changed_at', { fsp: 3 }),
  statusChangedBy: int('status_changed_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({
  statusCreated: index('idx_leads_status_created').on(t.status, t.createdAt),
  source: index('idx_leads_source').on(t.source),
  created: index('idx_leads_created').on(t.createdAt),
  sourceStatusCreated: index('idx_leads_source_status_created').on(t.source, t.status, t.createdAt, t.id),
}))

export const newsletterSubscribers = mysqlTable('newsletter_subscribers', {
  id: int('id').primaryKey().autoincrement(),
  email: varchar('email', { length: 180 }).notNull(),
  status: varchar('status', { length: 24, enum: ['active','unsubscribed','pending_confirmation'] }).notNull().default('pending_confirmation'),
  unsubscribeToken: varchar('unsubscribe_token', { length: 64 }).notNull(),
  source: varchar('source', { length: 40 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({ emailUniq: uniqueIndex('idx_newsletter_email').on(t.email) }))

export const pendingEmails = mysqlTable('pending_emails', {
  id: int('id').primaryKey().autoincrement(),
  toEmail: varchar('to_email', { length: 180 }).notNull(),
  subject: varchar('subject', { length: 255 }).notNull(),
  htmlBody: mediumtext('html_body').notNull(),
  textBody: mediumtext('text_body').notNull(),
  attempts: int('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { fsp: 3 }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { fsp: 3 }),
  lastError: text('last_error'),
  claimUntil: timestamp('claim_until', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => ({ due: index('idx_pending_emails_due').on(t.resolvedAt, t.nextRetryAt) }))
```

- [ ] **Step 2:** add exports, generate migration, commit.

```bash
pnpm drizzle-kit generate && git add db && git commit -m "feat(db): leads + newsletter + pending_emails"
```

---

### Task 2: Pre-auth CSRF helper for public forms

**Files:** Create `lib/auth/preCsrfForPublic.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { cookies } from 'next/headers'
import { issuePreCsrf } from './preCsrf'
import { env } from '@/lib/env'

export async function ensurePublicPreCsrf(): Promise<string> {
  const c = await cookies()
  const existing = c.get('__Host-cavecms_pre_csrf')?.value
  if (existing) return existing
  const v = issuePreCsrf()
  c.set('__Host-cavecms_pre_csrf', v, {
    httpOnly: true, secure: env.NODE_ENV === 'production',
    sameSite: 'strict', path: '/', maxAge: 15 * 60,
  })
  return v
}

export async function consumePublicPreCsrf(formValue: string): Promise<boolean> {
  const c = await cookies()
  const cookie = c.get('__Host-cavecms_pre_csrf')?.value ?? ''
  c.delete('__Host-cavecms_pre_csrf')
  if (!formValue || !cookie || formValue.length !== cookie.length) return false
  if (formValue !== cookie) return false
  const { consumePreCsrf } = await import('./preCsrf')
  return consumePreCsrf(cookie)
}
```

- [ ] **Step 2: commit**

```bash
git add lib/auth/preCsrfForPublic.ts && git commit -m "feat(auth): public-form pre-auth CSRF helpers"
```

---

### Task 3: Spam defense + reCAPTCHA

**Files:** Create `lib/leads/spam.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { env } from '@/lib/env'

export function honeypotTripped(value: string | null | undefined): boolean {
  return !!value && value.length > 0
}

export interface RecaptchaResult { pass: boolean; degraded: boolean; score?: number }

const RECAPTCHA_URL = 'https://www.google.com/recaptcha/api/siteverify'

export async function verifyRecaptcha(token: string | null | undefined, ip: string | null): Promise<RecaptchaResult> {
  const secret = process.env.RECAPTCHA_SECRET
  if (!secret) return { pass: true, degraded: true }
  if (!token) return { pass: false, degraded: false }
  try {
    const form = new URLSearchParams({ secret, response: token, remoteip: ip ?? '' })
    const r = await fetch(RECAPTCHA_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(3000) })
    if (!r.ok) return { pass: true, degraded: true }
    const j = (await r.json()) as { success: boolean; score?: number }
    if (!j.success) return { pass: false, degraded: false }
    const threshold = Number(process.env.RECAPTCHA_THRESHOLD ?? 0.5)
    return { pass: (j.score ?? 0) >= threshold, degraded: false, score: j.score }
  } catch {
    return { pass: true, degraded: true }
  }
}
```

- [ ] **Step 2: commit**

```bash
git add lib/leads/spam.ts && git commit -m "feat(leads): honeypot + reCAPTCHA verify with degraded mode"
```

---

### Task 4: Email transport singleton

**Files:** Create `lib/email/transport.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import nodemailer, { type Transporter } from 'nodemailer'

let cached: Transporter | null = null

export function getTransporter(): Transporter {
  if (cached) return cached
  const port = Number(process.env.SMTP_PORT ?? 587)
  cached = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  })
  return cached
}

export function stripCrLf(s: string): string { return s.replace(/[\r\n]+/g, ' ') }
```

- [ ] **Step 2: commit**

```bash
git add lib/email/transport.ts && git commit -m "feat(email): nodemailer transport singleton"
```

---

### Task 5: Email queue runner with circuit breaker

**Files:** Create `lib/email/queue.ts`

- [ ] **Step 1: write**

```ts
import 'server-only'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { getTransporter, stripCrLf } from './transport'

const BACKOFFS_SEC = [30, 300, 3600]
let consecutiveFailures = 0
let breakerOpenUntil = 0

export async function enqueueEmail(p: { to: string; subject: string; html: string; text: string }): Promise<number> {
  const result = await db.execute(sql`INSERT INTO pending_emails (to_email, subject, html_body, text_body, next_retry_at) VALUES (${p.to}, ${stripCrLf(p.subject).slice(0, 254)}, ${p.html}, ${p.text}, NOW(3))`)
  const id = (result as unknown as { insertId: number }).insertId
  queueMicrotask(() => { runOnce().catch(() => {}) })
  return id
}

async function claim(): Promise<number[]> {
  await db.execute(sql`
    UPDATE pending_emails
    SET claim_until = NOW(3) + INTERVAL 60 SECOND
    WHERE id IN (
      SELECT id FROM (
        SELECT id FROM pending_emails
        WHERE resolved_at IS NULL
          AND next_retry_at <= NOW(3)
          AND (claim_until IS NULL OR claim_until < NOW(3))
          AND attempts < ${BACKOFFS_SEC.length + 1}
        ORDER BY next_retry_at LIMIT 10
      ) AS t
    )
  `)
  const rows = (await db.execute(sql`SELECT id FROM pending_emails WHERE claim_until > NOW(3) AND resolved_at IS NULL ORDER BY id LIMIT 10`)) as unknown as Array<{ id: number }>
  return rows.map((r) => r.id)
}

export async function runOnce(): Promise<void> {
  if (Date.now() < breakerOpenUntil) return
  const ids = await claim()
  for (const id of ids) {
    const rows = (await db.execute(sql`SELECT * FROM pending_emails WHERE id = ${id}`)) as unknown as Array<{ id: number; to_email: string; subject: string; html_body: string; text_body: string; attempts: number }>
    const row = rows[0]; if (!row) continue
    try {
      await getTransporter().sendMail({
        from: process.env.SMTP_FROM, to: row.to_email,
        subject: row.subject, html: row.html_body, text: row.text_body,
      })
      await db.execute(sql`UPDATE pending_emails SET resolved_at = NOW(3), claim_until = NULL WHERE id = ${id}`)
      consecutiveFailures = 0
    } catch (err) {
      const nextAttempt = row.attempts + 1
      const backoff = BACKOFFS_SEC[Math.min(nextAttempt - 1, BACKOFFS_SEC.length - 1)]
      await db.execute(sql`UPDATE pending_emails SET attempts = ${nextAttempt}, next_retry_at = NOW(3) + INTERVAL ${backoff} SECOND, last_error = ${String(err).slice(0, 1000)}, claim_until = NULL WHERE id = ${id}`)
      consecutiveFailures += 1
      if (consecutiveFailures >= 5) {
        breakerOpenUntil = Date.now() + 5 * 60 * 1000
        await db.execute(sql`INSERT INTO notification_failures (kind, payload) VALUES ('smtp_send', ${JSON.stringify({ breakerOpenedAt: Date.now() })})`).catch(() => {})
      }
    }
  }
}

if (process.env.NEXT_RUNTIME === 'nodejs') {
  setInterval(() => { runOnce().catch(() => {}) }, 30_000).unref()
  setImmediate(() => { runOnce().catch(() => {}) })
}
```

- [ ] **Step 2: commit**

```bash
git add lib/email/queue.ts && git commit -m "feat(email): persist-on-enqueue queue with retry + circuit breaker"
```

---

### Task 6: Email templates

**Files:** Create `lib/email/escape.ts`, `lib/email/templates/contact.ts`, `lib/email/templates/brochure.ts`, `lib/email/templates/inquiry.ts`, `lib/email/templates/newsletter.ts`

- [ ] **Step 1: shared escape**

```ts
// lib/email/escape.ts
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
export function wrap(body: string, footer = ''): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">${body}<hr>${footer || 'Best World Properties'}</body></html>`
}
```

- [ ] **Step 2: contact**

```ts
// lib/email/templates/contact.ts
import { escapeHtml, wrap } from '../escape'

export function contactSalesEmail(name: string, email: string, phone: string | null, message: string) {
  const html = wrap(`<h2>New contact lead</h2><p><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;${phone ? ` · ${escapeHtml(phone)}` : ''}</p><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`)
  const text = `New contact lead\n\n${name} <${email}>${phone ? ` · ${phone}` : ''}\n\n${message}`
  return { to: process.env.SALES_EMAIL ?? process.env.SMTP_FROM!, subject: `New contact: ${name}`, html, text }
}

export function contactAutoReply(toName: string, toEmail: string) {
  const html = wrap(`<p>Hi ${escapeHtml(toName)},</p><p>Thanks for reaching out to Best World Properties. We'll be in touch shortly.</p>`)
  const text = `Hi ${toName},\n\nThanks for reaching out to Best World Properties. We'll be in touch shortly.`
  return { to: toEmail, subject: 'Thanks for contacting Best World Properties', html, text }
}
```

- [ ] **Step 3: brochure**

```ts
// lib/email/templates/brochure.ts
import { escapeHtml, wrap } from '../escape'

export function brochureSalesEmail(name: string, email: string, phone: string | null, projectName: string) {
  const html = wrap(`<h2>New brochure request</h2><p>Project: <strong>${escapeHtml(projectName)}</strong></p><p>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;${phone ? ` · ${escapeHtml(phone)}` : ''}</p>`)
  const text = `New brochure request\nProject: ${projectName}\n${name} <${email}>${phone ? ` · ${phone}` : ''}`
  return { to: process.env.SALES_EMAIL ?? process.env.SMTP_FROM!, subject: `Brochure: ${projectName} — ${name}`, html, text }
}

export function brochureDelivery(toName: string, toEmail: string, projectName: string, downloadUrl: string) {
  const html = wrap(`<p>Hi ${escapeHtml(toName)},</p><p>Thanks for your interest in <strong>${escapeHtml(projectName)}</strong>. Your brochure is ready:</p><p><a href="${escapeHtml(downloadUrl)}">Download brochure</a></p><p>This link works once and expires in 7 days.</p>`)
  const text = `Hi ${toName},\n\nYour ${projectName} brochure: ${downloadUrl}\n\nThis link works once and expires in 7 days.`
  return { to: toEmail, subject: `Your ${projectName} brochure`, html, text }
}
```

- [ ] **Step 4: inquiry**

```ts
// lib/email/templates/inquiry.ts
import { escapeHtml, wrap } from '../escape'

export function inquirySalesEmail(name: string, email: string, phone: string | null, message: string, projectName: string) {
  const html = wrap(`<h2>New project inquiry — ${escapeHtml(projectName)}</h2><p>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;${phone ? ` · ${escapeHtml(phone)}` : ''}</p><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`)
  const text = `New project inquiry — ${projectName}\n${name} <${email}>${phone ? ` · ${phone}` : ''}\n\n${message}`
  return { to: process.env.SALES_EMAIL ?? process.env.SMTP_FROM!, subject: `Inquiry: ${projectName} — ${name}`, html, text }
}

export function inquiryAutoReply(toName: string, toEmail: string, projectName: string) {
  const html = wrap(`<p>Hi ${escapeHtml(toName)},</p><p>Thanks for your interest in <strong>${escapeHtml(projectName)}</strong>. A member of our sales team will reach out soon.</p>`)
  const text = `Hi ${toName},\n\nThanks for your interest in ${projectName}. A member of our sales team will reach out soon.`
  return { to: toEmail, subject: `We received your inquiry — ${projectName}`, html, text }
}
```

- [ ] **Step 5: newsletter**

```ts
// lib/email/templates/newsletter.ts
import { escapeHtml, wrap } from '../escape'

export function newsletterConfirm(toEmail: string, confirmUrl: string, unsubscribeUrl: string) {
  const html = wrap(`<p>Please confirm your subscription to Best World Properties news:</p><p><a href="${escapeHtml(confirmUrl)}">Confirm subscription</a></p>`, `<p style="font-size:11px">Didn't request this? <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a>.</p>`)
  const text = `Confirm subscription: ${confirmUrl}\n\nDidn't request this? ${unsubscribeUrl}`
  return { to: toEmail, subject: 'Confirm your subscription', html, text }
}
```

- [ ] **Step 6: commit**

```bash
git add lib/email && git commit -m "feat(email): templates with HTML escape"
```

---

### Task 7: Lead route — contact

**Files:** Create `app/api/leads/contact/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { consumePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { honeypotTripped, verifyRecaptcha } from '@/lib/leads/spam'
import { enqueueEmail } from '@/lib/email/queue'
import { contactSalesEmail, contactAutoReply } from '@/lib/email/templates/contact'

const Body = z.object({
  name: z.string().min(1).max(180),
  email: z.string().email().max(180),
  phone: z.string().max(40).optional(),
  message: z.string().min(1).max(4000),
  csrf: z.string().min(8),
  recaptcha: z.string().optional(),
  company_url: z.string().optional(),
})

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })
const NEUTRAL = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })

export const POST = withError(async (req: Request) => {
  const headers = Object.fromEntries(req.headers as unknown as Iterable<[string, string]>)
  const ip = clientIpFromHeaders(headers, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) return NEUTRAL()
  const form = await req.formData()
  const obj = Object.fromEntries(form.entries()) as Record<string, string>
  const body = Body.parse(obj)
  if (honeypotTripped(body.company_url)) return NEUTRAL()
  if (!(await consumePublicPreCsrf(body.csrf))) return NEUTRAL()
  const rc = await verifyRecaptcha(body.recaptcha, ip)
  if (!rc.pass && !rc.degraded) return NEUTRAL()
  await db.execute(sql`INSERT INTO leads (source, name, email, phone, message, ip, user_agent) VALUES ('contact', ${body.name}, ${body.email}, ${body.phone ?? null}, ${body.message}, ${ip}, ${String(headers['user-agent'] ?? '').slice(0, 255)})`)
  await enqueueEmail(contactSalesEmail(body.name, body.email, body.phone ?? null, body.message))
  await enqueueEmail(contactAutoReply(body.name, body.email))
  return NEUTRAL()
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/leads/contact && git commit -m "feat(leads): POST /api/leads/contact"
```

---

### Task 8: Lead route — brochure (signs token)

**Files:** Create `app/api/leads/brochure/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { consumePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { honeypotTripped, verifyRecaptcha } from '@/lib/leads/spam'
import { enqueueEmail } from '@/lib/email/queue'
import { brochureSalesEmail, brochureDelivery } from '@/lib/email/templates/brochure'
import { signBrochureToken } from '@/lib/auth/brochureToken'

const Body = z.object({
  name: z.string().min(1).max(180),
  email: z.string().email().max(180),
  phone: z.string().max(40).optional(),
  project_id: z.coerce.number().int().positive(),
  csrf: z.string().min(8),
  recaptcha: z.string().optional(),
  company_url: z.string().optional(),
})

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })
const NEUTRAL = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

export const POST = withError(async (req: Request) => {
  const headers = Object.fromEntries(req.headers as unknown as Iterable<[string, string]>)
  const ip = clientIpFromHeaders(headers, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) return NEUTRAL()
  const form = await req.formData()
  const body = Body.parse(Object.fromEntries(form.entries()))
  if (honeypotTripped(body.company_url)) return NEUTRAL()
  if (!(await consumePublicPreCsrf(body.csrf))) return NEUTRAL()
  const rc = await verifyRecaptcha(body.recaptcha, ip)
  if (!rc.pass && !rc.degraded) return NEUTRAL()

  // Validate project is published + has a brochure
  const projectRows = (await db.execute(sql`SELECT id, slug, name, brochure_pdf_id FROM projects WHERE id = ${body.project_id} AND published = TRUE AND deleted_at IS NULL`)) as unknown as Array<{ id: number; slug: string; name: string; brochure_pdf_id: number | null }>
  const project = projectRows[0]
  if (!project || !project.brochure_pdf_id) return NEUTRAL()

  const result = (await db.execute(sql`INSERT INTO leads (source, name, email, phone, project_id, ip, user_agent) VALUES ('brochure', ${body.name}, ${body.email}, ${body.phone ?? null}, ${project.id}, ${ip}, ${String(headers['user-agent'] ?? '').slice(0, 255)})`)) as unknown as { insertId: number }
  const token = signBrochureToken({ lead_id: result.insertId, project_id: project.id })
  const url = `https://bestworldcompany.com/api/brochure/${token}`
  await enqueueEmail(brochureSalesEmail(body.name, body.email, body.phone ?? null, project.name))
  await enqueueEmail(brochureDelivery(body.name, body.email, project.name, url))
  return NEUTRAL()
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/leads/brochure && git commit -m "feat(leads): POST /api/leads/brochure with signed download URL"
```

---

### Task 9: Lead route — inquiry

**Files:** Create `app/api/leads/inquiry/route.ts`

- [ ] **Step 1: write**

```ts
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { consumePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { honeypotTripped, verifyRecaptcha } from '@/lib/leads/spam'
import { enqueueEmail } from '@/lib/email/queue'
import { inquirySalesEmail, inquiryAutoReply } from '@/lib/email/templates/inquiry'

const Body = z.object({
  name: z.string().min(1).max(180),
  email: z.string().email().max(180),
  phone: z.string().max(40).optional(),
  message: z.string().min(1).max(4000),
  project_id: z.coerce.number().int().positive(),
  csrf: z.string().min(8),
  recaptcha: z.string().optional(),
  company_url: z.string().optional(),
})

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })
const NEUTRAL = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

export const POST = withError(async (req: Request) => {
  const headers = Object.fromEntries(req.headers as unknown as Iterable<[string, string]>)
  const ip = clientIpFromHeaders(headers, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) return NEUTRAL()
  const form = await req.formData()
  const body = Body.parse(Object.fromEntries(form.entries()))
  if (honeypotTripped(body.company_url)) return NEUTRAL()
  if (!(await consumePublicPreCsrf(body.csrf))) return NEUTRAL()
  const rc = await verifyRecaptcha(body.recaptcha, ip)
  if (!rc.pass && !rc.degraded) return NEUTRAL()

  const rows = (await db.execute(sql`SELECT id, name FROM projects WHERE id = ${body.project_id} AND published = TRUE AND deleted_at IS NULL`)) as unknown as Array<{ id: number; name: string }>
  if (!rows[0]) return NEUTRAL()
  const project = rows[0]
  await db.execute(sql`INSERT INTO leads (source, name, email, phone, message, project_id, ip, user_agent) VALUES ('inquiry', ${body.name}, ${body.email}, ${body.phone ?? null}, ${body.message}, ${project.id}, ${ip}, ${String(headers['user-agent'] ?? '').slice(0, 255)})`)
  await enqueueEmail(inquirySalesEmail(body.name, body.email, body.phone ?? null, body.message, project.name))
  await enqueueEmail(inquiryAutoReply(body.name, body.email, project.name))
  return NEUTRAL()
})
```

- [ ] **Step 2: commit**

```bash
git add app/api/leads/inquiry && git commit -m "feat(leads): POST /api/leads/inquiry"
```

---

### Task 10: Lead route — newsletter (double opt-in)

**Files:** Create `app/api/leads/newsletter/route.ts`, `app/api/newsletter/confirm/[token]/route.ts`

- [ ] **Step 1: subscribe (always sends confirmation)**

```ts
// app/api/leads/newsletter/route.ts
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { consumePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { honeypotTripped, verifyRecaptcha } from '@/lib/leads/spam'
import { enqueueEmail } from '@/lib/email/queue'
import { newsletterConfirm } from '@/lib/email/templates/newsletter'

const Body = z.object({
  email: z.string().email().max(180),
  csrf: z.string().min(8),
  recaptcha: z.string().optional(),
  company_url: z.string().optional(),
})

const limit = rateLimit('leads', { limit: 5, windowSec: 900 })
const NEUTRAL = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

function newToken(): string { return randomBytes(32).toString('base64url') }

export const POST = withError(async (req: Request) => {
  const headers = Object.fromEntries(req.headers as unknown as Iterable<[string, string]>)
  const ip = clientIpFromHeaders(headers, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) return NEUTRAL()
  const form = await req.formData()
  const body = Body.parse(Object.fromEntries(form.entries()))
  if (honeypotTripped(body.company_url)) return NEUTRAL()
  if (!(await consumePublicPreCsrf(body.csrf))) return NEUTRAL()
  const rc = await verifyRecaptcha(body.recaptcha, ip)
  if (!rc.pass && !rc.degraded) return NEUTRAL()

  const token = newToken()
  await db.execute(sql`
    INSERT INTO newsletter_subscribers (email, unsubscribe_token, status, source)
    VALUES (${body.email}, ${token}, 'pending_confirmation', 'public_form')
    ON DUPLICATE KEY UPDATE unsubscribe_token = ${token}, status = IF(status = 'unsubscribed', 'pending_confirmation', status)
  `)
  const confirmUrl = `https://bestworldcompany.com/api/newsletter/confirm/${token}`
  const unsubUrl   = `https://bestworldcompany.com/unsubscribe?token=${token}`
  await enqueueEmail(newsletterConfirm(body.email, confirmUrl, unsubUrl))
  return NEUTRAL()
})
```

- [ ] **Step 2: confirm**

```ts
// app/api/newsletter/confirm/[token]/route.ts
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'

export const GET = withError(async (_req, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const result = (await db.execute(sql`UPDATE newsletter_subscribers SET status = 'active' WHERE unsubscribe_token = ${token} AND status = 'pending_confirmation'`)) as unknown as { affectedRows: number }
  if (result.affectedRows === 0) return new Response('Already confirmed or invalid token.', { status: 200 })
  return new Response('Subscription confirmed.', { status: 200 })
})
```

- [ ] **Step 3: commit**

```bash
git add app/api/leads/newsletter app/api/newsletter && git commit -m "feat(leads): newsletter subscribe with double opt-in"
```

---

### Task 11: Unsubscribe page + POST

**Files:** Create `app/unsubscribe/page.tsx`, `app/api/newsletter/unsubscribe/route.ts`

- [ ] **Step 1: confirmation page (GET safe)**

```tsx
// app/unsubscribe/page.tsx
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function Unsubscribe({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const sp = await searchParams
  if (!sp.token) redirect('/')
  return (
    <main className="py-12 max-w-md mx-auto px-4">
      <h1 className="text-xl mb-4">Confirm unsubscribe</h1>
      <p className="mb-4 text-sm">Click the button to unsubscribe from Best World Properties newsletters.</p>
      <form method="post" action="/api/newsletter/unsubscribe">
        <input type="hidden" name="token" value={sp.token} />
        <button type="submit" className="bg-amber-700 text-white px-6 py-2 rounded">Unsubscribe</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: POST**

```ts
// app/api/newsletter/unsubscribe/route.ts
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

const limit = rateLimit('unsub', { limit: 60, windowSec: 60 })

export const POST = withError(async (req: Request) => {
  const headers = Object.fromEntries(req.headers as unknown as Iterable<[string, string]>)
  const ip = clientIpFromHeaders(headers, '127.0.0.1') ?? '0.0.0.0'
  if (!limit(ip)) return new Response('Rate limited', { status: 429 })
  const form = await req.formData()
  const token = String(form.get('token') ?? '')
  if (!token) return new Response('Bad request', { status: 400 })
  const newTok = randomBytes(32).toString('base64url')
  await db.execute(sql`UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribe_token = ${newTok} WHERE unsubscribe_token = ${token}`)
  return new Response('Unsubscribed.', { status: 200 })
})
```

- [ ] **Step 3: commit**

```bash
git add app/unsubscribe app/api/newsletter/unsubscribe && git commit -m "feat(leads): unsubscribe via POST + idempotent token rotation"
```

---

### Task 12: Public form footer (newsletter signup)

**Files:** Modify `app/layout.tsx` to include a footer with newsletter form (server-renders pre-CSRF nonce).

- [ ] **Step 1: footer component**

```tsx
// components/SiteFooter.tsx
import { ensurePublicPreCsrf } from '@/lib/auth/preCsrfForPublic'
import { getSetting } from '@/lib/cms/getSettings'

export async function SiteFooter() {
  const csrf = await ensurePublicPreCsrf()
  const contact = await getSetting('contact_info')
  const footer = await getSetting('footer')
  return (
    <footer className="bg-neutral-900 text-neutral-100 py-12 mt-16">
      <div className="max-w-6xl mx-auto px-4 grid grid-cols-1 md:grid-cols-3 gap-8">
        <div>
          <p className="font-medium">{footer.tagline || 'Best World Properties'}</p>
          <address className="not-italic text-sm mt-2">{contact.address}<br /><a href={`tel:${contact.phone.replace(/\s/g, '')}`}>{contact.phone}</a><br /><a href={`mailto:${contact.email}`}>{contact.email}</a></address>
        </div>
        <div>
          <h3 className="font-medium mb-2">Stay informed</h3>
          <form method="post" action="/api/leads/newsletter" className="flex gap-2">
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="company_url" tabIndex={-1} autoComplete="off" className="absolute -left-[9999px]" />
            <input name="email" type="email" required placeholder="Email" className="bg-neutral-800 border border-neutral-700 px-3 py-2 rounded flex-1" />
            <button className="bg-amber-700 px-4 rounded">Subscribe</button>
          </form>
        </div>
        <div>
          {footer.columns.map((c) => (
            <div key={c.label}>
              <h4 className="text-sm font-medium mb-1">{c.label}</h4>
              <ul className="text-sm">{c.links.map((l, i) => <li key={i}><a href={l.href}>{l.text}</a></li>)}</ul>
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}
```

- [ ] **Step 2: include in root layout**

```tsx
// app/layout.tsx
import { headers } from 'next/headers'
import { MediaPickerProvider } from '@/components/inline-edit/MediaPickerProvider'
import { SiteFooter } from '@/components/SiteFooter'
import './globals.css'

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-csp-nonce') ?? ''
  return (
    <html lang="en">
      <head><meta name="csp-nonce" content={nonce} /></head>
      <body>
        <MediaPickerProvider>{children}</MediaPickerProvider>
        <SiteFooter />
      </body>
    </html>
  )
}
```

- [ ] **Step 3: commit**

```bash
git add components/SiteFooter.tsx app/layout.tsx && git commit -m "feat(public): site footer with newsletter form"
```

---

### Task 13: E2E

**Files:** Create `tests/e2e/leads.spec.ts`

- [ ] **Step 1: write**

```ts
import { test, expect } from '@playwright/test'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

test('contact form: success persists row and enqueues emails', async ({ page }) => {
  await page.goto('/contact')
  await page.fill('input[name=name]', 'Test User')
  await page.fill('input[name=email]', 'test+leads@example.com')
  await page.fill('textarea[name=message]', 'Hello from Playwright')
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/leads/contact')),
    page.click('button:has-text("Send")'),
  ])
  const leads = await db.execute(sql`SELECT id FROM leads WHERE email = 'test+leads@example.com'`) as unknown as Array<{ id: number }>
  expect(leads.length).toBe(1)
  const emails = await db.execute(sql`SELECT id FROM pending_emails WHERE to_email IN ('test+leads@example.com', ${process.env.SALES_EMAIL ?? process.env.SMTP_FROM!})`) as unknown as Array<{ id: number }>
  expect(emails.length).toBeGreaterThanOrEqual(2)
})

test('honeypot tripped → neutral response, no row', async ({ page }) => {
  const csrfResp = await page.request.get('/contact')
  expect(csrfResp.status()).toBe(200)
  const cookies = (await page.context().cookies()).find((c) => c.name === '__Host-cavecms_pre_csrf')
  const csrf = cookies?.value ?? ''
  const fd = new FormData()
  fd.append('name', 'Bot')
  fd.append('email', 'bot@example.com')
  fd.append('message', 'spam')
  fd.append('company_url', 'http://spam.example')
  fd.append('csrf', csrf)
  const r = await page.request.post('/api/leads/contact', { multipart: { name: 'Bot', email: 'bot@example.com', message: 'spam', company_url: 'http://spam', csrf } })
  expect(r.status()).toBe(200)
  const found = await db.execute(sql`SELECT id FROM leads WHERE email = 'bot@example.com'`) as unknown as Array<{ id: number }>
  expect(found.length).toBe(0)
})

test('newsletter double opt-in: subscribe then confirm', async ({ page }) => {
  await page.goto('/')
  await page.fill('input[type=email]', 'sub@example.com')
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/leads/newsletter')),
    page.click('button:has-text("Subscribe")'),
  ])
  const rows = await db.execute(sql`SELECT unsubscribe_token, status FROM newsletter_subscribers WHERE email = 'sub@example.com'`) as unknown as Array<{ unsubscribe_token: string; status: string }>
  expect(rows[0].status).toBe('pending_confirmation')
  const r = await page.request.get(`/api/newsletter/confirm/${rows[0].unsubscribe_token}`)
  expect(r.status()).toBe(200)
  const after = await db.execute(sql`SELECT status FROM newsletter_subscribers WHERE email = 'sub@example.com'`) as unknown as Array<{ status: string }>
  expect(after[0].status).toBe('active')
})

test('unsubscribe POST flips status', async ({ page }) => {
  const rows = await db.execute(sql`SELECT unsubscribe_token FROM newsletter_subscribers WHERE email = 'sub@example.com'`) as unknown as Array<{ unsubscribe_token: string }>
  await page.goto(`/unsubscribe?token=${rows[0].unsubscribe_token}`)
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/newsletter/unsubscribe')),
    page.click('button:has-text("Unsubscribe")'),
  ])
  const after = await db.execute(sql`SELECT status FROM newsletter_subscribers WHERE email = 'sub@example.com'`) as unknown as Array<{ status: string }>
  expect(after[0].status).toBe('unsubscribed')
})
```

- [ ] **Step 2: commit**

```bash
git add tests/e2e/leads.spec.ts && git commit -m "test(e2e): all 4 lead sources + honeypot + unsubscribe"
```

---

### Task 14: Definition of done

- [ ] All 4 lead routes persist + enqueue email rows.
- [ ] Failed SMTP retries with exponential backoff; circuit breaker triggers after 5 consecutive failures.
- [ ] reCAPTCHA timeout fails open with `degraded` logged.
- [ ] Pre-auth CSRF is single-use per request.
- [ ] Newsletter requires email confirmation; re-subscribe never auto-reactivates an unsubscribed address.
- [ ] `git commit --allow-empty -m "chore: Plan 07 complete — Leads + Email"`.
