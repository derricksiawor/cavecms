// Prod-side media remap for the content push. At stage time, every bundle
// media file is copied into the LIVE media set (additive — fresh UUIDs, new
// rows) and the staged content's bundleKey refs are resolved to the new prod
// media_ids. Old media is never deleted here (it's orphaned and GC'd later),
// so the cutover transaction never touches the media table.
//
// Ports the proven provisionTemplateMedia engine (app/api/install/template/
// route.ts) — fresh UUID, copy variant files, insert media row — adding a
// dedup-by-identity check so re-pushing an unchanged image reuses its row.

import 'server-only'
import { randomUUID } from 'node:crypto'
import { mkdir, copyFile, chmod, lstat } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import type { Tx } from '@/db/client'
import { PATHS } from '@/lib/media/storage'
import { setMediaIdAtPath } from './mediaPaths'
import { bodyMediaPlaceholderRe } from './bundleTypes'
import type {
  MediaBundleEntryT,
  PageBundleT,
  PostBundleT,
  ProjectBundleT,
} from './bundleTypes'
import type {
  StagedPayload,
  StagedPage,
  StagedSection,
} from './applyBundle'

export interface ResolvedMedia {
  mediaId: number
  alt: string
  // Target-side filename_uuid + variant URL map — needed to rewrite the
  // /uploads/<uuid> URLs that post markdown bodies embed.
  uuid: string
  variants: Record<string, string> | null
}

interface InsertResult {
  insertId: number | bigint
}

// Copy a bundle file into a destination, asserting it stays inside the bundle
// root (defence in depth against a crafted manifest path).
async function safeCopy(bundleRoot: string, rel: string, dst: string): Promise<void> {
  const src = path.resolve(bundleRoot, rel)
  if (!src.startsWith(path.resolve(bundleRoot) + path.sep)) {
    throw new Error(`sync_media_path_traversal_blocked:${rel}`)
  }
  // lstat (not stat) so a symlink is seen as a symlink, not its target — and
  // require a regular file, refusing symlinks/dirs/devices before copyFile
  // (which would otherwise follow a symlink out of the bundle root).
  const st = await lstat(src)
  if (!st.isFile()) throw new Error(`sync_media_not_a_regular_file:${rel}`)
  await copyFile(src, dst)
  await chmod(dst, 0o640)
}

