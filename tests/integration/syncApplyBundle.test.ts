import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { applyBundle, type StagedPayload } from '@/lib/sync/applyBundle'

const USER = 9200

async function rows<T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  const [r] = (await db.execute(q)) as unknown as [T[]]
  return r
}

async function seedExisting() {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
  for (const t of ['media_references', 'content_blocks', 'media', 'pages', 'posts', 'project_sections', 'projects', 'settings', 'audit_log', 'leads']) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${t}`))
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)

  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
    VALUES (${USER}, ${`cut-${USER}@test.local`}, 'x', 'admin', true, false)
    ON DUPLICATE KEY UPDATE email = VALUES(email)
  `)
  await db.execute(sql`
    INSERT INTO media (id, filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, variants)
    VALUES (50, 'mu50', 'hero.jpg', 'image/jpeg', 'hero', 1600, 900, 1, ${JSON.stringify({ md: '/uploads/variants/mu50-md.webp' })})
  `)

  // EXISTING prod content that the cutover should wholesale-replace.
  await db.execute(sql`INSERT INTO pages (id, slug, title, is_home, published, version) VALUES (1, 'home', 'OLD Home', true, true, 0)`)
  await db.execute(sql`INSERT INTO pages (id, slug, title, is_home, published, version) VALUES (2, 'oldpage', 'Gone Soon', false, true, 0)`)
  await db.execute(sql`INSERT INTO content_blocks (id, page_id, parent_id, kind, block_type, position, data, version) VALUES (10, 1, NULL, 'widget', 'lx_text', 1000, ${JSON.stringify({ body_richtext: '<p>old</p>' })}, 0)`)
  await db.execute(sql`INSERT INTO posts (id, slug, title, body_md, published, version) VALUES (20, 'old-post', 'Old Post', 'old', true, 0)`)

  // Two projects: villa-one will be UPDATED, keepme is absent from the bundle
  // and MUST survive (upsert, never delete → no cascade to project_sections).
  await db.execute(sql`INSERT INTO projects (id, slug, name, status, published, version) VALUES (30, 'villa-one', 'OLD Villa', 'selling', true, 0)`)
  await db.execute(sql`INSERT INTO projects (id, slug, name, status, published, version) VALUES (31, 'keepme', 'Keep Me', 'sold_out', true, 0)`)
  await db.execute(sql`INSERT INTO project_sections (id, project_id, section_key, position, data, version) VALUES (40, 30, 'hero', 1000, ${JSON.stringify({ x: 1 })}, 0)`)
  await db.execute(sql`INSERT INTO project_sections (id, project_id, section_key, position, data, version) VALUES (41, 31, 'hero', 1000, ${JSON.stringify({ x: 2 })}, 0)`)

  // Settings: one in-allowlist (footer), one security key that must NEVER change.
  await db.execute(sql`INSERT INTO settings (\`key\`, value, version) VALUES ('footer', ${JSON.stringify({ tagline: 'OLD' })}, 0)`)
  await db.execute(sql`INSERT INTO settings (\`key\`, value, version) VALUES ('security_login_path', ${JSON.stringify({ path: 'secret123' })}, 0)`)

  // A lead row that must be untouched.
  await db.execute(sql`INSERT INTO leads (id, source, email, status) VALUES (60, 'contact', 'lead@x.com', 'new')`)
}

function payload(): StagedPayload {
  return {
    pages: [
      {
        slug: 'home',
        title: 'NEW Home',
        isHome: true,
        system: false,
        published: true,
        seoTitle: null,
        seoDescription: null,
        ogImageId: null,
        heroImageId: 50,
        sections: [
          {
            meta: { columns: 1, background: 'cream', padding: 'lg' },
            columns: [
              {
                meta: null,
                widgets: [
                  { blockType: 'lx_text', blockKey: null, data: { body_richtext: '<p>new home</p>' }, meta: null },
                  { blockType: 'lx_cover_image', blockKey: null, data: { image: { media_id: 50, alt: 'hero' } }, meta: null },
                ],
              },
            ],
          },
        ],
      },
      {
        slug: 'about',
        title: 'About',
        isHome: false,
        system: false,
        published: true,
        seoTitle: null,
        seoDescription: null,
        ogImageId: null,
        heroImageId: null,
        sections: [],
      },
    ],
    posts: [
      {
        slug: 'new-post',
        title: 'New Post',
        excerpt: null,
        bodyMd: '# New',
        published: true,
        seoTitle: null,
        seoDescription: null,
        heroImageId: null,
        ogImageId: null,
        bodyMediaIds: [],
      },
    ],
    projects: [
      {
        slug: 'villa-one',
        name: 'NEW Villa',
        tagline: null,
        status: 'sold_out',
        location: null,
        featuredOrder: null,
        published: true,
        seoTitle: null,
        seoDescription: null,
        heroImageId: 50,
        brochurePdfId: null,
        ogImageId: null,
      },
    ],
    // smtp_config is out of the allowlist — applyBundle must ignore it.
    settings: { footer: { tagline: 'NEW' }, smtp_config: { host: 'evil' } },
  }
}

