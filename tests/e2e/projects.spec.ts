// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[projects.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect, type Page } from '@playwright/test'
import mysql from 'mysql2/promise'
import { scrypt as scryptCb, randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { SignJWT } from 'jose'
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-names'

// Inline the password-hash format used by lib/auth/scrypt — we
// can't import that module here because it ships `import 'server-only'`
// which Playwright's runner rejects. The parameters MUST match
// lib/auth/scrypt's SCRYPT_PARAMS exactly so the verify path at
// login time recognizes the hash. Drift here = login 500 in test.
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

// Test data constants. The slugs feed the cleanup helper between
// runs; the editor user is inserted in beforeAll so the RBAC test
// has a real session to drive against (no longer skipped).
const TEST_SLUGS = ['the-test', 'the-test-renamed', 'preview-me'] as const
const EDITOR_EMAIL = 'editor@bwc.test'
const EDITOR_PASSWORD = 'CorrectHorseBattery0!'

function refuseRemoteDb(dsn: string): boolean {
  const hostMatch = dsn.match(/^mysql:\/\/[^@]*@([^:/]+)/)
  const host = hostMatch?.[1] ?? ''
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.warn(`[projects.spec] refusing destructive op — host=${host}`)
    return true
  }
  return false
}

async function purgeTestProjects(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    for (const slug of TEST_SLUGS) {
      const [rows] = (await conn.query(
        'SELECT id FROM projects WHERE slug = ?',
        [slug],
      )) as unknown as [Array<{ id: number }>, unknown]
      const id = rows[0]?.id
      if (id) {
        await conn.execute(
          'DELETE FROM project_sections WHERE project_id = ?',
          [id],
        )
        await conn.execute('DELETE FROM projects WHERE id = ?', [id])
      }
    }
    const placeholders = TEST_SLUGS.map(() => '?').join(',')
    await conn.execute(
      `DELETE FROM slug_redirects WHERE resource_type = 'project' AND (old_slug IN (${placeholders}) OR new_slug IN (${placeholders}))`,
      [...TEST_SLUGS, ...TEST_SLUGS],
    )
  } catch (err) {
    console.warn('[purgeTestProjects] cleanup failed:', err)
  } finally {
    await conn?.end()
  }
}

// Inline-create an editor user so the RBAC test has a real account
// to drive against without depending on Plan 08's admin-users UI.
// scrypt cost (~700ms) is paid once per test run.
async function ensureEditorUser(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    const [existing] = (await conn.query(
      'SELECT id FROM users WHERE email = ?',
      [EDITOR_EMAIL],
    )) as unknown as [Array<{ id: number }>, unknown]
    if (existing[0]) return
    const passwordHash = await hashPasswordLocal(EDITOR_PASSWORD)
    // tokens_valid_after backdated 5s — see admin.spec.ts ensureUser
    // for the timing rationale (JWT iat is second-truncated, tokens_valid_after
    // defaults to ms-precise NOW, race trips requireAuth's check).
    await conn.execute(
      `INSERT INTO users (email, name, role, active, must_rotate_password, password_hash, tokens_valid_after)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3) - INTERVAL 5 SECOND)`,
      [EDITOR_EMAIL, 'Test Editor', 'editor', true, false, passwordHash],
    )
  } finally {
    await conn?.end()
  }
}

async function purgeEditorAuditRows(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    // Best-effort cleanup of the audit rows the RBAC test produced.
    // Keyed on the editor's user_id so admin audit history is
    // untouched.
    const [rows] = (await conn.query(
      'SELECT id FROM users WHERE email = ?',
      [EDITOR_EMAIL],
    )) as unknown as [Array<{ id: number }>, unknown]
    const id = rows[0]?.id
    if (id) {
      await conn.execute('DELETE FROM audit_log WHERE user_id = ?', [id])
      await conn.execute('DELETE FROM users WHERE id = ?', [id])
    }
  } finally {
    await conn?.end()
  }
}

async function contextForUser(
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
  const csrf = await page.request.get('/api/csrf')
  expect(csrf.status()).toBe(200)
  return page
}

// Mint a session JWT directly so the editor session can be set up
// WITHOUT hitting the login endpoint. The per-IP login rate-limit
// (3/60s) is shared across the entire E2E suite — auth.spec already
// burns one slot for "login → dashboard flow", inline-edit burns
// another, projects.spec burns one for admin → that's 3. Adding a
// fourth login for the editor would 429.
//
// The cookie shape matches what /api/auth/login sets:
//   - SESSION_COOKIE (name from cookie-names.ts) → signed JWT
//   - CSRF_COOKIE → minted by GET /api/csrf once the session is
//     valid (so the editor's CSRF token is bound to the editor's
//     jti, not the admin's)
const JWT_ISS_SESSION = 'bwc.cms'
const JWT_AUD_SESSION = 'bwc.web'

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

