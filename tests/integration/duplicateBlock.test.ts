import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import {
  duplicateBlock,
  DuplicateNotFoundError,
  DuplicateColumnCountExceededError,
  DuplicatePageNotFoundError,
  DuplicatePositionGapExhaustedError,
  DuplicateBlockTypeReservedError,
  MAX_DUPLICATE_SUBTREE_SIZE,
} from '@/lib/cms/duplicateBlock'
import { MAX_SECTION_COLUMNS, type BlockKind } from '@/lib/cms/blockMeta'

const USER_ID = 9301

async function resetTables(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
  await db.execute(sql`TRUNCATE TABLE media_references`)
  await db.execute(sql`TRUNCATE TABLE audit_log`)
  await db.execute(sql`TRUNCATE TABLE content_blocks`)
  await db.execute(sql`TRUNCATE TABLE media`)
  await db.execute(sql`TRUNCATE TABLE pages`)
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (${USER_ID}, ${`dup-${USER_ID}@test.local`}, 'placeholder', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
}

async function seedPage(id: number, slug: string): Promise<void> {
  await db.execute(sql`INSERT INTO pages (id, slug, version) VALUES (${id}, ${slug}, 0)`)
}

async function seedMedia(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO media (id, filename_uuid, mime_type, alt_text, byte_size, variants)
    VALUES (${id}, ${`u${id}`}, 'image/webp', ${`a${id}`}, 1,
            ${JSON.stringify({ md: `/uploads/variants/u${id}-md.webp` })})
  `)
}

interface InsertResult { insertId: number }
async function seedBlock(args: {
  pageId: number
  parentId: number | null
  kind: BlockKind
  blockType: string
  position: number
  data?: object
  meta?: object | null
  blockKey?: string | null
}): Promise<number> {
  const [res] = (await db.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_type, position, data, meta, block_key, version)
    VALUES (
      ${args.pageId},
      ${args.parentId},
      ${args.kind},
      ${args.blockType},
      ${args.position},
      ${JSON.stringify(args.data ?? {})},
      ${args.meta === undefined ? null : args.meta === null ? null : JSON.stringify(args.meta)},
      ${args.blockKey ?? null},
      0
    )
  `)) as unknown as [InsertResult]
  return Number(res.insertId)
}

describe('duplicateBlock — widget', () => {
  let pageId: number
  let widgetId: number

  beforeEach(async () => {
    await resetTables()
    pageId = 1
    await seedPage(pageId, 'home')
    await seedMedia(7)
    widgetId = await seedBlock({
      pageId,
      parentId: null,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1000,
      data: { heading: 'Source', body_richtext: '<p>x</p>' },
    })
  })

  it('inserts a new row with version=0 and a new id', async () => {
    const r = await duplicateBlock({
      sourceId: widgetId,
      userId: USER_ID,
      pageId,
      ip: null,
      userAgent: null,
      requestId: null,
    })
    expect(r.newTopId).not.toBe(widgetId)
    expect(r.descendantCount).toBe(0)
    const [rows] = (await db.execute(sql`
      SELECT id, version, block_type FROM content_blocks WHERE id = ${r.newTopId}
    `)) as unknown as [Array<{ id: number; version: number; block_type: string }>]
    expect(rows[0]?.version).toBe(0)
    expect(rows[0]?.block_type).toBe('lx_text')
  })

  it('places the duplicate immediately after the source within the same parent bucket', async () => {
    const r = await duplicateBlock({
      sourceId: widgetId,
      userId: USER_ID,
      pageId,
      ip: null,
      userAgent: null,
      requestId: null,
    })
    const [rows] = (await db.execute(sql`
      SELECT id, position FROM content_blocks
      WHERE page_id = ${pageId} AND deleted_at IS NULL AND parent_id IS NULL
      ORDER BY position
    `)) as unknown as [Array<{ id: number; position: number }>]
    expect(rows.map((r) => r.id)).toEqual([widgetId, r.newTopId])
  })

  it('does NOT carry block_key forward — duplicated row has block_key=NULL', async () => {
    // The duplicate INSERT omits the block_key column, defaulting to
    // NULL. Pair this with the fixed-slot reservation check below:
    // for fixed-slot block_types the duplicate is refused entirely,
    // so the only way a duplicate row could exist is with NULL key.
    // This test exercises the freeform-widget path explicitly.
    const r = await duplicateBlock({
      sourceId: widgetId,
      userId: USER_ID,
      pageId,
      ip: null,
      userAgent: null,
      requestId: null,
    })
    const [rows] = (await db.execute(sql`
      SELECT block_key FROM content_blocks WHERE id = ${r.newTopId}
    `)) as unknown as [Array<{ block_key: string | null }>]
    expect(rows[0]?.block_key).toBeNull()
  })

  it('copies media_references for widgets carrying media_id refs', async () => {
    // Use 'image' widget — not reserved on the home page (only hero,
    // featured_projects, services_intro, cta are fixed-slot). Hero
    // would 409 with block_type_reserved_for_fixed_slot.
    await db.execute(sql`DELETE FROM content_blocks WHERE id = ${widgetId}`)
    const imgId = await seedBlock({
      pageId,
      parentId: null,
      kind: 'widget',
      blockType: 'lx_figure',
      position: 1000,
      data: { image: { media_id: 7, alt: 'a' }, alignment: 'center' },
    })
    await db.execute(sql`
      INSERT INTO media_references (media_id, referent_type, referent_id, field)
      VALUES (7, 'content_block', ${imgId}, 'image')
    `)
    const r = await duplicateBlock({
      sourceId: imgId,
      userId: USER_ID,
      pageId,
      ip: null,
      userAgent: null,
      requestId: null,
    })
    const [refs] = (await db.execute(sql`
      SELECT referent_id FROM media_references
      WHERE media_id = 7 AND referent_type = 'content_block'
      ORDER BY referent_id
    `)) as unknown as [Array<{ referent_id: number }>]
    expect(refs.map((r) => r.referent_id).sort((a, b) => a - b)).toEqual(
      [imgId, r.newTopId].sort((a, b) => a - b),
    )
  })

  it('writes an audit_log row with kind=duplicate referencing the source', async () => {
    const r = await duplicateBlock({
      sourceId: widgetId,
      userId: USER_ID,
      pageId,
      ip: '127.0.0.1',
      userAgent: 'test-ua',
      requestId: 'req-1',
    })
    const [rows] = (await db.execute(sql`
      SELECT action, resource_id, diff, ip, user_agent, request_id
      FROM audit_log
      WHERE resource_id = ${String(r.newTopId)}
    `)) as unknown as [Array<{ action: string; resource_id: string; diff: unknown; ip: string | null; user_agent: string | null; request_id: string | null }>]
    expect(rows.length).toBe(1)
    expect(rows[0]?.action).toBe('create')
    expect(rows[0]?.ip).toBe('127.0.0.1')
    expect(rows[0]?.user_agent).toBe('test-ua')
    expect(rows[0]?.request_id).toBe('req-1')
    const diff =
      typeof rows[0]?.diff === 'string'
        ? (JSON.parse(rows[0].diff) as Record<string, unknown>)
        : (rows[0]?.diff as Record<string, unknown>)
    expect(diff['kind']).toBe('duplicate')
    expect(diff['source_id']).toBe(widgetId)
    expect(diff['descendant_count']).toBe(0)
  })
})

