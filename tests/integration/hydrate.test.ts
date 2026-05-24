import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { hydratePage } from '@/lib/cms/hydrate'

const USER_ID = 9201

describe('hydratePage', () => {
  beforeEach(async () => {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
    await db.execute(sql`TRUNCATE TABLE media_references`)
    await db.execute(sql`TRUNCATE TABLE content_blocks`)
    await db.execute(sql`TRUNCATE TABLE media`)
    await db.execute(sql`TRUNCATE TABLE pages`)
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)

    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
      VALUES (${USER_ID}, ${`hyd-${USER_ID}@test.local`}, 'placeholder', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = VALUES(email)
    `)
    await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (1, 'home', 0)`)
    await db.execute(sql`
      INSERT INTO media (id, filename_uuid, mime_type, alt_text, byte_size, variants)
      VALUES
        (1, 'u1', 'image/webp', 'hero alt', 1, ${JSON.stringify({ md: '/uploads/variants/u1-md.webp' })}),
        (2, 'u2', 'image/webp', 'gallery1 alt', 1, ${JSON.stringify({ md: '/uploads/variants/u2-md.webp' })}),
        (3, 'u3', 'image/webp', 'soft-deleted alt', 1, ${JSON.stringify({ md: '/uploads/variants/u3-md.webp' })})
    `)
    // Soft-delete media id=3 so we can prove hydrate filters it.
    await db.execute(sql`UPDATE media SET deleted_at = NOW(3) WHERE id = 3`)

    await db.execute(sql`
      INSERT INTO content_blocks (id, page_id, block_key, block_type, position, data, version)
      VALUES
        (10, 1, 'hero', 'hero', 1000,
         ${JSON.stringify({ title: 'A', image: { media_id: 1, alt: 'hero alt' } })}, 0),
        (20, 1, NULL, 'gallery', 2000,
         ${JSON.stringify({ images: [{ media_id: 2, alt: 'gallery1 alt' }], columns: 3 })}, 0),
        (30, 1, NULL, 'text', 3000,
         ${JSON.stringify({ body_richtext: '<p>plain</p>' })}, 0)
    `)
  })

  it('returns blocks in position order', async () => {
    const out = await hydratePage(1)
    if (!out) throw new Error('expected hydratePage to return a page')
    expect(out.blocks.map((b) => b.id)).toEqual([10, 20, 30])
  })

  it('resolves media by id, skipping soft-deleted rows', async () => {
    const out = await hydratePage(1)
    if (!out) throw new Error('expected hydratePage to return a page')
    expect(out.media.has(1)).toBe(true)
    expect(out.media.has(2)).toBe(true)
    expect(out.media.has(3)).toBe(false)
    expect(out.media.get(1)?.variants).toMatchObject({
      md: '/uploads/variants/u1-md.webp',
    })
  })

  it('returns empty projects Map when no blocks reference projects', async () => {
    const out = await hydratePage(1)
    if (!out) throw new Error('expected hydratePage to return a page')
    expect(out.projects.size).toBe(0)
  })

  it('skips soft-deleted blocks', async () => {
    await db.execute(sql`UPDATE content_blocks SET deleted_at = NOW(3) WHERE id = 30`)
    const out = await hydratePage(1)
    if (!out) throw new Error('expected hydratePage to return a page')
    expect(out.blocks.map((b) => b.id)).toEqual([10, 20])
  })

  it('returns null when the page does not exist', async () => {
    const out = await hydratePage(999_999)
    expect(out).toBeNull()
  })

  it('omits a malformed block and renders the rest of the page', async () => {
    // Corrupt block id=10 (hero — needs `image`). Other two blocks stay valid.
    // hydrate's per-block try/catch should drop just the broken one.
    await db.execute(sql`
      UPDATE content_blocks SET data = ${JSON.stringify({ title: 'broken' })} WHERE id = 10
    `)
    const out = await hydratePage(1)
    if (!out) throw new Error('expected hydratePage to return a page')
    expect(out.blocks.map((b) => b.id)).toEqual([20, 30])
  })

  it('logs and skips when EVERY block is malformed (returns empty blocks, not 500)', async () => {
    // All three rows broken in the same way. The per-block try/catch in
    // hydrate skips each; the page renders with zero blocks (admin can
    // see this in the audit/error feed and fix forward).
    await db.execute(sql`
      UPDATE content_blocks SET data = ${JSON.stringify({ x: 'wrong shape' })}
      WHERE page_id = 1
    `)
    const out = await hydratePage(1)
    if (!out) throw new Error('expected hydratePage to return a page')
    expect(out.blocks).toEqual([])
  })
})