async function csrfHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies()
  const c = cookies.find((c) => c.name === CSRF_COOKIE_NAME)
  if (!c) throw new Error('csrf cookie missing')
  return c.value
}

// Two browser contexts so admin + editor sessions don't overwrite
// each other's cookies. BOTH use direct-JWT injection — auth.spec.ts
// is the only place that exercises /api/auth/login (the limiter's
// per-IP budget is 3/60s and persists across suite runs while the
// dev server is reused, so other specs must not burn slots).
let adminPage: Page
let editorPage: Page

test.describe.serial('Plan 04 — Projects', () => {
  test.beforeAll(async ({ browser }) => {
    await purgeTestProjects()
    await purgeEditorAuditRows()
    await ensureEditorUser()

    const dsn = process.env['DATABASE_URL'] ?? ''
    let adminId: number
    let editorId: number
    {
      const conn = await mysql.createConnection(dsn)
      try {
        const [adminRows] = (await conn.query(
          'SELECT id FROM users WHERE email = ?',
          ['admin@bwc.test'],
        )) as unknown as [Array<{ id: number }>, unknown]
        if (!adminRows[0]) throw new Error('admin@bwc.test missing — run db:seed')
        adminId = adminRows[0].id
        const [editorRows] = (await conn.query(
          'SELECT id FROM users WHERE email = ?',
          [EDITOR_EMAIL],
        )) as unknown as [Array<{ id: number }>, unknown]
        if (!editorRows[0]) throw new Error('editor user missing after ensureEditorUser()')
        editorId = editorRows[0].id
      } finally {
        await conn.end()
      }
    }

    adminPage = await contextForUser(browser, adminId)
    editorPage = await contextForUser(browser, editorId)
  })
  test.afterAll(async () => {
    await adminPage?.close()
    await editorPage?.close()
    await purgeTestProjects()
    await purgeEditorAuditRows()
  })

  test('create project seeds 10 section rows', async () => {
    const csrf = await csrfHeader(adminPage)
    const r = await adminPage.request.post('/api/cms/projects', {
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      data: { name: 'The Test', slug: 'the-test', status: 'coming_soon' },
    })
    expect(r.status()).toBe(201)
    const j = (await r.json()) as { id: number; slug: string }
    expect(j.slug).toBe('the-test')

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn.query(
        'SELECT section_key FROM project_sections WHERE project_id = ? ORDER BY position',
        [j.id],
      )) as unknown as [Array<{ section_key: string }>, unknown]
      expect(rows.length).toBe(10)
      expect(rows.map((r) => r.section_key)).toEqual([
        'hero',
        'gallery',
        'floor_plans',
        'pricing',
        'amenities',
        'location',
        'brochure',
        'timeline',
        'testimonials',
        'inquiry',
      ])
    } finally {
      await conn.end()
    }
  })

  test('editor cannot toggle published / slug / status (RBAC 403 + audit row)', async () => {
    // Use the editor's session to attempt admin-only field updates.
    // The PATCH handler rejects with 403 + writes an audit_log row
    // with kind='rbac_field_reject' before the EditorSchema.parse
    // would otherwise throw ZodError. We assert both the response
    // and the side-effect.
    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    let projectId: number, version: number, editorId: number
    try {
      const [pRows] = (await conn.query(
        "SELECT id, version FROM projects WHERE slug = 'the-test'",
      )) as unknown as [Array<{ id: number; version: number }>, unknown]
      const p = pRows[0]
      if (!p) throw new Error('the-test project missing (test 1 prerequisite)')
      projectId = p.id
      version = p.version
      const [uRows] = (await conn.query(
        'SELECT id FROM users WHERE email = ?',
        [EDITOR_EMAIL],
      )) as unknown as [Array<{ id: number }>, unknown]
      const u = uRows[0]
      if (!u) throw new Error('editor user missing')
      editorId = u.id
    } finally {
      await conn.end()
    }

    const editorCsrf = await csrfHeader(editorPage)

    // Each forbidden field should produce the same 403 +
    // rbac_field_reject audit pattern. Test the three admin-only
    // surfaces.
    for (const forbidden of [
      { published: true },
      { slug: 'editor-tried-rename' },
      { status: 'selling' as const },
    ]) {
      const resp = await editorPage.request.patch(
        `/api/cms/projects/${projectId}`,
        {
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': editorCsrf,
          },
          data: { ...forbidden, version },
        },
      )
      expect(resp.status()).toBe(403)
    }

    // Verify the audit trail. Three forbidden attempts → three rows
    // by the editor with action='rbac_field_reject' on resource
    // 'project' / id projectId.
    const conn2 = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn2.query(
        `SELECT diff FROM audit_log
         WHERE user_id = ? AND action = 'rbac_field_reject'
           AND resource_type = 'project' AND resource_id = ?
         ORDER BY id DESC LIMIT 10`,
        [editorId, String(projectId)],
      )) as unknown as [Array<{ diff: string | object }>, unknown]
      expect(rows.length).toBeGreaterThanOrEqual(3)
      // Every row's diff should record the offending key. We don't
      // pin the order — Zod-strict parse may surface them in any
      // sequence — but the union across rows must cover all three.
      const keysAcross = new Set<string>()
      for (const r of rows.slice(0, 3)) {
        const diff =
          typeof r.diff === 'string'
            ? (JSON.parse(r.diff) as { kind: string; keys: string[] })
            : (r.diff as { kind: string; keys: string[] })
        expect(diff.kind).toBe('rbac_field_reject')
        for (const k of diff.keys) keysAcross.add(k)
      }
      expect(keysAcross).toEqual(new Set(['published', 'slug', 'status']))
    } finally {
      await conn2.end()
    }

    // Finally: the project row is UNCHANGED. version still N,
    // status still its original value. RBAC reject must NOT mutate
    // any field even partially.
    const conn3 = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn3.query(
        'SELECT version, published, status, slug FROM projects WHERE id = ?',
        [projectId],
      )) as unknown as [
        Array<{
          version: number
          published: number
          status: string
          slug: string
        }>,
        unknown,
      ]
      expect(rows[0]!.version).toBe(version)
      expect(rows[0]!.published).toBe(0)
      expect(rows[0]!.status).toBe('coming_soon')
      expect(rows[0]!.slug).toBe('the-test')
    } finally {
      await conn3.end()
    }
  })

  test('preview token reaches unpublished page and is revoked by epoch bump', async () => {
    const csrf = await csrfHeader(adminPage)

    const createResp = await adminPage.request.post('/api/cms/projects', {
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      data: { name: 'Preview Me', slug: 'preview-me', status: 'coming_soon' },
    })
    expect(createResp.status()).toBe(201)
    const created = (await createResp.json()) as { id: number }

    const tokenResp = await adminPage.request.post(
      `/api/cms/projects/${created.id}/preview-token`,
      { headers: { 'x-csrf-token': csrf } },
    )
    expect(tokenResp.status()).toBe(200)
    const tokenBody = (await tokenResp.json()) as { url: string }

    const r1 = await adminPage.goto(tokenBody.url)
    expect(r1?.status()).toBe(200)
    await expect(adminPage.locator('h1.sr-only')).toContainText('Preview Me')

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    try {
      await conn.execute(
        'UPDATE projects SET preview_epoch = preview_epoch + 1 WHERE id = ?',
        [created.id],
      )
    } finally {
      await conn.end()
    }

    const r2 = await adminPage.goto(tokenBody.url)
    expect(r2?.status()).toBe(404)
  })

  test('slug rename emits 308 permanent redirect at the public route', async () => {
    const csrf = await csrfHeader(adminPage)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    let projectId: number, version: number
    try {
      const [rows] = (await conn.query(
        "SELECT id, version FROM projects WHERE slug = 'the-test'",
      )) as unknown as [Array<{ id: number; version: number }>, unknown]
      const r = rows[0]
      if (!r) throw new Error('the-test project missing')
      projectId = r.id
      version = r.version
    } finally {
      await conn.end()
    }

    const publishResp = await adminPage.request.patch(
      `/api/cms/projects/${projectId}`,
      {
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        data: { published: true, version },
      },
    )
    expect(publishResp.status()).toBe(200)

    const renameResp = await adminPage.request.patch(
      `/api/cms/projects/${projectId}`,
      {
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        data: { slug: 'the-test-renamed', version: version + 1 },
      },
    )
    expect(renameResp.status()).toBe(200)

    const r = await adminPage.request.get('/projects/the-test', {
      maxRedirects: 0,
    })
    expect(r.status()).toBe(308)
    expect(r.headers()['location']).toContain('/projects/the-test-renamed')
  })
})
