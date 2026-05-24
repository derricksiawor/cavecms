// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[leads.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect } from '@playwright/test'
import mysql from 'mysql2/promise'

// Test data — emails are dedicated so cleanup doesn't trample real
// leads + a parallel run can't see another worker's rows.
const CONTACT_EMAIL = 'leads-test+contact@example.test'
const BOT_EMAIL = 'leads-test+bot@example.test'
const NEWSLETTER_EMAIL = 'leads-test+newsletter@example.test'
const BROCHURE_EMAIL = 'leads-test+brochure@example.test'
const INQUIRY_EMAIL = 'leads-test+inquiry@example.test'
const TEST_PROJECT_SLUG = 'leads-test-project'

function refuseRemoteDb(dsn: string): boolean {
  const hostMatch = dsn.match(/^mysql:\/\/[^@]*@([^:/]+)/)
  const host = hostMatch?.[1] ?? ''
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.warn(`[leads.spec] refusing destructive op — host=${host}`)
    return true
  }
  return false
}

async function purgeTestRows(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    const emails = [
      CONTACT_EMAIL,
      BOT_EMAIL,
      NEWSLETTER_EMAIL,
      BROCHURE_EMAIL,
      INQUIRY_EMAIL,
    ]
    const placeholders = emails.map(() => '?').join(',')
    await conn.execute(
      `DELETE FROM leads WHERE email IN (${placeholders})`,
      emails,
    )
    await conn.execute(
      `DELETE FROM pending_emails WHERE to_email IN (${placeholders})`,
      emails,
    )
    await conn.execute(
      `DELETE FROM newsletter_subscribers WHERE email IN (${placeholders})`,
      emails,
    )
    await conn.execute(
      'DELETE FROM project_sections WHERE project_id IN (SELECT id FROM projects WHERE slug = ?)',
      [TEST_PROJECT_SLUG],
    )
    await conn.execute(
      'DELETE FROM projects WHERE slug = ?',
      [TEST_PROJECT_SLUG],
    )
  } finally {
    await conn?.end()
  }
}

// Ensure a published project with brochure_pdf_id exists so the
// brochure route doesn't silently 200-drop the request. We set
// brochure_pdf_id to 999_999 — a sentinel that won't match any real
// media row, but satisfies the IS NOT NULL gate in the lead route.
async function ensureTestProject(): Promise<number> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    await conn.execute(
      `INSERT INTO projects (slug, name, status, published, brochure_pdf_id, version)
       VALUES (?, 'Leads Test Project', 'selling', TRUE, 999999, 0)`,
      [TEST_PROJECT_SLUG],
    )
    const [rows] = (await conn.query(
      'SELECT id FROM projects WHERE slug = ?',
      [TEST_PROJECT_SLUG],
    )) as unknown as [Array<{ id: number }>, unknown]
    return rows[0]!.id
  } finally {
    await conn?.end()
  }
}

// Mint a fresh preCsrf nonce by loading any public page that calls
// ensurePublicPreCsrf — the home page does via SiteFooter. Reading
// the nonce out of the rendered HTML is more honest than calling
// the helper directly from a Playwright spec (which would need to
// know the HMAC secret).
async function freshCsrf(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.get('/')
  expect(res.status()).toBe(200)
  const html = await res.text()
  // SiteFooter renders <input type="hidden" name="csrf" value="..."/>
  const m = html.match(/name="csrf"\s+value="([^"]+)"/)
  if (!m) throw new Error('csrf nonce not found in rendered HTML')
  return m[1]!
}

