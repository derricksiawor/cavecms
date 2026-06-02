// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[redirects.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect, type Page, type Browser } from '@playwright/test'
import mysql from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { SESSION_COOKIE_NAME } from '@/lib/auth/cookie-names'
import { JWT_ISS_SESSION, JWT_AUD_SESSION } from '@/lib/auth/jwt-claims'

// Real customer-journey verification of the Redirects feature (#0.26/#0.27):
// auth is established via a seeded test admin + minted session (the sanctioned
// "credentials the product has no UI for" path — it never touches a real
// account's password), and EVERY feature action is then driven through the
// real admin UI. Redirect FIRING is observed via real HTTP requests through
// the dev-server middleware. No API/DB shortcut is used to create or drive a
// rule — only to seed auth and to ASSERT outcomes.

const ADMIN_EMAIL = 'e2e-redirects-admin@cavecms.test'

function refuseRemoteDb(dsn: string): boolean {
  const host = dsn.match(/^mysql:\/\/[^@]*@([^:/]+)/)?.[1] ?? ''
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.warn(`[redirects.spec] refusing destructive op — host=${host}`)
    return true
  }
  return false
}

async function withDb<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T | undefined> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return undefined
  const conn = await mysql.createConnection(dsn)
  try {
    return await fn(conn)
  } finally {
    await conn.end()
  }
}

async function cleanup(): Promise<void> {
  await withDb(async (c) => {
    await c.execute("DELETE FROM redirects WHERE source LIKE '/e2e-%' OR source LIKE '^/e2e%'")
    await c.execute("DELETE FROM not_found_log WHERE path LIKE '/e2e-%'")
    await c.execute(
      'DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email = ?)',
      [ADMIN_EMAIL],
    )
    await c.execute('DELETE FROM users WHERE email = ?', [ADMIN_EMAIL])
  })
}

