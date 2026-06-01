import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { buildBundleContent, contentGraphOf } from '@/lib/sync/serializeLocal'
import { canonicalContentHash, mediaBundleKey } from '@/lib/sync/contentHash'

const USER_ID = 9100

describe('buildBundleContent', () => {
  beforeEach(async () => {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
    for (const t of [
      'media_references',
      'content_blocks',
      'media',
      'pages',
      'posts',
      'projects',
      'settings',
    ]) {
      await db.execute(sql.raw(`TRUNCATE TABLE ${t}`))
    }
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)

    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, role, active, must_rotate_password)
      VALUES (${USER_ID}, ${`sync-${USER_ID}@test.local`}, 'x', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = VALUES(email)
    `)

    // A media row referenced by the home page hero + a widget.
    await db.execute(sql`
      INSERT INTO media (id, filename_uuid, original_name, mime_type, alt_text,
                         width, height, byte_size, variants)
      VALUES (50, 'mu50', 'hero.jpg', 'image/jpeg', 'hero', 1600, 900, 12345,
              ${JSON.stringify({
                thumb: '/uploads/variants/mu50-thumb.webp',
                md: '/uploads/variants/mu50-md.webp',
                lg: '/uploads/variants/mu50-lg.webp',
                og: '/uploads/variants/mu50-og.jpg',
              })})
    `)

    await db.execute(sql`
      INSERT INTO pages (id, slug, title, is_home, system, published, hero_image_id, version)
      VALUES (100, 'home', 'Home', true, false, true, 50, 0)
    `)

    // section -> column -> widget tree.
    await db.execute(sql`
      INSERT INTO content_blocks (id, page_id, parent_id, kind, block_type, position, data, meta, version)
      VALUES (200, 100, NULL, 'section', 'lx_section', 1000,
              ${JSON.stringify({})},
              ${JSON.stringify({ columns: 1, background: 'cream', padding: 'lg' })}, 0)
    `)
    await db.execute(sql`
      INSERT INTO content_blocks (id, page_id, parent_id, kind, block_type, position, data, version)
      VALUES (201, 100, 200, 'column', 'lx_column', 1000, ${JSON.stringify({})}, 0)
    `)
    await db.execute(sql`
      INSERT INTO content_blocks (id, page_id, parent_id, kind, block_type, position, data, version)
      VALUES (202, 100, 201, 'widget', 'lx_cover_image', 1000,
              ${JSON.stringify({ title: 'A', image: { media_id: 50, alt: 'hero' } })}, 0)
    `)
    await db.execute(sql`
      INSERT INTO media_references (media_id, referent_type, referent_id, field)
      VALUES (50, 'content_block', 202, 'image')
    `)

    await db.execute(sql`
      INSERT INTO posts (id, slug, title, body_md, published, version)
      VALUES (300, 'hello-world', 'Hello World', ${'# Hi\n\nbody'}, true, 0)
    `)
    await db.execute(sql`
      INSERT INTO projects (id, slug, name, status, published, version)
      VALUES (400, 'villa-one', 'Villa One', 'selling', true, 0)
    `)
    await db.execute(sql`
      INSERT INTO settings (\`key\`, value, version)
      VALUES ('footer', ${JSON.stringify({ tagline: 'Made with care' })}, 0),
             ('organization_json_ld', ${JSON.stringify({ name: 'Acme', logo: { media_id: 50, alt: 'logo' } })}, 0),
             ('smtp_config', ${JSON.stringify({ host: 'secret' })}, 0)
    `)
  })

  it('serializes pages as block trees with stripped media refs', async () => {
    const c = await buildBundleContent()
    const heroKey = mediaBundleKey({ originalName: 'hero.jpg', byteSize: 12345, width: 1600, height: 900, mime: 'image/jpeg' })

    expect(c.pages).toHaveLength(1)
    const page = c.pages[0]!
    expect(page.slug).toBe('home')
    expect(page.isHome).toBe(true)
    expect(page.heroImageKey).toBe(heroKey)

    const widget = page.sections[0]!.columns[0]!.widgets[0]!
    expect(widget.blockType).toBe('lx_cover_image')
    // media_id stripped, alt kept, ref lifted into _mediaRefs
    expect((widget.data.image as Record<string, unknown>).media_id).toBeUndefined()
    expect((widget.data.image as Record<string, unknown>).alt).toBe('hero')
    expect(widget._mediaRefs).toEqual({ image: heroKey })

    // No id / version fields leak into the serialized shape.
    expect(JSON.stringify(page)).not.toMatch(/"version"|"id":/)
  })

  it('includes posts, projects, and ONLY the 8 push settings keys', async () => {
    const c = await buildBundleContent()
    expect(c.posts.map((p) => p.slug)).toEqual(['hello-world'])
    expect(c.posts[0]!.bodyMd).toContain('# Hi')
    expect(c.projects.map((p) => p.slug)).toEqual(['villa-one'])
    expect(c.projects[0]!.status).toBe('selling')
    // footer + organization_json_ld are in the allowlist; smtp_config excluded.
    expect(Object.keys(c.settings).sort()).toEqual(['footer', 'organization_json_ld'])
    expect(c.settings.footer).toEqual({ tagline: 'Made with care' })
    expect(Object.keys(c.settings)).not.toContain('smtp_config')
  })

  it('lifts settings media refs (org logo) into settingsMediaRefs, stripping media_id', async () => {
    const c = await buildBundleContent()
    const logoKey = mediaBundleKey({ originalName: 'hero.jpg', byteSize: 12345, width: 1600, height: 900, mime: 'image/jpeg' })
    const org = c.settings.organization_json_ld as { logo: Record<string, unknown> }
    // media_id stripped from the value, alt kept
    expect(org.logo.media_id).toBeUndefined()
    expect(org.logo.alt).toBe('logo')
    // ref lifted to bundleKey at the json path
    expect(c.settingsMediaRefs.organization_json_ld).toEqual({ logo: logoKey })
  })

  it('emits a media entry for every referenced file', async () => {
    const c = await buildBundleContent()
    const heroKey = mediaBundleKey({ originalName: 'hero.jpg', byteSize: 12345, width: 1600, height: 900, mime: 'image/jpeg' })
    const entry = c.media.find((m) => m.bundleKey === heroKey)
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe('image')
    expect(entry!.files.md).toBe('/uploads/variants/mu50-md.webp')
  })

  it('lifts a section-meta backgroundImage media_id into _metaMediaRefs', async () => {
    // Put a cover-image media_id (50 = hero.jpg) on the section's meta, the way
    // the section-background feature stores it. Without lifting, the raw local
    // media_id would ship across installs and render a broken/wrong background.
    await db.execute(sql`
      UPDATE content_blocks
      SET meta = ${JSON.stringify({
        columns: 1,
        background: 'cream',
        padding: 'lg',
        backgroundImage: { media_id: 50, alt: 'cover' },
      })}
      WHERE id = 200
    `)
    const c = await buildBundleContent()
    const heroKey = mediaBundleKey({ originalName: 'hero.jpg', byteSize: 12345, width: 1600, height: 900, mime: 'image/jpeg' })
    const section = c.pages[0]!.sections[0]!
    expect(section._metaMediaRefs).toEqual({ backgroundImage: heroKey })
    expect((section.meta.backgroundImage as Record<string, unknown>).media_id).toBeUndefined()
    expect((section.meta.backgroundImage as Record<string, unknown>).alt).toBe('cover')
    expect(c.media.find((m) => m.bundleKey === heroKey)).toBeDefined()
  })

  it('produces a stable content hash across runs', async () => {
    const h1 = canonicalContentHash(contentGraphOf(await buildBundleContent()))
    const h2 = canonicalContentHash(contentGraphOf(await buildBundleContent()))
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(64)
  })
})