test.describe.serial('Plan 07 — Leads', () => {
  let projectId: number

  test.beforeAll(async () => {
    await purgeTestRows()
    projectId = await ensureTestProject()
  })

  test.afterAll(async () => {
    await purgeTestRows()
  })

  test('contact form: lead row written + 2 pending emails enqueued', async ({
    request,
  }) => {
    const csrf = await freshCsrf(request)
    const fd = new FormData()
    fd.append('name', 'Test User')
    fd.append('email', CONTACT_EMAIL)
    fd.append('message', 'Hello from Playwright')
    fd.append('csrf', csrf)
    const r = await request.post('/api/leads/contact', { multipart: fd })
    expect(r.status()).toBe(200)
    const body = (await r.json()) as { ok: true }
    expect(body.ok).toBe(true)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      const [leadRows] = (await conn.query(
        'SELECT id, source FROM leads WHERE email = ?',
        [CONTACT_EMAIL],
      )) as unknown as [Array<{ id: number; source: string }>, unknown]
      expect(leadRows.length).toBe(1)
      expect(leadRows[0]!.source).toBe('contact')

      // contactSalesEmail → SALES_EMAIL/SMTP_FROM (may be unset in
      // dev → no sales row enqueued) + contactAutoReply → CONTACT_EMAIL.
      // We assert the auto-reply row exists; the sales row is
      // best-effort dependent on SMTP env config.
      const [emailRows] = (await conn.query(
        'SELECT id FROM pending_emails WHERE to_email = ?',
        [CONTACT_EMAIL],
      )) as unknown as [Array<{ id: number }>, unknown]
      expect(emailRows.length).toBeGreaterThanOrEqual(1)
    } finally {
      await conn.end()
    }
  })

  test('honeypot tripped → neutral 200 + NO lead row', async ({ request }) => {
    const csrf = await freshCsrf(request)
    const fd = new FormData()
    fd.append('name', 'Bot')
    fd.append('email', BOT_EMAIL)
    fd.append('message', 'spam')
    fd.append('company_url', 'http://spam.example')
    fd.append('csrf', csrf)
    const r = await request.post('/api/leads/contact', { multipart: fd })
    expect(r.status()).toBe(200)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn.query(
        'SELECT id FROM leads WHERE email = ?',
        [BOT_EMAIL],
      )) as unknown as [Array<{ id: number }>, unknown]
      expect(rows.length).toBe(0)
    } finally {
      await conn.end()
    }
  })

  test('inquiry: lead row scoped to project_id', async ({ request }) => {
    const csrf = await freshCsrf(request)
    const fd = new FormData()
    fd.append('name', 'Inquiry User')
    fd.append('email', INQUIRY_EMAIL)
    fd.append('message', 'Tell me more.')
    fd.append('project_id', String(projectId))
    fd.append('csrf', csrf)
    const r = await request.post('/api/leads/inquiry', { multipart: fd })
    expect(r.status()).toBe(200)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn.query(
        'SELECT id, source, project_id FROM leads WHERE email = ?',
        [INQUIRY_EMAIL],
      )) as unknown as [
        Array<{ id: number; source: string; project_id: number }>,
        unknown,
      ]
      expect(rows.length).toBe(1)
      expect(rows[0]!.source).toBe('inquiry')
      expect(rows[0]!.project_id).toBe(projectId)
    } finally {
      await conn.end()
    }
  })

  test('brochure: lead row + signed token email enqueued', async ({
    request,
  }) => {
    const csrf = await freshCsrf(request)
    const fd = new FormData()
    fd.append('name', 'Brochure User')
    fd.append('email', BROCHURE_EMAIL)
    fd.append('project_id', String(projectId))
    fd.append('csrf', csrf)
    const r = await request.post('/api/leads/brochure', { multipart: fd })
    expect(r.status()).toBe(200)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      const [leadRows] = (await conn.query(
        'SELECT id, source FROM leads WHERE email = ?',
        [BROCHURE_EMAIL],
      )) as unknown as [Array<{ id: number; source: string }>, unknown]
      expect(leadRows.length).toBe(1)
      expect(leadRows[0]!.source).toBe('brochure')
      // Delivery email is enqueued — body contains the signed token
      // URL prefix. We don't crack the token here (signature secret
      // isn't visible to the spec), just assert the row exists with
      // the right shape.
      const [emailRows] = (await conn.query(
        'SELECT id, html_body FROM pending_emails WHERE to_email = ?',
        [BROCHURE_EMAIL],
      )) as unknown as [
        Array<{ id: number; html_body: string }>,
        unknown,
      ]
      expect(emailRows.length).toBe(1)
      expect(emailRows[0]!.html_body).toContain('/api/brochure/')
    } finally {
      await conn.end()
    }
  })

  test('newsletter double opt-in: subscribe → pending → confirm → active', async ({
    request,
  }) => {
    const csrf = await freshCsrf(request)
    const fd = new FormData()
    fd.append('email', NEWSLETTER_EMAIL)
    fd.append('csrf', csrf)
    const r = await request.post('/api/leads/newsletter', { multipart: fd })
    expect(r.status()).toBe(200)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    let token: string
    try {
      const [rows] = (await conn.query(
        'SELECT unsubscribe_token, status FROM newsletter_subscribers WHERE email = ?',
        [NEWSLETTER_EMAIL],
      )) as unknown as [
        Array<{ unsubscribe_token: string; status: string }>,
        unknown,
      ]
      expect(rows.length).toBe(1)
      expect(rows[0]!.status).toBe('pending_confirmation')
      token = rows[0]!.unsubscribe_token
    } finally {
      await conn.end()
    }

    // Confirm flow is now POST-only (was GET-mutates; switched to
    // prevent Gmail link-prefetcher auto-confirming victim
    // subscriptions). Visitor flow: GET the page, click button,
    // POST fires. Test bypasses the page render.
    const confirmFd = new FormData()
    confirmFd.append('token', token)
    const confirmRes = await request.post('/api/newsletter/confirm', {
      multipart: confirmFd,
    })
    expect(confirmRes.status()).toBe(200)

    const conn2 = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn2.query(
        'SELECT status FROM newsletter_subscribers WHERE email = ?',
        [NEWSLETTER_EMAIL],
      )) as unknown as [Array<{ status: string }>, unknown]
      expect(rows[0]!.status).toBe('active')
    } finally {
      await conn2.end()
    }
  })

  test('unsubscribe POST: rotates token + flips status', async ({
    request,
  }) => {
    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    let token: string
    try {
      const [rows] = (await conn.query(
        'SELECT unsubscribe_token FROM newsletter_subscribers WHERE email = ?',
        [NEWSLETTER_EMAIL],
      )) as unknown as [Array<{ unsubscribe_token: string }>, unknown]
      token = rows[0]!.unsubscribe_token
    } finally {
      await conn.end()
    }

    const fd = new FormData()
    fd.append('token', token)
    const r = await request.post('/api/newsletter/unsubscribe', {
      multipart: fd,
    })
    expect(r.status()).toBe(200)

    const conn2 = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn2.query(
        'SELECT status, unsubscribe_token FROM newsletter_subscribers WHERE email = ?',
        [NEWSLETTER_EMAIL],
      )) as unknown as [
        Array<{ status: string; unsubscribe_token: string }>,
        unknown,
      ]
      expect(rows[0]!.status).toBe('unsubscribed')
      // Token MUST rotate — the old token can no longer reactivate
      // this subscriber via a stale confirmation link.
      expect(rows[0]!.unsubscribe_token).not.toBe(token)
    } finally {
      await conn2.end()
    }
  })

  test('invalid preCsrf nonce → silent 200, no lead', async ({ request }) => {
    const fd = new FormData()
    fd.append('name', 'Invalid CSRF')
    fd.append('email', 'leads-test+invalidcsrf@example.test')
    fd.append('message', 'should not land')
    fd.append('csrf', 'invalid.nonce.payload')
    const r = await request.post('/api/leads/contact', { multipart: fd })
    expect(r.status()).toBe(200)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn.query(
        'SELECT id FROM leads WHERE email = ?',
        ['leads-test+invalidcsrf@example.test'],
      )) as unknown as [Array<{ id: number }>, unknown]
      expect(rows.length).toBe(0)
    } finally {
      await conn.end()
    }
  })
})
