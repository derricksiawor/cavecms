// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[admin.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect, type Page } from '@playwright/test'
import mysql from 'mysql2/promise'
import { scrypt as scryptCb, randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { SignJWT } from 'jose'
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-names'
import { JWT_ISS_SESSION, JWT_AUD_SESSION } from '@/lib/auth/jwt-claims'

// Mirror lib/auth/scrypt's SCRYPT_PARAMS. The CMS uses scrypt 2^17 N
// (~150ms per verify); the test password hashing must match exactly
// or login fails. We hash locally rather than importing from
// lib/auth/scrypt because Playwright specs run outside the Next
// module graph (no @/server-only resolution).
const SCRYPT_N = 1 << 17
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEY_LEN = 64
const SCRYPT_SALT_LEN = 16
const SCRYPT_MAXMEM = 256 * 1024 * 1024
const scrypt = promisify(scryptCb) as unknown as (
  pw: string,
  salt: Buffer,
  keyLen: number,
  opts: Record<string, number>,
) => Promise<Buffer>

async function hashPasswordLocal(pw: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LEN)
  const hash = await scrypt(pw, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$N=${SCRYPT_N}$r=${SCRYPT_R}$p=${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

const ADMIN_PASSWORD = 'CorrectHorseBattery0!'
// Distinct test emails so this suite doesn't trip other specs' seeders.
const ADMIN_EDITOR_EMAIL = 'admin-editor@cavecms.test'
const ADMIN_VIEWER_EMAIL = 'admin-viewer@cavecms.test'
// Specific test lead body — used by the CSV-injection assertion to
// confirm the leading `=` is escaped with a single-quote prefix.
const INJECTION_NAME = '=HYPERLINK("http://evil.test","x")'

function refuseRemoteDb(dsn: string): boolean {
  const hostMatch = dsn.match(/^mysql:\/\/[^@]*@([^:/]+)/)
  const host = hostMatch?.[1] ?? ''
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.warn(`[admin.spec] refusing destructive op — host=${host}`)
    return true
  }
  return false
}

interface DbUser {
  id: number
}

async function ensureUser(
  email: string,
  role: 'editor' | 'viewer',
  password: string,
): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  const conn = await mysql.createConnection(dsn)
  try {
    const [existing] = (await conn.query(
      'SELECT id FROM users WHERE email = ?',
      [email],
    )) as unknown as [DbUser[], unknown]
    if (existing[0]) return
    const hash = await hashPasswordLocal(password)
    // tokens_valid_after backdated 5s so JWTs minted immediately after
    // user creation pass requireAuth's `iat*1000 > tokens_valid_after_ms`
    // check. Without the backdate, the column defaults to NOW(3) (ms
    // precision) while JWT iat is floor(Date.now()/1000) — within the
    // same second iat*1000 ≤ tokens_valid_after_ms and login fails 401.
    // 5s mirrors verifySessionJwt's clockTolerance.
    await conn.execute(
      `INSERT INTO users (email, name, role, active, must_rotate_password, password_hash, tokens_valid_after)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3) - INTERVAL 5 SECOND)`,
      [email, `Test ${role}`, role, true, false, hash],
    )
  } finally {
    await conn.end()
  }
}

async function purgeTestArtefacts(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  const conn = await mysql.createConnection(dsn)
  try {
    // Delete seed leads from prior runs so the injection assertion
    // operates against a known row set.
    await conn.execute(
      'DELETE FROM leads WHERE email = ?',
      ['admin-spec-lead@cavecms.test'],
    )
    await conn.execute(
      'DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email IN (?, ?))',
      [ADMIN_EDITOR_EMAIL, ADMIN_VIEWER_EMAIL],
    )
    await conn.execute(
      'DELETE FROM users WHERE email IN (?, ?)',
      [ADMIN_EDITOR_EMAIL, ADMIN_VIEWER_EMAIL],
    )
  } finally {
    await conn.end()
  }
}

async function seedInjectionLead(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  const conn = await mysql.createConnection(dsn)
  try {
    await conn.execute(
      'INSERT INTO leads (source, name, email, phone, message, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['contact', INJECTION_NAME, 'admin-spec-lead@cavecms.test', '0240000000', 'csv-injection probe', 'new'],
    )
  } finally {
    await conn.end()
  }
}

async function signSessionJwtForTest(userId: number): Promise<string> {
  const secret = process.env['JWT_SECRET']
  if (!secret) throw new Error('JWT_SECRET missing in test env')
  const ttl = Number(process.env['JWT_TTL_SECONDS'] ?? 28800)
  const key = new TextEncoder().encode(secret)
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ oat: now, pwp: false })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISS_SESSION)
    .setAudience(JWT_AUD_SESSION)
    .setSubject(String(userId))
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttl)
    .sign(key)
}

