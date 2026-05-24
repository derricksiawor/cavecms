import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { PATHS, tmpDirFor, writeFinal, cleanupTmp } from '@/lib/media/storage'
import { processImage } from '@/lib/media/sharp'

const TEST_ROOT = process.env['UPLOADS_ROOT']

describe('media storage + sharp pipeline', () => {
  beforeAll(async () => {
    if (!TEST_ROOT) throw new Error('UPLOADS_ROOT not set; .env.local must define it')
    // Provision the same four subdirs that setup.sh would.
    for (const d of [PATHS.tmp, PATHS.originals, PATHS.variants, PATHS.brochures]) {
      await mkdir(d, { recursive: true, mode: 0o750 })
    }
  })

  afterAll(async () => {
    // Wipe everything we wrote under the test root.
    if (TEST_ROOT) await rm(TEST_ROOT, { recursive: true, force: true })
  })

  it('processes a real JPEG into thumb/md/lg webp + og jpg', async () => {
    // Build a 200x200 red JPEG in-process (sharp generates it from raw RGB).
    const jpeg = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 200, g: 30, b: 30 },
      },
    })
      .jpeg()
      .toBuffer()

    const uuid = 'test-uuid-process-1'
    const tmpDir = await tmpDirFor(uuid)
    const out = await processImage(jpeg, tmpDir, uuid, 'image/jpeg')
    expect(out.width).toBe(200)
    expect(out.height).toBe(200)

    // All four variant files exist on disk under tmpDir.
    for (const kind of ['thumb', 'md', 'lg'] as const) {
      const s = await stat(path.join(tmpDir, `${kind}.webp`))
      expect(s.size).toBeGreaterThan(0)
    }
    const ogStat = await stat(path.join(tmpDir, 'og.jpg'))
    expect(ogStat.size).toBeGreaterThan(0)

    // URL paths point at /uploads/variants/<uuid>-* — the renderer's expected
    // prefix (matches what nginx serves).
    expect(out.variants.thumb).toBe(`/uploads/variants/${uuid}-thumb.webp`)
    expect(out.variants.og).toBe(`/uploads/variants/${uuid}-og.jpg`)

    await cleanupTmp(uuid)
  })

  it('rejects an image declared at zero dims', async () => {
    // Sharp can't actually produce a 0x0 image cleanly; instead pass a
    // malformed buffer that fileType detected as image but sharp can't decode.
    const garbage = Buffer.from('not an actual image, just noise')
    await expect(
      processImage(garbage, '/tmp', 'never', 'image/jpeg'),
    ).rejects.toBeTruthy()
  })

  it('rejects a polyglot: PNG buffer claimed as JPEG (sniff/format mismatch)', async () => {
    // Build a real PNG, then call processImage claiming it is image/jpeg.
    // sharp decodes as 'png' so the mismatch guard fires before any IO.
    const png = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer()
    const uuid = 'test-uuid-polyglot-1'
    const tmpDir = await tmpDirFor(uuid)
    await expect(
      processImage(png, tmpDir, uuid, 'image/jpeg'),
    ).rejects.toMatchObject({ name: 'MimeFormatMismatchError' })
    await cleanupTmp(uuid)
  })

  it('writeFinal atomically renames a temp file into the final tree', async () => {
    const uuid = 'test-uuid-rename-1'
    const tmpDir = await tmpDirFor(uuid)
    const src = path.join(tmpDir, 'sample.txt')
    const dest = path.join(PATHS.variants, `${uuid}-sample.txt`)
    await (await import('node:fs/promises')).writeFile(src, 'hello', { mode: 0o640 })

    await writeFinal(src, dest)

    // Source gone, destination present with the expected contents.
    await expect(stat(src)).rejects.toBeTruthy()
    expect(await readFile(dest, 'utf8')).toBe('hello')

    await cleanupTmp(uuid)
    await rm(dest, { force: true })
  })

  it('strips EXIF metadata from processed variants', async () => {
    // Build a JPEG with synthetic EXIF (sharp's withExifMerge stamps it).
    // The image goes in with EXIF; processImage must come out without.
    const jpegWithExif = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    })
      .withExif({
        IFD0: {
          ImageDescription: 'sensitive author info',
          Make: 'CameraMaker',
        },
      })
      .jpeg()
      .toBuffer()

    // Confirm the source HAS EXIF (sanity).
    const srcMeta = await sharp(jpegWithExif).metadata()
    expect(srcMeta.exif).toBeDefined()

    const uuid = 'test-uuid-exif-strip-1'
    const tmpDir = await tmpDirFor(uuid)
    await processImage(jpegWithExif, tmpDir, uuid, 'image/jpeg')

    // Every WebP variant must report NO exif. Reading from disk because
    // processImage writes the variants there.
    for (const kind of ['thumb', 'md', 'lg'] as const) {
      const out = await sharp(`${tmpDir}/${kind}.webp`).metadata()
      expect(out.exif, `${kind} should have no exif`).toBeUndefined()
    }
    const og = await sharp(`${tmpDir}/og.jpg`).metadata()
    expect(og.exif, 'og.jpg should have no exif').toBeUndefined()

    await cleanupTmp(uuid)
  })

  it('cleanupTmp removes the per-upload tmp directory', async () => {
    const uuid = 'test-uuid-cleanup-1'
    const tmpDir = await tmpDirFor(uuid)
    await (await import('node:fs/promises')).writeFile(
      path.join(tmpDir, 'sentinel'),
      'x',
    )
    await cleanupTmp(uuid)
    await expect(stat(tmpDir)).rejects.toBeTruthy()
  })
})