// Insert (or reuse) every bundle media entry into the live media set. Returns
// bundleKey -> { mediaId, alt }. `writtenPaths` accumulates copied files so the
// caller can unlink them if the stage later aborts.
export async function provisionBundleMedia(
  tx: Tx,
  entries: MediaBundleEntryT[],
  bundleRoot: string,
  writtenPaths: string[],
): Promise<Map<string, ResolvedMedia>> {
  await mkdir(PATHS.variants, { recursive: true, mode: 0o750 })
  await mkdir(PATHS.brochures, { recursive: true, mode: 0o750 })

  const out = new Map<string, ResolvedMedia>()
  for (const entry of entries) {
    // Dedup: an identical, non-deleted row already covers this file. mime_type
    // is part of the identity so two distinct file types that happen to share
    // (name, bytes, w, h) never collapse to one row. NULL-safe `<=>` on every
    // column so a row with a NULL name/dim still matches correctly. An IMAGE
    // entry only reuses a row that ACTUALLY has variants — reusing a NULL-
    // variants row (a still-processing / broken image) would serve a permanently
    // broken image and discard the bundle's good variants; a PDF entry (always
    // variant-less) reuses only a NULL-variants row.
    const variantGuard =
      entry.kind === 'image' ? sql`AND variants IS NOT NULL` : sql`AND variants IS NULL`
    const [dupRows] = (await tx.execute(sql`
      SELECT id, alt_text, filename_uuid, variants FROM media
      WHERE byte_size <=> ${entry.byteSize}
        AND original_name <=> ${entry.originalName}
        AND mime_type <=> ${entry.mime}
        AND width <=> ${entry.width}
        AND height <=> ${entry.height}
        AND content_hash <=> ${entry.contentHash ?? null}
        AND deleted_at IS NULL
        ${variantGuard}
      LIMIT 1
    `)) as unknown as [
      Array<{ id: number; alt_text: string; filename_uuid: string; variants: unknown }>,
    ]
    if (dupRows[0]) {
      // Same file, but the operator may have edited its alt text — sync it so a
      // re-push doesn't silently keep prod's stale alt.
      if (dupRows[0].alt_text !== entry.alt) {
        await tx.execute(sql`UPDATE media SET alt_text = ${entry.alt} WHERE id = ${dupRows[0].id}`)
      }
      out.set(entry.bundleKey, {
        mediaId: dupRows[0].id,
        alt: entry.alt,
        uuid: dupRows[0].filename_uuid,
        variants: parseVariants(dupRows[0].variants),
      })
      continue
    }

    const uuid = randomUUID()
    let variantsJson: Record<string, string> | null = null

    if (entry.kind === 'pdf') {
      const rel = entry.files.pdf
      if (!rel) throw new Error(`sync_media_pdf_missing:${entry.bundleKey}`)
      const dst = path.join(PATHS.brochures, `${uuid}.pdf`)
      await safeCopy(bundleRoot, rel, dst)
      writtenPaths.push(dst)
      // PDFs carry no variant images; the media list synthesises the
      // /api/cms/sync/media/pdf/<uuid> URL from filename_uuid.
      variantsJson = null
    } else {
      const plan: Array<[keyof typeof entry.files, string]> = [
        ['thumb', `${uuid}-thumb.webp`],
        ['md', `${uuid}-md.webp`],
        ['lg', `${uuid}-lg.webp`],
        ['og', `${uuid}-og.jpg`],
      ]
      variantsJson = {}
      for (const [variant, destName] of plan) {
        const rel = entry.files[variant]
        if (!rel) continue
        const dst = path.join(PATHS.variants, destName)
        await safeCopy(bundleRoot, rel, dst)
        writtenPaths.push(dst)
        variantsJson[variant] = `/uploads/variants/${destName}`
      }
      // An image with NO variant files stores NULL variants (the renderer's
      // "still processing" sentinel), never an empty {} object.
      if (Object.keys(variantsJson).length === 0) variantsJson = null
    }

    // Provision QUARANTINED (deleted_at = NOW): the row + files exist so the
    // staged payload can reference its id, but it is invisible to the live site
    // until the cutover un-quarantines exactly the media it uses. An abandoned
    // (never-cut-over) stage therefore leaves only soft-deleted, unreferenced
    // media — which the existing nightly media purge reaps after 30d. The
    // cutover (applyBundle) clears deleted_at on every media it references.
    const [insertRes] = (await tx.execute(sql`
      INSERT INTO media
        (filename_uuid, original_name, mime_type, alt_text, width, height, byte_size, content_hash, variants, uploaded_by, created_at, deleted_at)
      VALUES
        (${uuid}, ${entry.originalName}, ${entry.mime}, ${entry.alt},
         ${entry.width}, ${entry.height}, ${entry.byteSize}, ${entry.contentHash ?? null},
         ${variantsJson ? JSON.stringify(variantsJson) : null}, ${null}, NOW(3), NOW(3))
    `)) as unknown as [InsertResult]
    out.set(entry.bundleKey, {
      mediaId: Number(insertRes.insertId),
      alt: entry.alt,
      uuid,
      variants: variantsJson,
    })
  }
  return out
}

function parseVariants(v: unknown): Record<string, string> | null {
  if (v == null) return null
  const obj = typeof v === 'string' ? safeJsonObject(v) : (v as Record<string, string>)
  return obj && Object.keys(obj).length ? (obj as Record<string, string>) : null
}
function safeJsonObject(s: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(s)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch {
    return null
  }
}

// Rewrite the cavecms://m/<bundleKey>/<variant> placeholders the serializer put
// in a post's markdown body back to the TARGET install's real /uploads URLs.
function resolveBodyMedia(
  bodyMd: string,
  keyToMedia: Map<string, ResolvedMedia>,
  collectIds?: Set<number>,
): string {
  return bodyMd.replace(bodyMediaPlaceholderRe(), (full, key: string, variant: string) => {
    const m = keyToMedia.get(key.toLowerCase())
    if (!m) return full // unresolved (shouldn't happen post-preflight) — leave placeholder
    collectIds?.add(m.mediaId)
    if (variant === 'original') return `/uploads/originals/${m.uuid}`
    const url = m.variants?.[variant]
    return url ?? full
  })
}

function keyToId(
  key: string | null,
  map: Map<string, ResolvedMedia>,
): number | null {
  if (key == null) return null
  return map.get(key)?.mediaId ?? null
}

