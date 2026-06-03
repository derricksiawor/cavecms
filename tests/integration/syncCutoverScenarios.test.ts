import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

// Isolate the op-lock + content backups in a writable tmp dir (per file).
const STATE = path.join(tmpdir(), 'cavecms-sync-scenarios-state')
process.env.CAVECMS_STATE_DIR = STATE

const { runCutover } = await import('@/lib/sync/cutover')
const { putStage, PayloadTooLargeError } = await import('@/lib/sync/stageStore')
const { provisionBundleMedia, resolveStagedContent } = await import('@/lib/sync/mediaRemap')
const { buildBundleContent, contentGraphOf } = await import('@/lib/sync/serializeLocal')
const { canonicalContentHash } = await import('@/lib/sync/contentHash')
const { PATHS } = await import('@/lib/media/storage')
import type {
  MediaBundleEntryT,
  PageBundleT,
  ProjectBundleT,
} from '@/lib/sync/bundleTypes'

const USER = 9400

async function liveHash(): Promise<string> {
  return canonicalContentHash(contentGraphOf(await buildBundleContent()))
}

function homePage(title: string): PageBundleT {
  return {
    slug: 'home', title, isHome: true, system: false, published: true,
    seoTitle: null, seoDescription: null, ogImageKey: null, heroImageKey: null, sections: [],
  }
}

beforeAll(async () => {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
  await db.execute(sql`TRUNCATE TABLE sync_stage`)
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
})

