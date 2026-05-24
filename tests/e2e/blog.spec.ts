// DEV-ONLY: refuse to run in production (project standards rule #0.55).
if (process.env['NODE_ENV'] === 'production') {
  console.error('[blog.spec] refusing to run with NODE_ENV=production.')
  process.exit(1)
}

import { test, expect, type Page } from '@playwright/test'
import mysql from 'mysql2/promise'
import { scrypt as scryptCb, randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { SignJWT } from 'jose'
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from '@/lib/auth/cookie-names'

// Mirror lib/auth/scrypt's SCRYPT_PARAMS — see projects.spec.ts for
// why we can't import that module from a Playwright spec.
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

// Use a dedicated editor email for the blog suite so it doesn't
// collide with projects.spec's `editor@bwc.test` if the two specs
// run in parallel against the same database.
const TEST_SLUGS = ['blog-test', 'blog-test-renamed'] as const
const BLOG_EDITOR_EMAIL = 'blog-editor@bwc.test'
const BLOG_EDITOR_PASSWORD = 'CorrectHorseBattery0!'

function refuseRemoteDb(dsn: string): boolean {
  const hostMatch = dsn.match(/^mysql:\/\/[^@]*@([^:/]+)/)
  const host = hostMatch?.[1] ?? ''
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    console.warn(`[blog.spec] refusing destructive op — host=${host}`)
    return true
  }
  return false
}

async function purgeTestPosts(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    const placeholders = TEST_SLUGS.map(() => '?').join(',')
    await conn.execute(
      `DELETE FROM posts WHERE slug IN (${placeholders})`,
      TEST_SLUGS as unknown as string[],
    )
    await conn.execute(
      `DELETE FROM slug_redirects WHERE resource_type = 'post' AND (old_slug IN (${placeholders}) OR new_slug IN (${placeholders}))`,
      [...TEST_SLUGS, ...TEST_SLUGS],
    )
  } catch (err) {
    console.warn('[purgeTestPosts] cleanup failed:', err)
  } finally {
    await conn?.end()
  }
}

async function ensureBlogEditorUser(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    const [existing] = (await conn.query(
      'SELECT id FROM users WHERE email = ?',
      [BLOG_EDITOR_EMAIL],
    )) as unknown as [Array<{ id: number }>, unknown]
    if (existing[0]) return
    const passwordHash = await hashPasswordLocal(BLOG_EDITOR_PASSWORD)
    // tokens_valid_after backdated 5s — see admin.spec.ts ensureUser
    // for the timing rationale (JWT iat is second-truncated, tokens_valid_after
    // defaults to ms-precise NOW, race trips requireAuth's check).
    await conn.execute(
      `INSERT INTO users (email, name, role, active, must_rotate_password, password_hash, tokens_valid_after)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3) - INTERVAL 5 SECOND)`,
      [
        BLOG_EDITOR_EMAIL,
        'Blog Editor',
        'editor',
        true,
        false,
        passwordHash,
      ],
    )
  } finally {
    await conn?.end()
  }
}