// Re-inject real prod media_ids into a block's meta object from its lifted
// _metaMediaRefs (path -> bundleKey). Returns a CLONE with media_id restored at
// each ref path (e.g. backgroundImage.media_id on a section/column cover image).
// Mirrors the per-widget data resolution below.
function resolveMetaMedia(
  rawMeta: Record<string, unknown> | null | undefined,
  refs: Record<string, string> | undefined,
  keyToMedia: Map<string, ResolvedMedia>,
): Record<string, unknown> {
  const clone = structuredClone((rawMeta ?? {}) as Record<string, unknown>)
  for (const [field, bkey] of Object.entries(refs ?? {})) {
    const id = keyToMedia.get(bkey)?.mediaId
    if (id != null) setMediaIdAtPath(clone, field, id)
  }
  return clone
}

// Resolve a validated bundle's content into the insert-ready StagedPayload:
// every bundleKey ref becomes a real prod media_id.
export function resolveStagedContent(
  content: {
    pages: PageBundleT[]
    posts: PostBundleT[]
    projects: ProjectBundleT[]
    settings: Record<string, unknown>
    settingsMediaRefs?: Record<string, Record<string, string>>
  },
  keyToMedia: Map<string, ResolvedMedia>,
): StagedPayload {
  // Resolve settings media refs (logo/favicon) back to prod media_ids.
  const settings: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(content.settings)) {
    const refs = content.settingsMediaRefs?.[key]
    if (refs && value && typeof value === 'object' && !Array.isArray(value)) {
      const resolved = structuredClone(value) as Record<string, unknown>
      for (const [field, bkey] of Object.entries(refs)) {
        const id = keyToMedia.get(bkey)?.mediaId
        if (id != null) setMediaIdAtPath(resolved, field, id)
      }
      settings[key] = resolved
    } else {
      settings[key] = value
    }
  }
  const pages: StagedPage[] = content.pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    isHome: p.isHome,
    system: p.system,
    published: p.published,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    ogImageId: keyToId(p.ogImageKey, keyToMedia),
    heroImageId: keyToId(p.heroImageKey, keyToMedia),
    sections: p.sections.map(
      (section): StagedSection => ({
        meta: resolveMetaMedia(section.meta, section._metaMediaRefs, keyToMedia),
        columns: section.columns.map((col) => ({
          meta:
            col.meta || col._metaMediaRefs
              ? resolveMetaMedia(col.meta, col._metaMediaRefs, keyToMedia)
              : null,
          widgets: col.widgets.map((w) => {
            const data = structuredClone(w.data)
            for (const [field, key] of Object.entries(w._mediaRefs ?? {})) {
              const id = keyToMedia.get(key)?.mediaId
              if (id != null) setMediaIdAtPath(data, field, id)
            }
            return {
              blockType: w.blockType,
              blockKey: w.blockKey ?? null,
              data,
              meta:
                w.meta || w._metaMediaRefs
                  ? resolveMetaMedia(w.meta, w._metaMediaRefs, keyToMedia)
                  : null,
            }
          }),
        })),
      }),
    ),
  }))

  return {
    pages,
    posts: content.posts.map((p) => {
      // Rewrite inline body-image placeholders → target URLs, collecting the
      // target media_ids so the cutover can reverse-index + un-quarantine them.
      const bodyMediaIds = new Set<number>()
      const bodyMd = resolveBodyMedia(p.bodyMd, keyToMedia, bodyMediaIds)
      return {
        slug: p.slug,
        title: p.title,
        excerpt: p.excerpt,
        bodyMd,
        published: p.published,
        seoTitle: p.seoTitle,
        seoDescription: p.seoDescription,
        heroImageId: keyToId(p.heroImageKey, keyToMedia),
        ogImageId: keyToId(p.ogImageKey, keyToMedia),
        bodyMediaIds: [...bodyMediaIds],
      }
    }),
    projects: content.projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      tagline: p.tagline,
      status: p.status,
      location: p.location,
      featuredOrder: p.featuredOrder,
      published: p.published,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      heroImageId: keyToId(p.heroImageKey, keyToMedia),
      brochurePdfId: keyToId(p.brochurePdfKey, keyToMedia),
      ogImageId: keyToId(p.ogImageKey, keyToMedia),
    })),
    settings,
  }
}
