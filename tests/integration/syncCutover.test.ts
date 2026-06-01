import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'

// Route the shared op-lock + sync-backups to a writable tmp dir.
const STATE = path.join(tmpdir(), 'cavecms-sync-cutover-state')
process.env.CAVECMS_STATE_DIR = STATE

const { runCutover } = await import('@/lib/sync/cutover')
const { putStage } = await import('@/lib/sync/stageStore')
const { buildBundleContent, contentGraphOf } = await import('@/lib/sync/serializeLocal')
const { canonicalContentHash } = await import('@/lib/sync/contentHash')
import type { StagedPayload } from '@/lib/sync/applyBundle'

const USER = 9300

async function liveHash(): Promise<string> {
  return canonicalContentHash(contentGraphOf(await buildBundleContent()))
}

function payload(): StagedPayload {
  return {
    pages: [
      { slug: 'home', title: 'NEW Home', isHome: true, system: false, published: true,
        seoTitle: null, seoDescription: null, ogImageId: null, heroImageId: null,
        sections: [{ meta: {}, columns: [{ meta: null, widgets: [
          { blockType: 'lx_text', blockKey: null, data: { body_richtext: '<p>pushed</p>' }, meta: null },
        ] }] }] },
      { slug: 'about', title: 'About', isHome: false, system: false, published: true,
        seoTitle: null, seoDescription: null, ogImageId: null, heroImageId: null, sections: [] },
    ],
    posts: [],
    projects: [],
    settings: { footer: { tagline: 'pushed' } },
  }
}

describe('runCutover', () => {
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
      VALUES (${USER}, ${`cut-${USER}@test.local`}, 'x', 'admin', true, false)
      ON DUPLICATE KEY UPDATE email = VALUES(email)
    `)
    await db.execute(sql`INSERT INTO pages (id, slug, title, is_home, published, version) VALUES (1, 'home', 'OLD', true, true, 0)`)
    await db.execute(sql`INSERT INTO settings (\`key\`, value, version) VALUES ('footer', ${JSON.stringify({ tagline: 'OLD' })}, 0)`)
  })

  it('cuts over on a matching baseline, replaces content, retains a backup', async () => {
    const baseline = await liveHash()
    const stageId = await putStage(payload(), 'abc123def456', baseline, USER)
    const out = await runCutover({ stageId }, { userId: USER })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.swapped.pages).toBe(2)
    expect(existsSync(out.backupArtifact)).toBe(true)

    const [pages] = (await db.execute(sql`SELECT slug, title FROM pages ORDER BY slug`)) as unknown as [Array<{ slug: string; title: string }>]
    expect(pages.map((p) => p.slug)).toEqual(['about', 'home'])
    expect(pages.find((p) => p.slug === 'home')!.title).toBe('NEW Home')

    // stage consumed
    const [stages] = (await db.execute(sql`SELECT id FROM sync_stage WHERE id = ${stageId}`)) as unknown as [unknown[]]
    expect(stages.length).toBe(0)
  })

  it('refuses on drift (baseline != live) and writes nothing', async () => {
    const stageId = await putStage(payload(), 'abc123def456', 'staleHashThatWontMatch', USER)
    const out = await runCutover({ stageId }, { userId: USER })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('drift_detected')

    // prod untouched
    const [pages] = (await db.execute(sql`SELECT slug, title FROM pages`)) as unknown as [Array<{ slug: string; title: string }>]
    expect(pages).toEqual([{ slug: 'home', title: 'OLD' }])
    // stage NOT consumed (operator can retry with --force)
    const [stages] = (await db.execute(sql`SELECT id FROM sync_stage WHERE id = ${stageId}`)) as unknown as [unknown[]]
    expect(stages.length).toBe(1)
  })

  it('--force overrides drift', async () => {
    const stageId = await putStage(payload(), 'abc123def456', 'staleHash', USER)
    const out = await runCutover({ stageId, force: true }, { userId: USER })
    expect(out.ok).toBe(true)
  })
})
