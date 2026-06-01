import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { PATHS } from '@/lib/media/storage'
import { provisionBundleMedia, resolveStagedContent } from '@/lib/sync/mediaRemap'
import type { MediaBundleEntryT, PageBundleT } from '@/lib/sync/bundleTypes'

const BUNDLE = path.join(tmpdir(), 'cavecms-sync-mediaremap-fixture')
const written: string[] = []

function fixtureBundle() {
  rmSync(BUNDLE, { recursive: true, force: true })
  mkdirSync(path.join(BUNDLE, 'media', 'files'), { recursive: true })
  for (const name of ['k1-thumb.webp', 'k1-md.webp', 'k1-lg.webp', 'k1-og.jpg', 'k2.pdf']) {
    writeFileSync(path.join(BUNDLE, 'media', 'files', name), `bytes:${name}`)
  }
}

const entries: MediaBundleEntryT[] = [
  {
    bundleKey: 'k1', originalName: 'hero.jpg', mime: 'image/jpeg', alt: 'hero',
    width: 1600, height: 900, byteSize: 9, kind: 'image',
    files: { thumb: 'media/files/k1-thumb.webp', md: 'media/files/k1-md.webp', lg: 'media/files/k1-lg.webp', og: 'media/files/k1-og.jpg' },
  },
  {
    bundleKey: 'k2', originalName: 'brochure.pdf', mime: 'application/pdf', alt: 'brochure',
    width: null, height: null, byteSize: 9, kind: 'pdf',
    files: { pdf: 'media/files/k2.pdf' },
  },
]

describe('mediaRemap', () => {
  beforeEach(async () => {
    fixtureBundle()
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
    await db.execute(sql`TRUNCATE TABLE media_references`)
    await db.execute(sql`TRUNCATE TABLE media`)
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
  })
  afterEach(() => {
    for (const p of written.splice(0)) rmSync(p, { force: true })
    rmSync(BUNDLE, { recursive: true, force: true })
  })

  it('copies variant + pdf files and inserts media rows', async () => {
    const map = await db.transaction((tx) => provisionBundleMedia(tx, entries, BUNDLE, written))
    expect(map.get('k1')).toBeDefined()
    expect(map.get('k2')).toBeDefined()

    const [rows] = (await db.execute(sql`SELECT id, mime_type, filename_uuid, variants FROM media ORDER BY id`)) as unknown as [
      Array<{ id: number; mime_type: string; filename_uuid: string; variants: unknown }>,
    ]
    expect(rows).toHaveLength(2)

    // image row has 4 variant files on disk
    const img = rows.find((r) => r.mime_type === 'image/jpeg')!
    expect(existsSync(path.join(PATHS.variants, `${img.filename_uuid}-md.webp`))).toBe(true)
    expect(existsSync(path.join(PATHS.variants, `${img.filename_uuid}-og.jpg`))).toBe(true)

    // pdf row landed in brochures-private, variants NULL
    const pdf = rows.find((r) => r.mime_type === 'application/pdf')!
    expect(existsSync(path.join(PATHS.brochures, `${pdf.filename_uuid}.pdf`))).toBe(true)
  })

  it('dedups against an existing LIVE media row (no new image row)', async () => {
    // A prior push already made this image live (deleted_at NULL). Re-pushing
    // identical content must reuse it, not re-upload.
    await db.execute(sql`
      INSERT INTO media (id, filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, variants, deleted_at)
      VALUES (999, 'existing', 'hero.jpg', 'image/jpeg', 'existing', 1600, 900, 9, ${JSON.stringify({ md: '/x' })}, NULL)
    `)
    const map = await db.transaction((tx) => provisionBundleMedia(tx, entries, BUNDLE, written))
    expect(map.get('k1')!.mediaId).toBe(999) // reused the live row, no new image
    // total media = the seeded live image (999) + the newly-provisioned pdf (k2)
    const [[{ c }]] = (await db.execute(sql`SELECT COUNT(*) c FROM media`)) as unknown as [[{ c: number }]]
    expect(Number(c)).toBe(2)
  })

  it('provisions staged media as quarantined (soft-deleted) until cutover', async () => {
    await db.transaction((tx) => provisionBundleMedia(tx, entries, BUNDLE, written))
    const [rows] = (await db.execute(sql`SELECT deleted_at FROM media`)) as unknown as [Array<{ deleted_at: unknown }>]
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.deleted_at !== null)).toBe(true)
  })

  it('resolveStagedContent injects real media_ids at ref paths', async () => {
    const map = await db.transaction((tx) => provisionBundleMedia(tx, entries, BUNDLE, written))
    const heroId = map.get('k1')!.mediaId
    const pages: PageBundleT[] = [
      {
        slug: 'home', title: 'Home', isHome: true, system: false, published: true,
        seoTitle: null, seoDescription: null, ogImageKey: null, heroImageKey: 'k1',
        sections: [
          {
            kind: 'section', meta: {},
            columns: [
              {
                kind: 'column',
                widgets: [
                  { kind: 'widget', blockType: 'lx_cover_image', data: { image: { alt: 'hero' } }, _mediaRefs: { image: 'k1' } },
                ],
              },
            ],
          },
        ],
      },
    ]
    const staged = resolveStagedContent({ pages, posts: [], projects: [], settings: {} }, map)
    expect(staged.pages[0]!.heroImageId).toBe(heroId)
    const widgetData = staged.pages[0]!.sections[0]!.columns[0]!.widgets[0]!.data as Record<string, Record<string, unknown>>
    expect(widgetData.image!.media_id).toBe(heroId)
    expect(widgetData.image!.alt).toBe('hero')
  })
})
