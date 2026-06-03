// The atomic content cutover. ONE InnoDB transaction that wholesale-replaces
// pages/content_blocks/posts and upserts projects/settings from a staged,
// media-resolved payload. All-or-nothing: any throw rolls the whole thing back
// and prod is byte-identical to before. Users, secrets, leads, analytics,
// security_* settings, and the legacy project_sections layer are physically
// never in the write set.
//
// FK checks are disabled INSIDE the transaction only (bracketing the DML) so
// children can be deleted before parents and re-inserted parents-first.

import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { parseAndSanitize } from '@/lib/cms/parse'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { env } from '@/lib/env'
import { PUSH_SETTING_KEYS } from './bundleTypes'

const STATEMENT_TIMEOUT_SEC = env.DB_STATEMENT_TIMEOUT_MS / 1000

const POS_STEP = 1000

// Insert-ready, media-resolved payload (every bundleKey already mapped to a
// real prod media_id by the stage step). This is the cutover's input contract.
export interface StagedWidget {
  blockType: string
  blockKey: string | null
  data: Record<string, unknown>
  meta: Record<string, unknown> | null
}
export interface StagedColumn {
  meta: Record<string, unknown> | null
  widgets: StagedWidget[]
}
export interface StagedSection {
  meta: Record<string, unknown>
  columns: StagedColumn[]
}
export interface StagedPage {
  slug: string
  title: string
  isHome: boolean
  system: boolean
  published: boolean
  seoTitle: string | null
  seoDescription: string | null
  ogImageId: number | null
  heroImageId: number | null
  sections: StagedSection[]
}
export interface StagedPost {
  slug: string
  title: string
  excerpt: string | null
  bodyMd: string
  published: boolean
  seoTitle: string | null
  seoDescription: string | null
  heroImageId: number | null
  ogImageId: number | null
  // Media referenced by inline images in the markdown body (already remapped to
  // target ids at stage time) — reverse-indexed so the un-quarantine makes them
  // live.
  bodyMediaIds: number[]
}
export interface StagedProject {
  slug: string
  name: string
  tagline: string | null
  status: string
  location: string | null
  featuredOrder: number | null
  published: boolean
  seoTitle: string | null
  seoDescription: string | null
  heroImageId: number | null
  brochurePdfId: number | null
  ogImageId: number | null
}
export interface StagedPayload {
  pages: StagedPage[]
  posts: StagedPost[]
  projects: StagedProject[]
  settings: Record<string, unknown>
}

