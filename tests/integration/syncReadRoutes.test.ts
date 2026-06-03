import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { mediaBundleKey } from '@/lib/sync/contentHash'

// Mock the auth + rate-limit boundary so we can exercise the route bodies
// against the real test DB without a live session. (The repo doesn't HTTP-test
// routes; real token auth is exercised in the Task 1.6 live smoke.)
vi.mock('@/lib/auth/requireRole', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/requireRole')>()
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      userId: 9100,
      role: 'admin',
      email: 'sync@test.local',
      jti: 'test',
      oat: 0,
      iat: 0,
      pwp: false,
      viaApiToken: true,
    })),
  }
})
vi.mock('@/lib/auth/cmsRateLimit', () => ({
  checkReadRate: () => {},
  checkMutationRate: () => {},
}))

const { GET: hashGET } = await import('@/app/api/cms/sync/hash/route')
const { GET: exportGET } = await import('@/app/api/cms/sync/export/route')

async function seed() {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
  for (const t of ['media_references', 'content_blocks', 'media', 'pages', 'posts', 'projects', 'settings']) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${t}`))
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (9100, 'sync@test.local', 'x', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
  await db.execute(sql`
    INSERT INTO media (id, filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, variants)
    VALUES (50, 'mu50', 'hero.jpg', 'image/jpeg', 'hero', 1600, 900, 12345,
            ${JSON.stringify({ md: '/uploads/variants/mu50-md.webp' })})
  `)
  await db.execute(sql`
    INSERT INTO pages (id, slug, title, is_home, system, published, hero_image_id, version)
    VALUES (100, 'home', 'Home', true, false, true, 50, 0)
  `)
}

describe('sync read routes', () => {
  beforeEach(seed)

  it('GET /api/cms/sync/hash returns a 64-hex hash + counts', async () => {
    const res = await hashGET(new Request('http://local/api/cms/sync/hash'), {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.counts.pages).toBe(1)
    expect(body.counts.media).toBe(1)
  })

  it('GET /api/cms/sync/export returns content + matching hash', async () => {
    const res = await exportGET(new Request('http://local/api/cms/sync/export'), {})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.formatVersion).toBe(1)
    expect(body.content.pages[0].slug).toBe('home')
    const heroKey = mediaBundleKey({ originalName: 'hero.jpg', byteSize: 12345, width: 1600, height: 900, mime: 'image/jpeg' })
    expect(body.content.pages[0].heroImageKey).toBe(heroKey)

    // hash from export matches hash from the hash route
    const hashRes = await hashGET(new Request('http://local/api/cms/sync/hash'), {})
    const hashBody = await hashRes.json()
    expect(body.contentHash).toBe(hashBody.contentHash)
  })
})