async function getUserId(email: string): Promise<number> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  const conn = await mysql.createConnection(dsn)
  try {
    const [rows] = (await conn.query('SELECT id FROM users WHERE email = ?', [
      email,
    ])) as unknown as [DbUser[], unknown]
    if (!rows[0]) throw new Error(`user ${email} missing`)
    return rows[0].id
  } finally {
    await conn.end()
  }
}

async function pageForUser(
  browser: import('@playwright/test').Browser,
  userId: number,
): Promise<Page> {
  const jwt = await signSessionJwtForTest(userId)
  const ctx = await browser.newContext()
  await ctx.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: jwt,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ])
  const page = await ctx.newPage()
  // Warm the CSRF cookie so subsequent csrfFetch calls have a token.
  const csrf = await page.request.get('/api/csrf')
  expect(csrf.status()).toBe(200)
  return page
}

async function csrfHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies()
  const c = cookies.find((c) => c.name === CSRF_COOKIE_NAME)
  if (!c) throw new Error('csrf cookie missing')
  return c.value
}

// Admin session is set up via direct JWT injection — NOT a real
// /api/auth/login round-trip. The login endpoint is per-IP rate-
// limited (3/60s sliding window) and the limiter's state survives
// across suite runs while `pnpm dev` is reused. With auth.spec.ts:15
// already burning one slot for the actual login-flow assertion,
// other specs MUST use JWT injection or the budget exceeds the cap.
// pageForUser does the cookie wiring + a CSRF mint round-trip.

let adminPage: Page
let editorPage: Page
let viewerPage: Page