beforeEach(async () => {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
  for (const t of ['media_references', 'content_blocks', 'media', 'pages', 'posts', 'projects', 'settings', 'audit_log', 'sync_stage']) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${t}`))
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (${USER}, ${`scn-${USER}@test.local`}, 'x', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
  await db.execute(sql`INSERT INTO pages (id, slug, title, is_home, published, version) VALUES (1, 'home', 'OLD', true, true, 0)`)
})

// ── #22b — a brochure PDF survives a push and goes live on the target ───────
describe('cutover: PDF brochure end-to-end', () => {
  it('provisions a project brochure PDF, un-quarantines it, reverse-indexes it', async () => {
    const bundleDir = path.join(tmpdir(), 'cavecms-scn-pdf-bundle')
    rmSync(bundleDir, { recursive: true, force: true })
    mkdirSync(path.join(bundleDir, 'media', 'files'), { recursive: true })
    const pdfBytes = Buffer.from('%PDF-1.4 fake brochure bytes')
    writeFileSync(path.join(bundleDir, 'media', 'files', 'brochure.pdf'), pdfBytes)
    const contentHash = createHash('sha256').update(pdfBytes).digest('hex')

    const pdfEntry: MediaBundleEntryT = {
      bundleKey: 'pdfkey0000000001', originalName: 'brochure.pdf', mime: 'application/pdf',
      alt: 'Villa brochure', width: null, height: null, byteSize: pdfBytes.byteLength,
      contentHash, kind: 'pdf', files: { pdf: 'media/files/brochure.pdf' },
    }
    const project: ProjectBundleT = {
      slug: 'villa-azul', name: 'Villa Azul', tagline: null, status: 'selling',
      location: null, featuredOrder: null, published: true, seoTitle: null,
      seoDescription: null, heroImageKey: null, brochurePdfKey: 'pdfkey0000000001', ogImageKey: null,
    }

    const baseline = await liveHash()
    const written: string[] = []
    // Mirror the stage route: provision media + stage row in ONE transaction.
    const { stageId, mediaId, uuid } = await db.transaction(async (tx) => {
      const keyToMedia = await provisionBundleMedia(tx, [pdfEntry], bundleDir, written)
      const resolved = keyToMedia.get('pdfkey0000000001')!
      const staged = resolveStagedContent(
        { pages: [homePage('Home')], posts: [], projects: [project], settings: {} },
        keyToMedia,
      )
      const id = await putStage(staged, 'pdfpush000001', baseline, USER, tx)
      return { stageId: id, mediaId: resolved.mediaId, uuid: resolved.uuid }
    })

    // The freshly provisioned PDF is quarantined (soft-deleted) until cutover.
    const [pre] = (await db.execute(sql`SELECT deleted_at FROM media WHERE id = ${mediaId}`)) as unknown as [Array<{ deleted_at: unknown }>]
    expect(pre[0]!.deleted_at).not.toBeNull()

    const out = await runCutover({ stageId }, { userId: USER })
    expect(out.ok).toBe(true)

    // Project row points at the provisioned media id…
    const [projRows] = (await db.execute(sql`SELECT brochure_pdf_id FROM projects WHERE slug = 'villa-azul'`)) as unknown as [Array<{ brochure_pdf_id: number | null }>]
    expect(projRows[0]!.brochure_pdf_id).toBe(mediaId)

    // …the media row is now LIVE (un-quarantined)…
    const [mediaRows] = (await db.execute(sql`SELECT deleted_at, mime_type FROM media WHERE id = ${mediaId}`)) as unknown as [Array<{ deleted_at: unknown; mime_type: string }>]
    expect(mediaRows[0]!.deleted_at).toBeNull()
    expect(mediaRows[0]!.mime_type).toBe('application/pdf')

    // …the PDF file is on disk in the private brochures dir…
    expect(existsSync(path.join(PATHS.brochures, `${uuid}.pdf`))).toBe(true)

    // …and it's reverse-indexed so a later media-delete guard sees the reference.
    const [refs] = (await db.execute(sql`
      SELECT 1 AS x FROM media_references
      WHERE referent_type = 'project' AND field = 'brochure_pdf_id' AND media_id = ${mediaId}
    `)) as unknown as [Array<unknown>]
    expect(refs.length).toBe(1)

    rmSync(bundleDir, { recursive: true, force: true })
  })
})

// ── #22c — two concurrent cutovers: the op-lock serializes them ─────────────
describe('cutover: concurrent op-lock', () => {
  it('serializes two simultaneous cutovers — one applies, one is busy', async () => {
    const baseline = await liveHash()
    // Route through resolveStagedContent so each page carries the resolved
    // StagedPage shape (ogImageId/heroImageId), exactly as the stage route feeds
    // putStage — not the raw PageBundle (ogImageKey/heroImageKey) shape.
    const stagedOf = (title: string) =>
      resolveStagedContent({ pages: [homePage(title)], posts: [], projects: [], settings: {} }, new Map())
    const stageA = await putStage(stagedOf('A-WIN'), 'concA000001', baseline, USER)
    const stageB = await putStage(stagedOf('B-WIN'), 'concB000001', baseline, USER)

    const [resA, resB] = await Promise.all([
      runCutover({ stageId: stageA }, { userId: USER }),
      runCutover({ stageId: stageB }, { userId: USER }),
    ])

    const oks = [resA, resB].filter((r) => r.ok)
    const busy = [resA, resB].filter((r) => !r.ok && r.reason === 'busy')
    expect(oks.length).toBe(1) // exactly one applied
    expect(busy.length).toBe(1) // the other was locked out

    // The live home title matches whichever push won.
    const winnerTitle = resA.ok ? 'A-WIN' : 'B-WIN'
    const [pages] = (await db.execute(sql`SELECT title FROM pages WHERE slug = 'home'`)) as unknown as [Array<{ title: string }>]
    expect(pages[0]!.title).toBe(winnerTitle)

    // The loser's stage survives (operator can simply re-run it).
    const loserStage = resA.ok ? stageB : stageA
    const [stageRows] = (await db.execute(sql`SELECT id FROM sync_stage WHERE id = ${loserStage}`)) as unknown as [Array<unknown>]
    expect(stageRows.length).toBe(1)
  })
})

// ── #22d — a large content set cuts over; the byte cap rejects an over-limit one ──
describe('cutover: scale', () => {
  it('applies a 250-page push atomically', async () => {
    const pages: PageBundleT[] = [homePage('Home')]
    for (let i = 1; i < 250; i++) {
      pages.push({
        slug: `page-${i}`, title: `Page ${i}`, isHome: false, system: false, published: true,
        seoTitle: null, seoDescription: null, ogImageKey: null, heroImageKey: null,
        sections: [
          { kind: 'section', meta: {}, columns: [
            { kind: 'column', widgets: [
              { kind: 'widget', blockType: 'lx_text', blockKey: null, data: { body_richtext: `<p>body ${i}</p>` } },
            ] },
          ] },
        ],
      })
    }
    const baseline = await liveHash()
    const staged = resolveStagedContent({ pages, posts: [], projects: [], settings: {} }, new Map())
    const stageId = await putStage(staged, 'scale0000001', baseline, USER)

    const startedAt = Date.now()
    const out = await runCutover({ stageId }, { userId: USER })
    const elapsedMs = Date.now() - startedAt

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.swapped.pages).toBe(250)
    const [[{ c }]] = (await db.execute(sql`SELECT COUNT(*) c FROM pages WHERE deleted_at IS NULL`)) as unknown as [[{ c: number }]]
    expect(Number(c)).toBe(250)
    // Generous ceiling — a 250-page atomic swap must not be pathologically slow.
    expect(elapsedMs).toBeLessThan(45_000)
  }, 60_000)

  it('rejects a staged payload over the 48MB byte cap before it can blow max_allowed_packet', async () => {
    const huge = 'x'.repeat(49 * 1024 * 1024) // > MAX_PAYLOAD_BYTES (48MB)
    const staged = resolveStagedContent(
      {
        pages: [{
          ...homePage('Home'),
          sections: [
            { kind: 'section', meta: {}, columns: [
              { kind: 'column', widgets: [
                { kind: 'widget', blockType: 'lx_text', blockKey: null, data: { body_richtext: huge } },
              ] },
            ] },
          ],
        }],
        posts: [], projects: [], settings: {},
      },
      new Map(),
    )
    await expect(putStage(staged, 'toobig000001', 'baseline', USER)).rejects.toThrow(PayloadTooLargeError)
  })
})