async function purgeBlogEditorAuditRows(): Promise<void> {
  const dsn = process.env['DATABASE_URL'] ?? ''
  if (!dsn || refuseRemoteDb(dsn)) return
  let conn: mysql.Connection | undefined
  try {
    conn = await mysql.createConnection(dsn)
    const [rows] = (await conn.query(
      'SELECT id FROM users WHERE email = ?',
      [BLOG_EDITOR_EMAIL],
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

// Direct-JWT session mint for BOTH admin + editor — mirrored from
// projects.spec. The per-IP login rate-limit is 3/60s and the limiter
// state survives across suite runs while `pnpm dev` is reused, so
// only auth.spec.ts hits /api/auth/login. Every other spec uses JWT
// injection.
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

async function csrfHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies()
  const c = cookies.find((c) => c.name === CSRF_COOKIE_NAME)
  if (!c) throw new Error('csrf cookie missing')
  return c.value
}

let adminPage: Page
let editorPage: Page

test.describe.serial('Plan 06 — Blog', () => {
  test.beforeAll(async ({ browser }) => {
    await purgeTestPosts()
    await purgeBlogEditorAuditRows()
    await ensureBlogEditorUser()

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
          [BLOG_EDITOR_EMAIL],
        )) as unknown as [Array<{ id: number }>, unknown]
        if (!editorRows[0]) throw new Error('blog editor user missing')
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
    await purgeTestPosts()
    await purgeBlogEditorAuditRows()
  })

  test('admin creates + publishes post; /blog/[slug] renders sanitized HTML', async () => {
    const csrf = await csrfHeader(adminPage)

    // Create the draft.
    const createResp = await adminPage.request.post('/api/cms/posts', {
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      data: { slug: 'blog-test', title: 'Blog Test Post' },
    })
    expect(createResp.status()).toBe(201)
    const created = (await createResp.json()) as { id: number; slug: string }
    expect(created.slug).toBe('blog-test')

    // PATCH body + publish in one request. The body intentionally
    // includes XSS attempts (script tag, javascript: href) so the
    // public render test below verifies the sanitizer ate them.
    const xssBody =
      '<script>alert(1)</script>\n\n## Heading\n\n- one\n- two\n\n[click](javascript:alert(1))'
    const patchResp = await adminPage.request.patch(
      `/api/cms/posts/${created.id}`,
      {
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        data: {
          bodyMd: xssBody,
          excerpt: 'A test post',
          published: true,
          version: 0,
        },
      },
    )
    expect(patchResp.status()).toBe(200)
    const patchJson = (await patchResp.json()) as { version: number }
    expect(patchJson.version).toBe(1)

    // Public render: must include the sanitized h2/ul but NOT any
    // <script>, javascript:, or alert(1) payload IN THE RENDERED
    // ARTICLE. We scope the XSS-assertion to the <article> content
    // because Next.js dev-mode embeds an RSC flight payload in the
    // response that serializes raw server fetch results — including
    // body_md prior to sanitization. In production builds the flight
    // payload doesn't ship the raw mysql2 ResultSet, so this is
    // strictly a dev-mode artifact. The sanitization invariant we
    // care about is the rendered article, which is what reaches
    // visible DOM.
    const publicResp = await adminPage.request.get('/blog/blog-test')
    expect(publicResp.status()).toBe(200)
    const html = await publicResp.text()
    // The plain text "Blog Test Post" title appears in the h1.
    expect(html).toContain('Blog Test Post')
    // Isolate the article body — the markdown-rendered surface.
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/)
    const articleHtml = articleMatch ? articleMatch[1] : ''
    expect(articleHtml).not.toBe('')
    expect(articleHtml).toContain('<h2>Heading</h2>')
    expect(articleHtml).toContain('<ul>')
    expect(articleHtml).not.toContain('<script>alert(1)</script>')
    expect(articleHtml).not.toContain('javascript:alert')
    expect(articleHtml).not.toContain('alert(1)')
  })

  test('editor cannot toggle published / slug (RBAC 403 + audit rows)', async () => {
    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    let postId: number, version: number, editorId: number
    try {
      const [pRows] = (await conn.query(
        "SELECT id, version FROM posts WHERE slug = 'blog-test'",
      )) as unknown as [Array<{ id: number; version: number }>, unknown]
      const p = pRows[0]
      if (!p) throw new Error('blog-test post missing (test 1 prerequisite)')
      postId = p.id
      version = p.version
      const [uRows] = (await conn.query(
        'SELECT id FROM users WHERE email = ?',
        [BLOG_EDITOR_EMAIL],
      )) as unknown as [Array<{ id: number }>, unknown]
      const u = uRows[0]
      if (!u) throw new Error('blog editor user missing')
      editorId = u.id
    } finally {
      await conn.end()
    }

    const editorCsrf = await csrfHeader(editorPage)

    for (const forbidden of [
      { published: false },
      { slug: 'editor-tried-rename' },
    ]) {
      const resp = await editorPage.request.patch(
        `/api/cms/posts/${postId}`,
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

    // Two audit rows expected.
    const conn2 = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn2.query(
        `SELECT diff FROM audit_log
         WHERE user_id = ? AND action = 'rbac_field_reject'
           AND resource_type = 'post' AND resource_id = ?
         ORDER BY id DESC LIMIT 10`,
        [editorId, String(postId)],
      )) as unknown as [Array<{ diff: string | object }>, unknown]
      expect(rows.length).toBeGreaterThanOrEqual(2)
      const keysAcross = new Set<string>()
      for (const r of rows.slice(0, 2)) {
        const diff =
          typeof r.diff === 'string'
            ? (JSON.parse(r.diff) as { kind: string; keys: string[] })
            : (r.diff as { kind: string; keys: string[] })
        expect(diff.kind).toBe('rbac_field_reject')
        for (const k of diff.keys) keysAcross.add(k)
      }
      expect(keysAcross).toEqual(new Set(['published', 'slug']))
    } finally {
      await conn2.end()
    }

    // Post row unchanged: still version N, still published=1 from
    // the previous test (RBAC reject must not partially mutate).
    const conn3 = await mysql.createConnection(dsn)
    try {
      const [rows] = (await conn3.query(
        'SELECT version, published, slug FROM posts WHERE id = ?',
        [postId],
      )) as unknown as [
        Array<{ version: number; published: number; slug: string }>,
        unknown,
      ]
      expect(rows[0]!.version).toBe(version)
      expect(rows[0]!.published).toBe(1)
      expect(rows[0]!.slug).toBe('blog-test')
    } finally {
      await conn3.end()
    }
  })

  test('slug rename emits 308 permanent redirect at /blog/[slug]', async () => {
    const csrf = await csrfHeader(adminPage)

    const dsn = process.env['DATABASE_URL'] ?? ''
    const conn = await mysql.createConnection(dsn)
    let postId: number, version: number
    try {
      const [rows] = (await conn.query(
        "SELECT id, version FROM posts WHERE slug = 'blog-test'",
      )) as unknown as [Array<{ id: number; version: number }>, unknown]
      const r = rows[0]
      if (!r) throw new Error('blog-test post missing')
      postId = r.id
      version = r.version
    } finally {
      await conn.end()
    }

    const renameResp = await adminPage.request.patch(
      `/api/cms/posts/${postId}`,
      {
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        data: { slug: 'blog-test-renamed', version },
      },
    )
    expect(renameResp.status()).toBe(200)

    const r = await adminPage.request.get('/blog/blog-test', {
      maxRedirects: 0,
    })
    expect(r.status()).toBe(308)
    expect(r.headers()['location']).toContain('/blog/blog-test-renamed')

    // Following the redirect reaches the renamed post.
    const followed = await adminPage.request.get('/blog/blog-test-renamed')
    expect(followed.status()).toBe(200)
    const html = await followed.text()
    expect(html).toContain('Blog Test Post')
  })

  test('non-existent slug returns 404', async () => {
    const r = await adminPage.request.get(
      '/blog/this-slug-does-not-exist-xyzzy',
      { maxRedirects: 0 },
    )
    expect(r.status()).toBe(404)
  })
})