export interface CutoverResult {
  pages: number
  posts: number
  projects: number
  settings: number
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function insertRef(
  tx: Tx,
  refType: 'content_block' | 'page' | 'post' | 'project',
  refId: number,
  field: string,
  mediaId: number,
): Promise<void> {
  await tx.execute(sql`
    INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
    VALUES (${mediaId}, ${refType}, ${refId}, ${field})
  `)
}

export async function applyBundle(
  payload: StagedPayload,
  ctx: { userId: number; tokenId?: number | null },
): Promise<CutoverResult> {
  await db.transaction(async (tx) => {
    // The session-var SETs live INSIDE the try so the `finally` restore ALWAYS
    // runs — even if a SET itself throws. (FK checks disabled here would
    // otherwise ride the pooled connection into unrelated later queries.) SET is
    // a session var, not rolled back by the transaction abort, so the explicit
    // restore is both necessary and safe.
    try {
      await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`)
      // Raise the per-statement SELECT cap for the swap (a large DELETE/INSERT
      // legitimately runs longer than the pool's 10s default). Use a FINITE
      // generous cap (30 min), NOT 0 — so a genuinely stuck statement is still
      // killed by the DB rather than pinning the op-lock forever. max_statement_
      // time is MariaDB-only, so tolerate failure on MySQL 8 (non-fatal — the
      // swap just runs under the default cap there).
      try {
        await tx.execute(sql`SET SESSION max_statement_time = 1800`)
      } catch (e) {
        console.error(JSON.stringify({ level: 'warn', msg: 'cutover_set_stmt_timeout_unsupported', err: String(e) }))
      }
    // 1. Drop the reverse-index rows for the content we wholesale-replace.
    await tx.execute(sql`
      DELETE FROM media_references WHERE referent_type IN ('content_block', 'page', 'post')
    `)
    // 2. Delete replaced content (children first; FK checks are off anyway).
    await tx.execute(sql`DELETE FROM content_blocks`)
    await tx.execute(sql`DELETE FROM pages`)
    await tx.execute(sql`DELETE FROM posts`)

    // 3. Insert pages + their block trees.
    for (const p of payload.pages) {
      const [pageRes] = (await tx.execute(sql`
        INSERT INTO pages
          (slug, title, is_home, system, published, published_at,
           seo_title, seo_description, og_image_id, hero_image_id,
           preview_epoch, version, updated_by, created_at, updated_at)
        VALUES
          (${p.slug}, ${p.title}, ${p.isHome}, ${p.system}, ${p.published},
           ${p.published ? sql`NOW(3)` : null}, ${p.seoTitle}, ${p.seoDescription},
           ${p.ogImageId}, ${p.heroImageId}, 0, 0, ${ctx.userId}, NOW(3), NOW(3))
      `)) as unknown as [{ insertId: number | bigint }]
      const pageId = Number(pageRes.insertId)

      if (p.heroImageId != null) await insertRef(tx, 'page', pageId, 'hero_image_id', p.heroImageId)
      if (p.ogImageId != null) await insertRef(tx, 'page', pageId, 'og_image_id', p.ogImageId)

      let secPos = POS_STEP
      for (const section of p.sections) {
        const [secRes] = (await tx.execute(sql`
          INSERT INTO content_blocks
            (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
          VALUES
            (${pageId}, NULL, 'section', NULL, 'section', ${secPos}, '{}',
             ${JSON.stringify(section.meta)}, 0)
        `)) as unknown as [{ insertId: number | bigint }]
        const sectionId = Number(secRes.insertId)
        secPos += POS_STEP

        // Reverse-index media carried in the section's meta (backgroundImage) so
        // the un-quarantine step makes a freshly-pushed cover image live.
        for (const ref of collectMediaPaths(section.meta)) {
          await insertRef(tx, 'content_block', sectionId, ref.field, ref.mediaId)
        }

        let colPos = POS_STEP
        for (const col of section.columns) {
          const [colRes] = (await tx.execute(sql`
            INSERT INTO content_blocks
              (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
            VALUES
              (${pageId}, ${sectionId}, 'column', NULL, 'column', ${colPos}, '{}',
               ${JSON.stringify(col.meta ?? {})}, 0)
          `)) as unknown as [{ insertId: number | bigint }]
          const columnId = Number(colRes.insertId)
          colPos += POS_STEP

          // Reverse-index media in the column's meta (backgroundImage) too.
          if (col.meta) {
            for (const ref of collectMediaPaths(col.meta)) {
              await insertRef(tx, 'content_block', columnId, ref.field, ref.mediaId)
            }
          }

          let widPos = POS_STEP
          for (const w of col.widgets) {
            // Same write boundary as every block write: Zod + DOMPurify.
            const cleaned = parseAndSanitize(w.blockType, w.data) as Record<string, unknown>
            const [wRes] = (await tx.execute(sql`
              INSERT INTO content_blocks
                (page_id, parent_id, kind, block_key, block_type, position, data, meta, version)
              VALUES
                (${pageId}, ${columnId}, 'widget', ${w.blockKey}, ${w.blockType}, ${widPos},
                 ${JSON.stringify(cleaned)}, ${w.meta ? JSON.stringify(w.meta) : null}, 0)
            `)) as unknown as [{ insertId: number | bigint }]
            const widgetId = Number(wRes.insertId)
            widPos += POS_STEP

            for (const ref of collectMediaPaths(cleaned)) {
              await insertRef(tx, 'content_block', widgetId, ref.field, ref.mediaId)
            }
            // Reverse-index media in the widget's meta (backgroundImage) too.
            if (w.meta) {
              for (const ref of collectMediaPaths(w.meta)) {
                await insertRef(tx, 'content_block', widgetId, ref.field, ref.mediaId)
              }
            }
          }
        }
      }
    }

    // 4. Insert posts.
    for (const post of payload.posts) {
      const [postRes] = (await tx.execute(sql`
        INSERT INTO posts
          (slug, title, excerpt, body_md, hero_image_id, published, published_at,
           seo_title, seo_description, og_image_id, version, updated_by, updated_at)
        VALUES
          (${post.slug}, ${post.title}, ${post.excerpt}, ${post.bodyMd}, ${post.heroImageId},
           ${post.published}, ${post.published ? sql`NOW(3)` : null}, ${post.seoTitle},
           ${post.seoDescription}, ${post.ogImageId}, 0, ${ctx.userId}, NOW(3))
      `)) as unknown as [{ insertId: number | bigint }]
      const postId = Number(postRes.insertId)
      if (post.heroImageId != null) await insertRef(tx, 'post', postId, 'hero_image_id', post.heroImageId)
      if (post.ogImageId != null) await insertRef(tx, 'post', postId, 'og_image_id', post.ogImageId)
      // Reverse-index inline body images (field 'body') so the un-quarantine
      // step below makes a freshly-pushed in-body image live.
      for (const mid of post.bodyMediaIds) await insertRef(tx, 'post', postId, 'body', mid)
    }

    // 5. Upsert projects by slug — NEVER delete (cascade would wipe the legacy
    //    project_sections rows). Projects on prod but absent from the bundle are
    //    left untouched.
    for (const pr of payload.projects) {
      // `id = LAST_INSERT_ID(id)` makes insertId return the EXISTING row's id on
      // the duplicate path, so we get the project id from one round trip (no
      // follow-up SELECT) whether it inserted or updated.
      const [upRes] = (await tx.execute(sql`
        INSERT INTO projects
          (slug, name, tagline, status, location, hero_image_id, brochure_pdf_id,
           featured_order, published, published_at, seo_title, seo_description,
           og_image_id, preview_epoch, version, updated_by, updated_at)
        VALUES
          (${pr.slug}, ${pr.name}, ${pr.tagline}, ${pr.status}, ${pr.location},
           ${pr.heroImageId}, ${pr.brochurePdfId}, ${pr.featuredOrder}, ${pr.published},
           ${pr.published ? sql`NOW(3)` : null}, ${pr.seoTitle}, ${pr.seoDescription},
           ${pr.ogImageId}, 0, 0, ${ctx.userId}, NOW(3))
        ON DUPLICATE KEY UPDATE
          id = LAST_INSERT_ID(id),
          name = VALUES(name), tagline = VALUES(tagline), status = VALUES(status),
          location = VALUES(location), hero_image_id = VALUES(hero_image_id),
          brochure_pdf_id = VALUES(brochure_pdf_id), featured_order = VALUES(featured_order),
          published = VALUES(published), seo_title = VALUES(seo_title),
          seo_description = VALUES(seo_description), og_image_id = VALUES(og_image_id),
          version = version + 1, updated_by = ${ctx.userId}, updated_at = NOW(3)
      `)) as unknown as [{ insertId: number | bigint }]
      const projectId = Number(upRes.insertId)
      if (projectId != null && projectId > 0) {
        await tx.execute(sql`
          DELETE FROM media_references
          WHERE referent_type = 'project' AND referent_id = ${projectId}
            AND field IN ('hero_image_id', 'brochure_pdf_id', 'og_image_id')
        `)
        if (pr.heroImageId != null) await insertRef(tx, 'project', projectId, 'hero_image_id', pr.heroImageId)
        if (pr.brochurePdfId != null) await insertRef(tx, 'project', projectId, 'brochure_pdf_id', pr.brochurePdfId)
        if (pr.ogImageId != null) await insertRef(tx, 'project', projectId, 'og_image_id', pr.ogImageId)
      }
    }

    // 6. Upsert the ≤8 push settings keys (hard-filtered to the allowlist).
    for (const key of Object.keys(payload.settings)) {
      if (!(PUSH_SETTING_KEYS as readonly string[]).includes(key)) continue
      const value = JSON.stringify(payload.settings[key])
      await tx.execute(sql`
        INSERT INTO settings (\`key\`, value, version, updated_by, updated_at)
        VALUES (${key}, ${value}, 0, ${ctx.userId}, NOW(3))
        ON DUPLICATE KEY UPDATE
          value = VALUES(value), version = version + 1,
          updated_by = ${ctx.userId}, updated_at = NOW(3)
      `)
    }

      // 6b. Un-quarantine the media this push actually references. Stage
      //     provisioned all pushed media as soft-deleted (deleted_at = NOW) so
      //     an abandoned stage leaves only sweepable orphans; here — now that
      //     the content + its media_references exist — we make exactly the
      //     referenced media live. Media from other (abandoned) stages has no
      //     reference and stays quarantined for the nightly purge.
      // The DISTINCT subquery scans media_references by media_id, which is the
      // LEADING column of its composite PK — so this is a PK index scan, not a
      // full-table scan, and the outer `deleted_at IS NOT NULL` means only the
      // media THIS cutover just quarantined+referenced actually flips to live
      // (everything else is already live → no-op).
      await tx.execute(sql`
        UPDATE media SET deleted_at = NULL
        WHERE deleted_at IS NOT NULL
          AND id IN (SELECT DISTINCT media_id FROM media_references)
      `)

      // 7. Verify INSIDE the transaction (before commit): the live page set
      //    must equal the staged set. A mismatch throws → ROLLBACK → prod
      //    untouched, preserving the all-or-nothing guarantee (no post-commit
      //    "verify_failed" state).
      const [vrows] = (await tx.execute(
        sql`SELECT COUNT(*) AS c FROM pages WHERE deleted_at IS NULL`,
      )) as unknown as [Array<{ c: number }>]
      if (Number(vrows[0]?.c ?? -1) !== payload.pages.length) {
        throw new Error(
          `cutover_verify_mismatch: pages live=${vrows[0]?.c} expected=${payload.pages.length}`,
        )
      }
      // posts are wholesale-replaced too — verify their count before commit.
      const [vposts] = (await tx.execute(
        sql`SELECT COUNT(*) AS c FROM posts WHERE deleted_at IS NULL`,
      )) as unknown as [Array<{ c: number }>]
      if (Number(vposts[0]?.c ?? -1) !== payload.posts.length) {
        throw new Error(
          `cutover_verify_mismatch: posts live=${vposts[0]?.c} expected=${payload.posts.length}`,
        )
      }

      // 8. One audit row attributing the push to the token's creator AND the
      //    acting API token (token_id null for a cookie-session cutover).
      await tx.execute(sql`
        INSERT INTO audit_log (user_id, token_id, action, resource_type, resource_id, diff, created_at)
        VALUES (${ctx.userId}, ${ctx.tokenId ?? null}, 'sync.cutover', 'site', NULL,
                ${JSON.stringify({
                  pages: payload.pages.length,
                  posts: payload.posts.length,
                  projects: payload.projects.length,
                  settings: Object.keys(payload.settings).filter((k) =>
                    (PUSH_SETTING_KEYS as readonly string[]).includes(k),
                  ).length,
                })}, NOW(3))
      `)
    } finally {
      // Restore BOTH session vars on the way out (success or throw) so the
      // pooled connection isn't returned with FK checks off or the SELECT cap
      // disabled. Restore each INDEPENDENTLY: a failure on one must not skip the
      // other, and neither may mask the original cutover error. (These SETs are
      // non-transactional and effectively never fail; log loudly if one does.)
      try {
        await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`)
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'cutover_restore_fk_failed', err: String(e) }))
      }
      try {
        await tx.execute(sql`SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_SEC}`)
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: 'cutover_restore_stmt_timeout_failed', err: String(e) }))
      }
    }
  })

  return {
    pages: payload.pages.length,
    posts: payload.posts.length,
    projects: payload.projects.length,
    settings: Object.keys(payload.settings).filter((k) =>
      (PUSH_SETTING_KEYS as readonly string[]).includes(k),
    ).length,
  }
}