describe('duplicateBlock — failure modes', () => {
  beforeEach(async () => {
    await resetTables()
    await seedPage(1, 'home')
    await seedPage(2, 'about')
  })

  it('throws DuplicatePageNotFoundError when pageId points to a missing page', async () => {
    const widgetId = await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1000,
      data: { heading: 'A', body_richtext: '<p>a</p>' },
    })
    await expect(
      duplicateBlock({
        sourceId: widgetId,
        userId: USER_ID,
        pageId: 9999,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(DuplicatePageNotFoundError)
  })

  it('throws DuplicateNotFoundError when sourceId belongs to a different page than args.pageId', async () => {
    const onPage1 = await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1000,
      data: { heading: 'A', body_richtext: '<p>a</p>' },
    })
    await expect(
      duplicateBlock({
        sourceId: onPage1,
        userId: USER_ID,
        pageId: 2, // claim page 2 but the source belongs to page 1
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateNotFoundError)
  })

  it('throws DuplicatePositionGapExhaustedError when adjacent siblings have no integer gap', async () => {
    // Two top-level siblings at positions 1000 and 1001. Bisecting
    // gives Math.floor((1000+1001)/2) = 1000 — equal to the source's
    // position → handler refuses with the gap-exhausted error so the
    // operator can refresh + retry (refresh-triggered reorder
    // re-spaces the bucket back to 1000-stepped positions).
    const a = await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1000,
      data: { heading: 'A', body_richtext: '<p>a</p>' },
    })
    await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1001,
      data: { heading: 'B', body_richtext: '<p>b</p>' },
    })
    await expect(
      duplicateBlock({
        sourceId: a,
        userId: USER_ID,
        pageId: 1,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(DuplicatePositionGapExhaustedError)
  })

  it('throws DuplicateBlockTypeReservedError when source widget is a fixed-slot block type for the page', async () => {
    // The contact page reserves block_type='contact_form' as a fixed
    // slot. A widget duplicate of the contact form would create a second
    // form on the page — refuse server-side regardless of whether the
    // source has block_key set or not.
    await seedPage(3, 'contact')
    const formId = await seedBlock({
      pageId: 3,
      parentId: null,
      kind: 'widget',
      blockType: 'contact_form',
      position: 1000,
      data: { heading: 'Contact us', submit_label: 'Send' },
      blockKey: 'contact_form',
    })
    await expect(
      duplicateBlock({
        sourceId: formId,
        userId: USER_ID,
        pageId: 3,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateBlockTypeReservedError)
  })

  it('throws DuplicateColumnCountExceededError when the section is already at MAX columns', async () => {
    const sectionId = await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'section',
      blockType: 'section',
      position: 1000,
      meta: { columns: MAX_SECTION_COLUMNS, background: 'cream', padding: 'md' },
    })
    const colIds: number[] = []
    for (let i = 0; i < MAX_SECTION_COLUMNS; i += 1) {
      colIds.push(
        await seedBlock({
          pageId: 1,
          parentId: sectionId,
          kind: 'column',
          blockType: 'column',
          position: (i + 1) * 1000,
          meta: {},
        }),
      )
    }
    await expect(
      duplicateBlock({
        sourceId: colIds[0]!,
        userId: USER_ID,
        pageId: 1,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ).rejects.toBeInstanceOf(DuplicateColumnCountExceededError)
  })
})

describe('duplicateBlock — full section subtree', () => {
  beforeEach(async () => {
    await resetTables()
    await seedPage(1, 'home')
    await seedMedia(7)
  })

  it('clones a section with columns + widgets and preserves the tree shape', async () => {
    const sectionId = await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'section',
      blockType: 'section',
      position: 1000,
      meta: { columns: 2, background: 'cream', padding: 'md' },
    })
    const col1 = await seedBlock({
      pageId: 1,
      parentId: sectionId,
      kind: 'column',
      blockType: 'column',
      position: 1000,
      meta: {},
    })
    const col2 = await seedBlock({
      pageId: 1,
      parentId: sectionId,
      kind: 'column',
      blockType: 'column',
      position: 2000,
      meta: {},
    })
    const w1 = await seedBlock({
      pageId: 1,
      parentId: col1,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1000,
      data: { heading: 'W1', body_richtext: '<p>a</p>' },
    })
    const w2 = await seedBlock({
      pageId: 1,
      parentId: col2,
      kind: 'widget',
      blockType: 'lx_text',
      position: 1000,
      data: { heading: 'W2', body_richtext: '<p>b</p>' },
    })
    const r = await duplicateBlock({
      sourceId: sectionId,
      userId: USER_ID,
      pageId: 1,
      ip: null,
      userAgent: null,
      requestId: null,
    })
    // 2 columns + 2 widgets = 4 descendants
    expect(r.descendantCount).toBe(4)

    // The new top-level is a section at the top level (parent_id NULL)
    // appearing AFTER the original.
    const [topLevel] = (await db.execute(sql`
      SELECT id, kind, position FROM content_blocks
      WHERE page_id = 1 AND deleted_at IS NULL AND parent_id IS NULL
      ORDER BY position
    `)) as unknown as [Array<{ id: number; kind: string; position: number }>]
    expect(topLevel.map((r) => r.id)).toEqual([sectionId, r.newTopId])
    expect(topLevel.every((r) => r.kind === 'section')).toBe(true)

    // The new section has exactly two columns; each has exactly one widget.
    const [newCols] = (await db.execute(sql`
      SELECT id FROM content_blocks
      WHERE parent_id = ${r.newTopId} AND deleted_at IS NULL
      ORDER BY position
    `)) as unknown as [Array<{ id: number }>]
    expect(newCols.length).toBe(2)
    // Original column ids stay alive; new ids are different.
    expect(newCols.every((c) => c.id !== col1 && c.id !== col2)).toBe(true)

    const [newWidgets] = (await db.execute(sql`
      SELECT id, parent_id, block_type FROM content_blocks
      WHERE parent_id IN (${sql.join(newCols.map((c) => c.id), sql.raw(','))})
        AND deleted_at IS NULL
      ORDER BY parent_id, position
    `)) as unknown as [Array<{ id: number; parent_id: number; block_type: string }>]
    expect(newWidgets.length).toBe(2)
    expect(newWidgets.every((w) => w.id !== w1 && w.id !== w2)).toBe(true)
    expect(newWidgets.every((w) => w.block_type === 'lx_text')).toBe(true)
  })

  it('refuses to duplicate when the source subtree exceeds MAX_DUPLICATE_SUBTREE_SIZE', async () => {
    const sectionId = await seedBlock({
      pageId: 1,
      parentId: null,
      kind: 'section',
      blockType: 'section',
      position: 1000,
      meta: { columns: 1, background: 'cream', padding: 'md' },
    })
    const colId = await seedBlock({
      pageId: 1,
      parentId: sectionId,
      kind: 'column',
      blockType: 'column',
      position: 1000,
      meta: {},
    })
    // Seed enough widgets to push 1 section + 1 column + N widgets over
    // the cap (256). N = MAX_DUPLICATE_SUBTREE_SIZE so total = 1+1+N
    // safely above the cap.
    for (let i = 0; i < MAX_DUPLICATE_SUBTREE_SIZE; i += 1) {
      await seedBlock({
        pageId: 1,
        parentId: colId,
        kind: 'widget',
        blockType: 'lx_text',
        position: (i + 1) * 1000,
        data: { heading: `w${i}`, body_richtext: '<p>x</p>' },
      })
    }
    await expect(
      duplicateBlock({
        sourceId: sectionId,
        userId: USER_ID,
        pageId: 1,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ).rejects.toThrow(/subtree_too_large/)
  })
})
