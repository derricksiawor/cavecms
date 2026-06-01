import { describe, it, expect, beforeEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

process.env.CAVECMS_STATE_DIR = path.join(tmpdir(), 'cavecms-sync-http-state')

vi.mock('@/lib/auth/requireRole', async (orig) => {
  const a = await orig<typeof import('@/lib/auth/requireRole')>()
  return { ...a, requireRole: vi.fn(async () => ({ userId: 9400, role: 'admin', email: 'e', jti: 'j', oat: 0, iat: 0, pwp: false, viaApiToken: true })) }
})
vi.mock('@/lib/auth/requireCsrf', () => ({ requireCsrf: async () => {} }))
vi.mock('@/lib/auth/cmsRateLimit', () => ({ checkMutationRate: () => {}, checkReadRate: () => {} }))

const { POST: stagePOST } = await import('@/app/api/cms/sync/stage/route')
const { POST: cutoverPOST } = await import('@/app/api/cms/sync/cutover/route')
const { canonicalContentHash, mediaBundleKey } = await import('@/lib/sync/contentHash')
const { toContentGraph } = await import('@/lib/sync/contentGraph')

function buildTarball(): Buffer {
  const heroKey = mediaBundleKey({ originalName: 'hero.jpg', byteSize: 9, width: 4, height: 2, mime: 'image/jpeg' })
  const pages = [
    {
      slug: 'home', title: 'Pushed Home', isHome: true, system: false, published: true,
      seoTitle: null, seoDescription: null, ogImageKey: null, heroImageKey: heroKey,
      sections: [
        { kind: 'section', meta: { columns: 1, background: 'cream', padding: 'lg' }, columns: [
          { kind: 'column', widgets: [
            { kind: 'widget', blockType: 'lx_text', data: { body_richtext: '<p>pushed</p>' } },
            { kind: 'widget', blockType: 'lx_cover_image', data: { image: { alt: 'hero' } }, _mediaRefs: { image: heroKey } },
          ] },
        ] },
      ],
    },
  ]
  const content = { pages, posts: [], projects: [], settings: { social_links: [{ platform: 'instagram', url: 'https://instagram.com/acme' }] } }
  const contentHash = canonicalContentHash(
    toContentGraph(content as unknown as Parameters<typeof toContentGraph>[0]),
  )
  const media = [
    { bundleKey: heroKey, originalName: 'hero.jpg', mime: 'image/jpeg', alt: 'hero', width: 4, height: 2, byteSize: 9, kind: 'image',
      files: { thumb: 'media/files/h-thumb.webp', md: 'media/files/h-md.webp', lg: 'media/files/h-lg.webp', og: 'media/files/h-og.jpg' } },
  ]
  const manifest = {
    formatVersion: 1, createdAt: '2026-06-01T00:00:00.000Z', sourceUrl: 'http://localhost:3040',
    baselineContentHash: null, contentHash, counts: { pages: 1, posts: 0, projects: 0, media: 1, settings: 1 },
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'cavecms-bundle-'))
  mkdirSync(path.join(dir, 'content'), { recursive: true })
  mkdirSync(path.join(dir, 'media', 'files'), { recursive: true })
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(path.join(dir, 'content', 'pages.json'), JSON.stringify(pages))
  writeFileSync(path.join(dir, 'content', 'posts.json'), '[]')
  writeFileSync(path.join(dir, 'content', 'projects.json'), '[]')
  writeFileSync(path.join(dir, 'content', 'settings.json'), JSON.stringify(content.settings))
  writeFileSync(path.join(dir, 'media', 'manifest.json'), JSON.stringify(media))
  for (const n of ['h-thumb.webp', 'h-md.webp', 'h-lg.webp', 'h-og.jpg']) writeFileSync(path.join(dir, 'media', 'files', n), 'imgbytes')
  const tgz = path.join(dir, 'b.tgz')
  const r = spawnSync('tar', ['-czf', tgz, '-C', dir, 'manifest.json', 'content', 'media'])
  if (r.status !== 0) throw new Error('tar failed')
  return readFileSync(tgz)
}

async function rows<T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  const [r] = (await db.execute(q)) as unknown as [T[]]
  return r
}

describe('sync stage→cutover over HTTP', () => {
  beforeEach(async () => {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
    for (const t of ['media_references', 'content_blocks', 'media', 'pages', 'posts', 'projects', 'settings', 'audit_log', 'sync_stage']) {
      await db.execute(sql.raw(`TRUNCATE TABLE ${t}`))
    }
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, active, must_rotate_password) VALUES (9400, 'e@x', 'x', 'admin', true, false) ON DUPLICATE KEY UPDATE email=VALUES(email)`)
    await db.execute(sql`INSERT INTO pages (id, slug, title, is_home, published, version) VALUES (1, 'home', 'OLD', true, true, 0)`)
  })

  it('stages a real tarball then cuts over, replacing content + uploading media', async () => {
    const fd = new FormData()
    fd.set('bundle', new File([new Uint8Array(buildTarball())], 'b.tgz', { type: 'application/gzip' }))
    const stageRes = await stagePOST(new Request('http://local/api/cms/sync/stage', { method: 'POST', body: fd }), {})
    expect(stageRes.status).toBe(200)
    const stageBody = await stageRes.json()
    expect(stageBody.ok).toBe(true)
    const stageId = stageBody.stageId

    // media uploaded (additive) at stage time
    expect((await rows(sql`SELECT id FROM media`)).length).toBe(1)
    // live content NOT yet changed
    expect((await rows<{ title: string }>(sql`SELECT title FROM pages`))[0]!.title).toBe('OLD')

    const cutRes = await cutoverPOST(
      new Request('http://local/api/cms/sync/cutover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stageId }),
      }),
      {},
    )
    expect(cutRes.status).toBe(200)
    const cut = await cutRes.json()
    expect(cut.ok).toBe(true)

    const pages = await rows<{ slug: string; title: string }>(sql`SELECT slug, title FROM pages`)
    expect(pages[0]!.title).toBe('Pushed Home')
    // cover image media_id injected + media_reference present
    const cb = await rows(sql`SELECT 1 FROM media_references WHERE referent_type='content_block' AND field='image'`)
    expect(cb.length).toBe(1)
    const sl = await rows<{ value: unknown }>(sql`SELECT value FROM settings WHERE \`key\`='social_links'`)
    expect(typeof sl[0]!.value === 'string' ? JSON.parse(sl[0]!.value as string) : sl[0]!.value).toEqual([
      { platform: 'instagram', url: 'https://instagram.com/acme' },
    ])
  })
})
