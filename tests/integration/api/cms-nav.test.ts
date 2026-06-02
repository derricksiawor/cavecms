import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Auth-gate mocks. Preserve the REAL HttpError so withError's
// `instanceof HttpError` checks still map 400/409 correctly.
let MOCK_TOKEN = false
vi.mock('@/lib/auth/requireRole', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/requireRole')>(
    '@/lib/auth/requireRole',
  )
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: 9701,
      role: 'admin',
      email: 'nav-test@local',
      jti: 'jti-nav',
      oat: 0,
      iat: 0,
      pwp: false,
      viaApiToken: MOCK_TOKEN,
    })),
  }
})
vi.mock('@/lib/auth/requireCsrf', () => ({ requireCsrf: vi.fn(async () => undefined) }))
vi.mock('@/lib/auth/cmsRateLimit', () => ({
  checkMutationRate: vi.fn(() => undefined),
  checkReadRate: vi.fn(() => undefined),
}))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}))

import { GET, PUT } from '@/app/api/cms/nav/route'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

async function seedHeader(navItems: unknown): Promise<number> {
  const value = JSON.stringify({
    brandText: 'T',
    logo: null,
    logoMaxHeight: 40,
    theme: 'cream',
    navItems,
    primaryCta: null,
  })
  await db.execute(sql`
    INSERT INTO settings (\`key\`, value, version) VALUES ('site_header', ${value}, 1)
    ON DUPLICATE KEY UPDATE value = ${value}, version = version + 1
  `)
  const [rows] = (await db.execute(
    sql`SELECT version FROM settings WHERE \`key\`='site_header'`,
  )) as unknown as [Array<{ version: number }>]
  return rows[0]!.version
}

const USER_ID = 9701

describe('/api/cms/nav (integration)', () => {
  beforeEach(async () => {
    MOCK_TOKEN = false
    // Seed the admin the mocked ctx references — settings.updated_by FKs to users.id.
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
      VALUES (${USER_ID}, ${`navtest-${USER_ID}@test.local`}, 'placeholder', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = VALUES(email)
    `)
  })
  afterEach(() => vi.clearAllMocks())

  it('GET returns header + footer trees', async () => {
    await seedHeader([
      { label: 'About', href: '/about', children: [{ label: 'Team', href: '/team' }] },
    ])
    const res = await GET(new Request('http://x/api/cms/nav'), {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.header.items[0].label).toBe('About')
    expect(body.header.items[0].children[0].label).toBe('Team')
    expect(Array.isArray(body.footer.columns)).toBe(true)
    // authed (mocked) read includes versions for round-trip writes
    expect(typeof body.header.version).toBe('number')
  })

  it('PUT replaces the header menu and bumps version (other fields preserved)', async () => {
    const version = await seedHeader([{ label: 'Old', href: '/old' }])
    const res = await PUT(
      new Request('http://x/api/cms/nav', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          menu: 'header',
          version,
          tree: [{ label: 'New', href: '/new', children: [{ label: 'Sub', href: '/sub' }] }],
        }),
      }),
      {},
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toBe(version + 1)
    const [rows] = (await db.execute(
      sql`SELECT value FROM settings WHERE \`key\`='site_header'`,
    )) as unknown as [Array<{ value: unknown }>]
    const stored =
      typeof rows[0]!.value === 'string' ? JSON.parse(rows[0]!.value as string) : rows[0]!.value
    expect(stored.navItems[0].label).toBe('New')
    expect(stored.navItems[0].children[0].label).toBe('Sub')
    expect(stored.brandText).toBe('T') // splice preserved other fields
  })

  it('PUT with a stale version → 409', async () => {
    const version = await seedHeader([{ label: 'X', href: '/x' }])
    const res = await PUT(
      new Request('http://x/api/cms/nav', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ menu: 'header', version: version - 1, tree: [{ label: 'Y', href: '/y' }] }),
      }),
      {},
    )
    expect(res.status).toBe(409)
  })

  it('PUT with an over-cap tree → 400', async () => {
    const version = await seedHeader([{ label: 'X', href: '/x' }])
    const kids = Array.from({ length: 13 }, (_, i) => ({ label: `c${i}`, href: `/c${i}` }))
    const res = await PUT(
      new Request('http://x/api/cms/nav', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ menu: 'header', version, tree: [{ label: 'X', href: '/x', children: kids }] }),
      }),
      {},
    )
    expect(res.status).toBe(400)
  })

  it('PUT is a no-op (no version bump) when the submitted tree is unchanged, even with transient __id', async () => {
    const version = await seedHeader([{ label: 'Orig', href: '/orig' }])
    // First write changes the tree → real version bump to version+1.
    const first = await PUT(
      new Request('http://x/api/cms/nav', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ menu: 'header', version, tree: [{ label: 'Same', href: '/same' }] }),
      }),
      {},
    )
    const v1 = (await first.json()).version as number
    expect(v1).toBe(version + 1)
    // Re-submit the SAME logical tree (with a transient __id the builder adds)
    // at the bumped version → schema-clean compare detects the no-op.
    const second = await PUT(
      new Request('http://x/api/cms/nav', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ menu: 'header', version: v1, tree: [{ __id: 'transient', label: 'Same', href: '/same' }] }),
      }),
      {},
    )
    expect(second.status).toBe(200)
    expect((await second.json()).version).toBe(v1) // unchanged — no spurious bump
  })

  it('PUT strips the internal __id key before persisting', async () => {
    const version = await seedHeader([{ label: 'X', href: '/x' }])
    await PUT(
      new Request('http://x/api/cms/nav', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          menu: 'header',
          version,
          tree: [{ __id: 'abc', label: 'Z', href: '/z', children: [{ __id: 'd', label: 'Q', href: '/q' }] }],
        }),
      }),
      {},
    )
    const [rows] = (await db.execute(
      sql`SELECT value FROM settings WHERE \`key\`='site_header'`,
    )) as unknown as [Array<{ value: unknown }>]
    const stored =
      typeof rows[0]!.value === 'string' ? JSON.parse(rows[0]!.value as string) : rows[0]!.value
    expect('__id' in stored.navItems[0]).toBe(false)
    expect('__id' in stored.navItems[0].children[0]).toBe(false)
  })
})
