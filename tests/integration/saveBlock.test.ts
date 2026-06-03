import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import {
  saveBlock,
  StaleBlockVersionError,
  StalePageVersionError,
  NotFoundError,
} from '@/lib/cms/saveBlock'

const USER_ID = 9001

describe('saveBlock', () => {
  beforeEach(async () => {
    // FK cascade order: references first, then the parents.
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
    await db.execute(sql`TRUNCATE TABLE media_references`)
    await db.execute(sql`TRUNCATE TABLE audit_log`)
    await db.execute(sql`TRUNCATE TABLE content_blocks`)
    await db.execute(sql`TRUNCATE TABLE media`)
    await db.execute(sql`TRUNCATE TABLE pages`)
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)

    // Seed the user that updated_by / uploaded_by / user_id FK to.
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
      VALUES (${USER_ID}, ${`saveblock-${USER_ID}@test.local`}, 'placeholder', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = VALUES(email)
    `)
    await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (1, 'home', 0)`)
    await db.execute(sql`
      INSERT INTO media (id, filename_uuid, mime_type, alt_text, byte_size, variants)
      VALUES
        (1, 'u1', 'image/webp', 'one', 1, ${JSON.stringify({ md: '/uploads/variants/u1-md.webp' })}),
        (2, 'u2', 'image/webp', 'two', 1, ${JSON.stringify({ md: '/uploads/variants/u2-md.webp' })})
    `)
    await db.execute(sql`
      INSERT INTO content_blocks (id, page_id, block_key, block_type, position, data, version)
      VALUES (1, 1, NULL, 'lx_cover_image', 1000,
              ${JSON.stringify({ title: 'A', image: { media_id: 1, alt: 'a' } })},
              5)
    `)
    await db.execute(sql`
      INSERT INTO media_references (media_id, referent_type, referent_id, field)
      VALUES (1, 'content_block', 1, 'image')
    `)
  })

  it('saves with correct versions and bumps both pages.version AND content_blocks.version by +1', async () => {
    const { blockVersion, pageVersion } = await saveBlock({
      blockId: 1,
      userId: USER_ID,
      tokenId: null,
      ip: '127.0.0.1',
      userAgent: 'test-ua',
      requestId: 'test-req',
      pageId: 1,
      expectedBlockVersion: 5,
      expectedPageVersion: 0,
      data: { title: 'B', image: { media_id: 2, alt: 'b' } },
    })
    expect(blockVersion).toBe(6)
    expect(pageVersion).toBe(1)
    const [blockRows] = (await db.execute(
      sql`SELECT version FROM content_blocks WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(blockRows[0]?.version).toBe(6)
    const [pageRows] = (await db.execute(
      sql`SELECT version FROM pages WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(pageRows[0]?.version).toBe(1)
  })

  it('updates media_references to reflect new media bindings (add + remove)', async () => {
    await saveBlock({
      blockId: 1,
      userId: USER_ID,
      tokenId: null,
      ip: null,
      userAgent: null,
      requestId: null,
      pageId: 1,
      expectedBlockVersion: 5,
      expectedPageVersion: 0,
      data: { title: 'B', image: { media_id: 2, alt: 'b' } },
    })
    const [refs] = (await db.execute(
      sql`SELECT media_id, field FROM media_references WHERE referent_type='content_block' AND referent_id=1 ORDER BY media_id`,
    )) as unknown as [Array<{ media_id: number; field: string }>]
    expect(refs).toEqual([{ media_id: 2, field: 'image' }])
  })

  it('writes an audit_log row with action=update and the diff array', async () => {
    await saveBlock({
      blockId: 1,
      userId: USER_ID,
      tokenId: null,
      ip: '127.0.0.1',
      userAgent: 'test-ua',
      requestId: 'test-req',
      pageId: 1,
      expectedBlockVersion: 5,
      expectedPageVersion: 0,
      data: { title: 'B', image: { media_id: 1, alt: 'a' } },
    })
    const [rows] = (await db.execute(
      sql`SELECT user_id, action, resource_type, resource_id, ip, diff FROM audit_log ORDER BY id DESC LIMIT 1`,
    )) as unknown as [
      Array<{
        user_id: number
        action: string
        resource_type: string
        resource_id: string
        ip: string
        diff: unknown
      }>,
    ]
    expect(rows[0]).toMatchObject({
      user_id: USER_ID,
      action: 'update',
      resource_type: 'content_block',
      resource_id: '1',
      ip: '127.0.0.1',
    })
    // mysql2 returns JSON columns as strings via raw SQL; parse for
    // the assertion. After round-2: diff is { kind: 'patch', ops: [...] }
    // under the cap, or { kind: 'patch_truncated', ... } over. The
    // truncation path itself is covered by the capAuditDiff unit test.
    const diffParsed = JSON.parse(String(rows[0]?.diff ?? 'null'))
    expect(diffParsed).toMatchObject({ kind: 'patch' })
    expect(Array.isArray(diffParsed.ops)).toBe(true)
  })

  it('throws StaleBlockVersionError when expectedBlockVersion mismatches', async () => {
    await expect(
      saveBlock({
        blockId: 1,
        userId: USER_ID,
        tokenId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        pageId: 1,
        expectedBlockVersion: 99,
        expectedPageVersion: 0,
        data: { title: 'C', image: { media_id: 1, alt: 'a' } },
      }),
    ).rejects.toBeInstanceOf(StaleBlockVersionError)
    // pages.version did NOT bump — the TX rolled back before the block-version check.
    // Wait — actually it rolls back AFTER the page UPDATE has run inside the TX.
    // Transaction semantics: all writes (including the page bump) are undone
    // by the throw. Verify the row stays at 0.
    const [rows] = (await db.execute(
      sql`SELECT version FROM pages WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(rows[0]?.version).toBe(0)
  })

  it('throws StalePageVersionError when expectedPageVersion mismatches', async () => {
    await expect(
      saveBlock({
        blockId: 1,
        userId: USER_ID,
        tokenId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        pageId: 1,
        expectedBlockVersion: 5,
        expectedPageVersion: 99,
        data: { title: 'C', image: { media_id: 1, alt: 'a' } },
      }),
    ).rejects.toBeInstanceOf(StalePageVersionError)
    // Neither the page row nor the block row should have moved.
    const [pageRows] = (await db.execute(
      sql`SELECT version FROM pages WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(pageRows[0]?.version).toBe(0)
    const [blockRows] = (await db.execute(
      sql`SELECT version FROM content_blocks WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(blockRows[0]?.version).toBe(5)
  })

  it('throws NotFoundError when block is missing or soft-deleted', async () => {
    await db.execute(sql`UPDATE content_blocks SET deleted_at = NOW(3) WHERE id = 1`)
    await expect(
      saveBlock({
        blockId: 1,
        userId: USER_ID,
        tokenId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        pageId: 1,
        expectedBlockVersion: 5,
        expectedPageVersion: 0,
        data: { title: 'B', image: { media_id: 1, alt: 'a' } },
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('throws NotFoundError when pageId is forged (block belongs to another page)', async () => {
    // Create a second page; block-1 still belongs to page-1. A save
    // claiming pageId=2 should surface 404 not_found, NOT silently
    // write under the wrong page.
    await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (2, 'about', 0)`)
    await expect(
      saveBlock({
        blockId: 1,
        userId: USER_ID,
        tokenId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        pageId: 2,
        expectedBlockVersion: 5,
        expectedPageVersion: 0,
        data: { title: 'B', image: { media_id: 1, alt: 'a' } },
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects payloads that fail Zod (invalid block shape)', async () => {
    await expect(
      saveBlock({
        blockId: 1,
        userId: USER_ID,
        tokenId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        pageId: 1,
        expectedBlockVersion: 5,
        expectedPageVersion: 0,
        data: { title: 'B' /* missing required image */ },
      }),
    ).rejects.toBeTruthy()
    // Both versions stay put — TX rolled back.
    const [blockRows] = (await db.execute(
      sql`SELECT version FROM content_blocks WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(blockRows[0]?.version).toBe(5)
    const [pageRows] = (await db.execute(
      sql`SELECT version FROM pages WHERE id = 1`,
    )) as unknown as [Array<{ version: number }>]
    expect(pageRows[0]?.version).toBe(0)
  })

  it('rolls back media_references when a parse error throws mid-TX', async () => {
    await expect(
      saveBlock({
        blockId: 1,
        userId: USER_ID,
        tokenId: null,
        ip: null,
        userAgent: null,
        requestId: null,
        pageId: 1,
        expectedBlockVersion: 5,
        expectedPageVersion: 0,
        data: { title: 123 /* wrong type */, image: { media_id: 2, alt: 'b' } },
      }),
    ).rejects.toBeTruthy()
    // Original ref still there, no rogue ref to media 2.
    const [refs] = (await db.execute(
      sql`SELECT media_id FROM media_references WHERE referent_type='content_block' AND referent_id=1 ORDER BY media_id`,
    )) as unknown as [Array<{ media_id: number }>]
    expect(refs).toEqual([{ media_id: 1 }])
  })
})