describe('applyBundle cutover', () => {
  beforeEach(seedExisting)

  it('wholesale-replaces pages/posts, upserts projects, never touches the rest', async () => {
    const result = await applyBundle(payload(), { userId: USER })
    expect(result).toEqual({ pages: 2, posts: 1, projects: 1, settings: 1 })

    // pages wholesale-replaced: home (new) + about; oldpage gone.
    const pages = await rows<{ slug: string; title: string }>(sql`SELECT slug, title FROM pages ORDER BY slug`)
    expect(pages.map((p) => p.slug)).toEqual(['about', 'home'])
    expect(pages.find((p) => p.slug === 'home')!.title).toBe('NEW Home')

    // home block tree present (section -> column -> 2 widgets).
    const blocks = await rows<{ kind: string; block_type: string }>(sql`
      SELECT cb.kind, cb.block_type FROM content_blocks cb
      JOIN pages p ON p.id = cb.page_id WHERE p.slug = 'home' ORDER BY cb.position`)
    expect(blocks.filter((b) => b.kind === 'widget').map((b) => b.block_type)).toEqual(['lx_text', 'lx_cover_image'])

    // posts wholesale-replaced.
    const posts = await rows<{ slug: string }>(sql`SELECT slug FROM posts`)
    expect(posts.map((p) => p.slug)).toEqual(['new-post'])

    // villa-one UPDATED; keepme SURVIVES (upsert, not delete).
    const projects = await rows<{ slug: string; name: string }>(sql`SELECT slug, name FROM projects ORDER BY slug`)
    expect(projects.map((p) => p.slug)).toEqual(['keepme', 'villa-one'])
    expect(projects.find((p) => p.slug === 'villa-one')!.name).toBe('NEW Villa')

    // project_sections for BOTH projects survive (no cascade delete).
    const psecs = await rows<{ project_id: number }>(sql`SELECT project_id FROM project_sections ORDER BY project_id`)
    expect(psecs.map((p) => p.project_id)).toEqual([30, 31])

    // settings: footer updated, smtp_config NOT created, security_login_path UNCHANGED.
    const settings = await rows<{ key: string; value: unknown }>(sql`SELECT \`key\`, value FROM settings ORDER BY \`key\``)
    const byKey = Object.fromEntries(settings.map((s) => [s.key, typeof s.value === 'string' ? JSON.parse(s.value) : s.value]))
    expect(byKey.footer).toEqual({ tagline: 'NEW' })
    expect(byKey.smtp_config).toBeUndefined()
    expect(byKey.security_login_path).toEqual({ path: 'secret123' })

    // users + leads untouched.
    expect((await rows(sql`SELECT id FROM users WHERE id = ${USER}`)).length).toBe(1)
    const leads = await rows<{ email: string; status: string }>(sql`SELECT email, status FROM leads`)
    expect(leads).toEqual([{ email: 'lead@x.com', status: 'new' }])

    // media_references re-derived: content_block ref for the cover image + page hero.
    const cbRef = await rows(sql`SELECT 1 FROM media_references WHERE referent_type='content_block' AND media_id=50 AND field='image'`)
    expect(cbRef.length).toBe(1)
    const pageRef = await rows(sql`SELECT 1 FROM media_references WHERE referent_type='page' AND media_id=50 AND field='hero_image_id'`)
    expect(pageRef.length).toBe(1)

    // exactly one audit row for the cutover.
    const audit = await rows<{ action: string }>(sql`SELECT action FROM audit_log WHERE action='sync.cutover'`)
    expect(audit.length).toBe(1)
  })

  it('reverse-indexes media carried in section meta (backgroundImage cover)', async () => {
    const p = payload()
    // Section cover-image background: the resolved meta carries the prod media_id.
    p.pages[0]!.sections[0]!.meta = {
      columns: 1,
      background: 'cream',
      padding: 'lg',
      backgroundImage: { media_id: 50, alt: 'cover' },
    }
    await applyBundle(p, { userId: USER })
    // A media_references row for the SECTION's meta image must exist (so the
    // un-quarantine step makes a freshly-pushed cover image live + the reverse
    // index is correct) — distinct from the widget's 'image' ref.
    const metaRef = await rows(
      sql`SELECT 1 FROM media_references WHERE referent_type='content_block' AND media_id=50 AND field='backgroundImage'`,
    )
    expect(metaRef.length).toBe(1)
    // The section block's stored meta retains the media_id (so it renders).
    const sec = await rows<{ meta: unknown }>(
      sql`SELECT meta FROM content_blocks WHERE kind='section' LIMIT 1`,
    )
    const meta = typeof sec[0]!.meta === 'string' ? JSON.parse(sec[0]!.meta as string) : sec[0]!.meta
    expect((meta as { backgroundImage: { media_id: number } }).backgroundImage.media_id).toBe(50)
  })

  it('rolls back atomically when a widget is invalid — prod untouched', async () => {
    const bad = payload()
    // body_richtext must be a string; a number throws inside the transaction.
    ;(bad.pages[0]!.sections[0]!.columns[0]!.widgets[0]!.data as Record<string, unknown>).body_richtext = 123

    await expect(applyBundle(bad, { userId: USER })).rejects.toBeTruthy()

    // The DELETEs ran inside the aborted txn — assert they rolled back.
    const pages = await rows<{ slug: string; title: string }>(sql`SELECT slug, title FROM pages ORDER BY slug`)
    expect(pages.map((p) => p.slug)).toEqual(['home', 'oldpage'])
    expect(pages.find((p) => p.slug === 'home')!.title).toBe('OLD Home')
    expect((await rows(sql`SELECT id FROM posts`)).length).toBe(1)
    expect((await rows(sql`SELECT action FROM audit_log WHERE action='sync.cutover'`)).length).toBe(0)
  })
})