async function seedAdmin(): Promise<number> {
  const id = await withDb(async (c) => {
    // password_hash is NOT NULL but never verified — we mint a session JWT
    // directly rather than logging in, so a dummy hash is fine. backdate
    // tokens_valid_after so the freshly-minted JWT's iat passes requireAuth.
    await c.execute(
      `INSERT INTO users (email, name, role, active, must_rotate_password, password_hash, tokens_valid_after)
       VALUES (?, ?, 'admin', 1, 0, 'x', NOW(3) - INTERVAL 5 SECOND)`,
      [ADMIN_EMAIL, 'E2E Redirects Admin'],
    )
    const [rows] = (await c.query('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL])) as unknown as [
      { id: number }[],
    ]
    return rows[0]!.id
  })
  if (id === undefined) throw new Error('could not seed admin (remote DB refused?)')
  return id
}

async function signSession(userId: number): Promise<string> {
  const secret = process.env['JWT_SECRET']
  if (!secret) throw new Error('JWT_SECRET missing in test env')
  const ttl = Number(process.env['JWT_TTL_SECONDS'] ?? 28800)
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
    .sign(new TextEncoder().encode(secret))
}

async function adminPage(browser: Browser, userId: number): Promise<Page> {
  const jwt = await signSession(userId)
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
  const csrf = await page.request.get('/api/csrf')
  expect(csrf.status()).toBe(200)
  return page
}

// Drive the "New redirect" modal end-to-end via real clicks/typing.
interface RuleForm {
  source: string
  matchType: 'Exact' | 'Wildcard' | 'Regex'
  action?: 'Redirect' | 'Gone (410)'
  target?: string
  status?: '301' | '302' | '307' | '308'
  query?: 'Pass through' | 'Ignore'
}

// Generous timeout: the local Next dev server lazily compiles routes + HMRs
// under load, so navigations/SSR can take several seconds (a dev-harness
// artifact — production `next start` serves these in ms).
const UI = { timeout: 20_000 }

async function openNewRedirect(page: Page): Promise<void> {
  await page.goto('/admin/settings/redirects', { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Redirects' })).toBeVisible(UI)
  await page.getByRole('button', { name: 'New redirect' }).click()
  await expect(page.getByRole('heading', { name: 'New redirect' })).toBeVisible(UI)
}

async function fillRule(page: Page, f: RuleForm): Promise<void> {
  // Scope to the modal dialog — the page also has a "Test a URL" input whose
  // placeholder contains "/old-pricing", so an unscoped lookup is ambiguous.
  const d = page.getByRole('dialog')
  await d.getByPlaceholder('/old-pricing').fill(f.source)
  // match-type + query buttons carry a label + example, so their accessible
  // name is two lines (e.g. "Exact /old-page") — match by the label substring.
  await d.getByRole('button', { name: f.matchType }).click()
  if (f.action) await d.getByRole('button', { name: f.action, exact: true }).click()
  if (f.target !== undefined) await d.getByPlaceholder('/pricing').fill(f.target)
  if (f.status) await d.getByRole('button', { name: f.status, exact: true }).click()
  if (f.query) await d.getByRole('button', { name: f.query }).click()
}

async function submitModal(page: Page): Promise<void> {
  await page.getByRole('dialog').getByRole('button', { name: 'Create redirect' }).click()
}

async function createRule(page: Page, f: RuleForm): Promise<void> {
  await openNewRedirect(page)
  await fillRule(page, f)
  await submitModal(page)
  // Modal closes + the source shows up in the table on router.refresh.
  await expect(page.getByRole('heading', { name: 'New redirect' })).toBeHidden(UI)
  await expect(page.locator('td', { hasText: f.source }).first()).toBeVisible(UI)
}

// Observe the live redirect behavior through the dev-server middleware.
// Polled because the Edge matcher cache has a ~3s activation TTL; tolerant of
// transient connection drops (Next dev lazily recompiles routes under load —
// a dev-harness artifact, not a product behavior).
async function probe(page: Page, from: string): Promise<{ status: number; loc: string }> {
  try {
    const r = await page.request.get(from, { maxRedirects: 0 })
    return { status: r.status(), loc: r.headers()['location'] ?? '' }
  } catch {
    return { status: 0, loc: '' }
  }
}

async function expectRedirect(
  page: Page,
  from: string,
  toContains: string,
  status = 301,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await probe(page, from)
        return r.status === status ? r.loc : `status:${r.status}`
      },
      { timeout: 20_000, intervals: [300, 600, 1000, 1500] },
    )
    .toContain(toContains)
}

test.describe.configure({ mode: 'serial' })

let adminId: number

test.beforeAll(async () => {
  await cleanup()
  adminId = await seedAdmin()
})
test.afterAll(async () => {
  await cleanup()
})

test('exact redirect fires (301) and carries the query through', async ({ browser }) => {
  test.setTimeout(75_000)
  const page = await adminPage(browser, adminId)
  await createRule(page, {
    source: '/e2e-old',
    matchType: 'Exact',
    target: '/e2e-new',
    status: '301',
  })
  await expectRedirect(page, '/e2e-old', '/e2e-new', 301)
  // query passthrough (default)
  await expectRedirect(page, '/e2e-old?utm=test', 'utm=test', 301)
})

test('wildcard redirect fires', async ({ browser }) => {
  test.setTimeout(75_000)
  const page = await adminPage(browser, adminId)
  await createRule(page, {
    source: '/e2e-blog/*',
    matchType: 'Wildcard',
    target: '/e2e-news',
    status: '301',
  })
  await expectRedirect(page, '/e2e-blog/2020/post', '/e2e-news', 301)
})

test('regex redirect substitutes a capture group', async ({ browser }) => {
  test.setTimeout(75_000)
  const page = await adminPage(browser, adminId)
  await createRule(page, {
    source: '^/e2e-p/(\\d+)$',
    matchType: 'Regex',
    target: '/e2e-product/$1',
    status: '302',
  })
  await expectRedirect(page, '/e2e-p/42', '/e2e-product/42', 302)
})

test('gone rule returns 410', async ({ browser }) => {
  test.setTimeout(75_000)
  const page = await adminPage(browser, adminId)
  await openNewRedirect(page)
  await fillRule(page, { source: '/e2e-dead', matchType: 'Exact', action: 'Gone (410)' })
  await submitModal(page)
  await expect(page.getByRole('heading', { name: 'New redirect' })).toBeHidden(UI)
  await expect
    .poll(async () => (await probe(page, '/e2e-dead')).status, {
      timeout: 20_000,
      intervals: [300, 600, 1000, 1500],
    })
    .toBe(410)
})

test('toggling a rule off stops the redirect, on resumes it', async ({ browser }) => {
  test.setTimeout(90_000)
  const page = await adminPage(browser, adminId)
  await page.goto('/admin/settings/redirects')
  // /e2e-old exists from the first test. Find its row and toggle On→Off.
  const row = page.locator('tr', { hasText: '/e2e-old' }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole('button', { name: 'On', exact: true }).click()
  // PATCH + router.refresh re-render — generous on the slow dev server.
  await expect(row.getByRole('button', { name: 'Off', exact: true })).toBeVisible({ timeout: 20_000 })
  // After the cache TTL, /e2e-old should no longer redirect.
  await expect
    .poll(async () => (await probe(page, '/e2e-old')).status, {
      timeout: 20_000,
      intervals: [400, 800, 1200],
    })
    .not.toBe(301)
  // Toggle back on → redirect resumes.
  await row.getByRole('button', { name: 'Off', exact: true }).click()
  await expect(row.getByRole('button', { name: 'On', exact: true })).toBeVisible({ timeout: 20_000 })
  await expectRedirect(page, '/e2e-old', '/e2e-new', 301)
})

test('404 log records a miss and one-click creates a working redirect', async ({ browser }) => {
  test.setTimeout(90_000)
  const page = await adminPage(browser, adminId)
  // Hit a path with no rule and no page twice → logged + aggregated.
  await page.request.get('/e2e-missing-zzz')
  await page.request.get('/e2e-missing-zzz')
  // Open the 404 Log tab (fresh SSR pulls the log). after() write may lag
  // slightly — reload until the row shows.
  await expect
    .poll(
      async () => {
        await page.goto('/admin/settings/redirects')
        await page.getByRole('button', { name: /404 Log/ }).click()
        return await page.locator('td', { hasText: '/e2e-missing-zzz' }).count()
      },
      { timeout: 10_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0)
  // One-click "Create redirect" prefills the modal with the path.
  const logRow = page.locator('tr', { hasText: '/e2e-missing-zzz' }).first()
  await logRow.getByRole('button', { name: 'Create redirect' }).click()
  const dlg = page.getByRole('dialog')
  await expect(page.getByRole('heading', { name: 'New redirect' })).toBeVisible(UI)
  await expect(dlg.getByPlaceholder('/old-pricing')).toHaveValue('/e2e-missing-zzz', UI)
  await dlg.getByPlaceholder('/pricing').fill('/e2e-found')
  await dlg.getByRole('button', { name: '301', exact: true }).click()
  await submitModal(page)
  await expect(page.getByRole('heading', { name: 'New redirect' })).toBeHidden(UI)
  await expectRedirect(page, '/e2e-missing-zzz', '/e2e-found', 301)
})

test('hit count increments after redirects fire', async ({ browser }) => {
  test.setTimeout(75_000)
  const page = await adminPage(browser, adminId)
  // Fire the exact rule a couple of times.
  await page.request.get('/e2e-old', { maxRedirects: 0 })
  await page.request.get('/e2e-old', { maxRedirects: 0 })
  // waitUntil hit-bump is async; assert via the DB (observation, allowed).
  await expect
    .poll(
      async () =>
        (await withDb(async (c) => {
          const [rows] = (await c.query(
            "SELECT hit_count FROM redirects WHERE source = '/e2e-old'",
          )) as unknown as [{ hit_count: number }[]]
          return rows[0]?.hit_count ?? 0
        })) ?? 0,
      { timeout: 10_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0)
})

test('validation: invalid regex and duplicate source are rejected in the modal', async ({
  browser,
}) => {
  test.setTimeout(75_000)
  const page = await adminPage(browser, adminId)
  // Invalid regex → inline error, modal stays open, no row added.
  await openNewRedirect(page)
  await fillRule(page, { source: '^/e2e-bad(', matchType: 'Regex', target: '/x', status: '301' })
  await submitModal(page)
  await expect(page.getByRole('dialog').getByText(/invalid regex/i)).toBeVisible(UI)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  // Duplicate (source+type already exists: /e2e-old exact) → 409 friendly error.
  await openNewRedirect(page)
  await fillRule(page, { source: '/e2e-old', matchType: 'Exact', target: '/dup', status: '301' })
  await submitModal(page)
  await expect(page.getByRole('dialog').getByText(/already exists/i)).toBeVisible(UI)
})