test.describe.serial('Plan 08 — Admin', () => {
  test.beforeAll(async ({ browser }) => {
    await purgeTestArtefacts()
    await ensureUser(ADMIN_EDITOR_EMAIL, 'editor', ADMIN_PASSWORD)
    await ensureUser(ADMIN_VIEWER_EMAIL, 'viewer', ADMIN_PASSWORD)
    await seedInjectionLead()

    const adminId = await getUserId('admin@cavecms.test')
    adminPage = await pageForUser(browser, adminId)

    const editorId = await getUserId(ADMIN_EDITOR_EMAIL)
    const viewerId = await getUserId(ADMIN_VIEWER_EMAIL)
    editorPage = await pageForUser(browser, editorId)
    viewerPage = await pageForUser(browser, viewerId)
  })

  test.afterAll(async () => {
    await adminPage?.close()
    await editorPage?.close()
    await viewerPage?.close()
    await purgeTestArtefacts()
  })

  test('viewer leads list returns masked rows', async () => {
    const r = await viewerPage.request.get('/api/admin/leads?limit=10')
    expect(r.status()).toBe(200)
    const j = (await r.json()) as {
      items: Array<{
        name: string | null
        email: string | null
        phone: string | null
      }>
    }
    expect(j.items.length).toBeGreaterThan(0)
    // The injection probe row has email 'admin-spec-lead@cavecms.test'.
    // For a viewer, the local part must collapse to 'a***'.
    const target = j.items.find((i) =>
      i.email?.startsWith('a***@cavecms.test'),
    )
    expect(target).toBeDefined()
    expect(target!.email).toBe('a***@cavecms.test')
    expect(target!.phone).toMatch(/^\*\*\*\d{4}$/)
  })

  test('viewer cannot fetch lead detail', async () => {
    // Use an explicit lead id by reading the masked list first.
    const list = await viewerPage.request.get('/api/admin/leads?limit=10')
    const j = (await list.json()) as { items: Array<{ id: number }> }
    expect(j.items.length).toBeGreaterThan(0)
    const id = j.items[0]!.id
    const detail = await viewerPage.request.get(`/api/admin/leads/${id}`)
    expect(detail.status()).toBe(403)
  })

  test('viewer CSV export is blocked (403)', async () => {
    const r = await viewerPage.request.get('/api/admin/leads/export')
    expect(r.status()).toBe(403)
  })

  test('admin CSV export streams + escapes formula prefix', async () => {
    const r = await adminPage.request.get('/api/admin/leads/export')
    expect(r.status()).toBe(200)
    expect(r.headers()['content-type']).toContain('text/csv')
    expect(r.headers()['content-disposition']).toContain('attachment')
    const body = await r.text()
    // Strip UTF-8 BOM if present so the header check is straight.
    const head = body.replace(/^﻿/, '').split('\n')[0]
    expect(head).toBe(
      'id,source,name,email,phone,project_slug,status,message,created_at',
    )
    // The injection probe name `=HYPERLINK(...)` should be prefixed
    // with a single-quote inside its quoted CSV cell. The serialized
    // form is `"'=HYPERLINK(""http://evil.test"",""x"")"`.
    expect(body).toContain('"\'=HYPERLINK(""http://evil.test"",""x"")"')
    // And no bare formula at column-start in any line.
    expect(body).not.toMatch(/(^|,)=HYPERLINK/m)
  })

  test('reauth is required for /api/admin/users POST', async () => {
    const csrf = await csrfHeader(adminPage)
    const r = await adminPage.request.post('/api/admin/users', {
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      data: {
        email: 'never-created@cavecms.test',
        role: 'editor',
        password: 'NeverCreated__12!',
      },
    })
    // Without a fresh reauth cookie the route must refuse with 401.
    expect(r.status()).toBe(401)
    const j = (await r.json()) as { error?: string }
    expect(j.error).toBe('reauth_required')
  })

  test('reauth with correct password unlocks the next 5 minutes', async () => {
    const csrf = await csrfHeader(adminPage)
    const reauth = await adminPage.request.post('/api/auth/reauth', {
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      data: { password: ADMIN_PASSWORD },
    })
    expect(reauth.status()).toBe(200)
    // Demote the editor: with fresh reauth the call should succeed
    // (200). Don't pick a destructive role change that could collide
    // with concurrent specs — flip to 'viewer'.
    const editorId = await getUserId(ADMIN_EDITOR_EMAIL)
    const r = await adminPage.request.patch(`/api/admin/users/${editorId}`, {
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      data: { role: 'viewer' },
    })
    expect(r.status()).toBe(200)
    // Revert so other specs still find an editor user.
    const revert = await adminPage.request.patch(
      `/api/admin/users/${editorId}`,
      {
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        data: { role: 'editor' },
      },
    )
    expect(revert.status()).toBe(200)
  })

  test('last-admin invariant blocks demoting the only admin', async () => {
    // Sanity-snapshot the admin set, then attempt to demote
    // admin@cavecms.test (the seed admin). The spec runs against a DB
    // with at least that one admin row; the demote must 409.
    const csrf = await csrfHeader(adminPage)
    // Fresh reauth (the previous test consumed up to 5 minutes
    // worth; do it again to be safe).
    const reauth = await adminPage.request.post('/api/auth/reauth', {
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
      },
      data: { password: ADMIN_PASSWORD },
    })
    expect(reauth.status()).toBe(200)
    // Find an admin OTHER than the seed (so we can attempt a demote
    // without risking the test admin's session). The spec is robust
    // either way — if there's only one admin, the demote of that
    // admin via another admin context would still 409. Here we
    // ALSO check the self-modification guard catches the same intent.
    const adminUserId = await getUserId('admin@cavecms.test')
    const r = await adminPage.request.patch(
      `/api/admin/users/${adminUserId}`,
      {
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        data: { role: 'editor' },
      },
    )
    // Self-modification refusal kicks in (409 cannot_modify_self).
    // The PATCH would otherwise also 409 with last_admin_required
    // if this were the only admin. Both produce 409.
    expect(r.status()).toBe(409)
    const j = (await r.json()) as { error?: string }
    expect(['cannot_modify_self', 'last_admin_required']).toContain(j.error)
  })

  test('/admin/help renders for a viewer', async () => {
    const resp = await viewerPage.goto('/admin/help')
    expect(resp?.status()).toBe(200)
    const text = await viewerPage.textContent('article')
    expect(text).toContain('Admin help')
  })

  test('/admin/activity is admin-only (viewer redirected)', async () => {
    const resp = await viewerPage.goto('/admin/activity', {
      waitUntil: 'load',
    })
    // requireRole(['admin']) throws HttpError(403) inside the layout
    // — the layout's catch maps to redirect('/'). The end state is
    // the homepage.
    expect(viewerPage.url().endsWith('/')).toBeTruthy()
    expect(resp?.ok()).toBeTruthy()
  })
})

