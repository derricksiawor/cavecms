// Local-install content serializer for the push feature.
//
// buildBundleContent() reads the LOCAL database and produces the bundle's
// content arrays (pages as block trees, posts as markdown, projects as
// entity metadata, the 8 push settings) plus the referenced media entries.
// Media refs inside widget data are LIFTED into `_mediaRefs` (path ->
// content-addressed bundleKey) and the raw `media_id` is stripped, so the
// serialized form is install-independent and hashes identically on prod
// after cutover.
//
// This is the shared reader behind GET /api/cms/sync/export AND the drift
// hash (via contentGraphOf + canonicalContentHash). It imports `db`, so it
// only runs server-side (the CLI never imports it — it calls the HTTP route).

import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { mediaBundleKey } from './contentHash'
import { navigateHolder, deleteAtPath } from './mediaPaths'
import { toContentGraph } from './contentGraph'
import {
  PUSH_SETTING_KEYS,
  bodyMediaPlaceholder,
  type PageBundleT,
  type PostBundleT,
  type ProjectBundleT,
  type SectionBundleT,
  type ColumnBundleT,
  type WidgetBundleT,
  type MediaBundleEntryT,
} from './bundleTypes'

interface MediaIdentity {
  id: number
  bundleKey: string
  filenameUuid: string
  originalName: string
  mime: string
  alt: string
  width: number | null
  height: number | null
  byteSize: number
  contentHash: string | null
  variants: Record<string, string> | null
}

function asObject(v: unknown): Record<string, unknown> {
  if (v == null) return {}
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

async function loadMediaMap(): Promise<Map<number, MediaIdentity>> {
  const [rows] = (await db.execute(sql`
    SELECT id, filename_uuid, original_name, mime_type, alt_text,
           width, height, byte_size, content_hash, variants
    FROM media
    WHERE deleted_at IS NULL
  `)) as unknown as [
    Array<{
      id: number
      filename_uuid: string
      original_name: string | null
      mime_type: string
      alt_text: string
      width: number | null
      height: number | null
      byte_size: number
      content_hash: string | null
      variants: unknown
    }>,
  ]
  const map = new Map<number, MediaIdentity>()
  for (const r of rows) {
    const originalName = r.original_name ?? ''
    const bundleKey = mediaBundleKey({
      originalName,
      byteSize: r.byte_size,
      width: r.width,
      height: r.height,
      mime: r.mime_type,
      contentHash: r.content_hash,
    })
    const variantsObj = asObject(r.variants) as Record<string, string>
    map.set(r.id, {
      id: r.id,
      bundleKey,
      filenameUuid: r.filename_uuid,
      originalName,
      mime: r.mime_type,
      alt: r.alt_text,
      width: r.width,
      height: r.height,
      byteSize: r.byte_size,
      contentHash: r.content_hash,
      variants: Object.keys(variantsObj).length ? variantsObj : null,
    })
  }
  return map
}

// Strip every media_id out of a widget's data, recording bundleKeys in the
// returned _mediaRefs map. Mutates a deep clone (never the source).
function liftMediaRefs(
  data: Record<string, unknown>,
  mediaMap: Map<number, MediaIdentity>,
  referenced: Set<string>,
): { data: Record<string, unknown>; mediaRefs: Record<string, string> } {
  const clone = structuredClone(data)
  const mediaRefs: Record<string, string> = {}
  // First pass: strip media_id from LIVE refs. A property delete does NOT shift
  // array indices, so iterating the precomputed path list is safe here. Dangling
  // refs are LEFT in place (still carrying media_id) for the second pass.
  for (const ref of collectMediaPaths(clone)) {
    const holder = navigateHolder(clone, ref.field)
    if (!holder || holder.media_id !== ref.mediaId) continue
    const ident = mediaMap.get(ref.mediaId)
    if (!ident) continue // dangling — deleted in the re-collect loop below
    delete holder.media_id
    mediaRefs[ref.field] = ident.bundleKey
    referenced.add(ident.bundleKey)
  }
  // Dangling ref (local media deleted/tampered): remove the WHOLE holder (a
  // partial `{alt}` would fail the block's required-MediaRef schema). Re-collect
  // fresh paths after each delete so an array splice can't invalidate a stale
  // precomputed index — robust regardless of index magnitude/order. Dangling
  // refs are rare (the media-delete guard blocks deleting referenced media), so
  // the repeated walk is cheap; the guard caps a pathological loop.
  for (let guard = 0; guard < 100_000; guard++) {
    const next = collectMediaPaths(clone).find((ref) => {
      const holder = navigateHolder(clone, ref.field)
      return !!holder && holder.media_id === ref.mediaId && !mediaMap.has(ref.mediaId)
    })
    if (!next) break
    deleteAtPath(clone, next.field)
  }
  return { data: clone, mediaRefs }
}

// Matches a /uploads/<variants|originals>/<uuid>[-variant][.ext] URL embedded in
// post markdown. The uuid (canonical 8-4-4-4-12) identifies the media row.
const BODY_MEDIA_URL_RE =
  /\/uploads\/(variants|originals)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(thumb|md|lg|og))?(?:\.[a-z0-9]+)?/gi

// Lift inline media URLs out of a post's markdown body, replacing each with an
// install-independent placeholder (cavecms://m/<bundleKey>/<variant>) and
// recording the bundleKey so the file ships. The stage step rewrites the
// placeholder back to the TARGET install's variant URL. Without this, a
// `![](/uploads/variants/<source-uuid>-md.webp)` would 404 on the target.
function liftBodyMedia(
  bodyMd: string,
  uuidToMedia: Map<string, MediaIdentity>,
  referenced: Set<string>,
): string {
  return bodyMd.replace(BODY_MEDIA_URL_RE, (full, kind: string, uuid: string, variant?: string) => {
    const ident = uuidToMedia.get(uuid.toLowerCase())
    if (!ident) return full // unknown media (already-deleted/external) — leave verbatim
    referenced.add(ident.bundleKey)
    const v = variant ?? (kind === 'originals' ? 'original' : 'md')
    return bodyMediaPlaceholder(ident.bundleKey, v)
  })
}

function mediaKey(
  id: number | null,
  mediaMap: Map<number, MediaIdentity>,
  referenced: Set<string>,
): string | null {
  if (id == null) return null
  const ident = mediaMap.get(id)
  if (!ident) return null
  referenced.add(ident.bundleKey)
  return ident.bundleKey
}

interface BlockRow {
  id: number
  page_id: number
  parent_id: number | null
  kind: 'section' | 'column' | 'widget'
  block_key: string | null
  block_type: string
  position: number
  data: unknown
  meta: unknown
}

function assembleSections(
  blocks: BlockRow[],
  mediaMap: Map<number, MediaIdentity>,
  referenced: Set<string>,
): SectionBundleT[] {
  // Index children by parent ONCE (O(n)) rather than re-scanning the whole
  // block list per parent (O(n²)).
  const byParent = new Map<number | null, BlockRow[]>()
  for (const b of blocks) {
    const bucket = byParent.get(b.parent_id)
    if (bucket) bucket.push(b)
    else byParent.set(b.parent_id, [b])
  }
  for (const bucket of byParent.values()) bucket.sort((a, b) => a.position - b.position)
  const childrenOf = (pid: number | null) => byParent.get(pid) ?? []

  const widgetOf = (b: BlockRow): WidgetBundleT => {
    const { data, mediaRefs } = liftMediaRefs(asObject(b.data), mediaMap, referenced)
    // Lift media out of meta too (backgroundImage.media_id on the cover-image
    // feature) — same content-addressed contract as data, into _metaMediaRefs.
    const { data: metaStripped, mediaRefs: metaRefs } = liftMediaRefs(
      asObject(b.meta),
      mediaMap,
      referenced,
    )
    const widget: WidgetBundleT = {
      kind: 'widget',
      blockType: b.block_type,
      blockKey: b.block_key,
      data,
    }
    if (Object.keys(metaStripped).length) widget.meta = metaStripped
    if (Object.keys(mediaRefs).length) widget._mediaRefs = mediaRefs
    if (Object.keys(metaRefs).length) widget._metaMediaRefs = metaRefs
    return widget
  }

  const columnOf = (b: BlockRow): ColumnBundleT => {
    const col: ColumnBundleT = {
      kind: 'column',
      widgets: childrenOf(b.id)
        .filter((w) => w.kind === 'widget')
        .map(widgetOf),
    }
    const { data: metaStripped, mediaRefs: metaRefs } = liftMediaRefs(
      asObject(b.meta),
      mediaMap,
      referenced,
    )
    if (Object.keys(metaStripped).length) col.meta = metaStripped
    if (Object.keys(metaRefs).length) col._metaMediaRefs = metaRefs
    return col
  }

  const sections: SectionBundleT[] = []
  for (const top of childrenOf(null)) {
    if (top.kind === 'section') {
      const { data: metaStripped, mediaRefs: metaRefs } = liftMediaRefs(
        asObject(top.meta),
        mediaMap,
        referenced,
      )
      const section: SectionBundleT = {
        kind: 'section',
        meta: metaStripped,
        columns: childrenOf(top.id)
          .filter((c) => c.kind === 'column')
          .map(columnOf),
      }
      if (Object.keys(metaRefs).length) section._metaMediaRefs = metaRefs
      sections.push(section)
    } else if (top.kind === 'widget') {
      // Legacy loose top-level widget: wrap in a 1-col section so it survives.
      sections.push({
        kind: 'section',
        meta: {},
        columns: [{ kind: 'column', widgets: [widgetOf(top)] }],
      })
    }
  }
  return sections
}

export interface BundleContent {
  pages: PageBundleT[]
  posts: PostBundleT[]
  projects: ProjectBundleT[]
  settings: Record<string, unknown>
  settingsMediaRefs: Record<string, Record<string, string>>
  media: MediaBundleEntryT[]
}

export async function buildBundleContent(): Promise<BundleContent> {
  const mediaMap = await loadMediaMap()
  // uuid → identity, for resolving /uploads/<uuid> URLs embedded in post markdown.
  const uuidToMedia = new Map<string, MediaIdentity>()
  for (const m of mediaMap.values()) uuidToMedia.set(m.filenameUuid.toLowerCase(), m)
  const referenced = new Set<string>()

  // PAGES + their block trees.
  const [pageRows] = (await db.execute(sql`
    SELECT id, slug, title, is_home, system, published,
           seo_title, seo_description, og_image_id, hero_image_id
    FROM pages
    WHERE deleted_at IS NULL
    ORDER BY slug
  `)) as unknown as [
    Array<{
      id: number
      slug: string
      title: string
      is_home: number
      system: number
      published: number
      seo_title: string | null
      seo_description: string | null
      og_image_id: number | null
      hero_image_id: number | null
    }>,
  ]
  // Fetch EVERY page's blocks in ONE query (no per-page round trip), grouped
  // by page_id in memory.
  const blocksByPage = new Map<number, BlockRow[]>()
  if (pageRows.length > 0) {
    const [allBlocks] = (await db.execute(sql`
      SELECT id, page_id, parent_id, kind, block_key, block_type, position, data, meta
      FROM content_blocks
      WHERE page_id IN (${sql.join(pageRows.map((p) => sql`${p.id}`), sql`, `)})
        AND deleted_at IS NULL
      ORDER BY position
    `)) as unknown as [BlockRow[]]
    for (const b of allBlocks) {
      const bucket = blocksByPage.get(b.page_id)
      if (bucket) bucket.push(b)
      else blocksByPage.set(b.page_id, [b])
    }
  }

  const pages: PageBundleT[] = []
  for (const p of pageRows) {
    const blocks = blocksByPage.get(p.id) ?? []
    pages.push({
      slug: p.slug,
      title: p.title,
      isHome: !!p.is_home,
      system: !!p.system,
      published: !!p.published,
      seoTitle: p.seo_title,
      seoDescription: p.seo_description,
      ogImageKey: mediaKey(p.og_image_id, mediaMap, referenced),
      heroImageKey: mediaKey(p.hero_image_id, mediaMap, referenced),
      sections: assembleSections(blocks, mediaMap, referenced),
    })
  }

  // POSTS (markdown).
  const [postRows] = (await db.execute(sql`
    SELECT slug, title, excerpt, body_md, published,
           seo_title, seo_description, hero_image_id, og_image_id
    FROM posts
    WHERE deleted_at IS NULL
    ORDER BY slug
  `)) as unknown as [
    Array<{
      slug: string
      title: string
      excerpt: string | null
      body_md: string
      published: number
      seo_title: string | null
      seo_description: string | null
      hero_image_id: number | null
      og_image_id: number | null
    }>,
  ]
  const posts: PostBundleT[] = postRows.map((r) => ({
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    bodyMd: liftBodyMedia(r.body_md, uuidToMedia, referenced),
    published: !!r.published,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
    heroImageKey: mediaKey(r.hero_image_id, mediaMap, referenced),
    ogImageKey: mediaKey(r.og_image_id, mediaMap, referenced),
  }))

  // PROJECTS (entity metadata only — legacy project_sections excluded).
  const [projectRows] = (await db.execute(sql`
    SELECT slug, name, tagline, status, location, featured_order, published,
           seo_title, seo_description, hero_image_id, brochure_pdf_id, og_image_id
    FROM projects
    WHERE deleted_at IS NULL
    ORDER BY slug
  `)) as unknown as [
    Array<{
      slug: string
      name: string
      tagline: string | null
      status: string
      location: string | null
      featured_order: number | null
      published: number
      seo_title: string | null
      seo_description: string | null
      hero_image_id: number | null
      brochure_pdf_id: number | null
      og_image_id: number | null
    }>,
  ]
  const projects: ProjectBundleT[] = projectRows.map((r) => ({
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    status: r.status as ProjectBundleT['status'],
    location: r.location,
    featuredOrder: r.featured_order,
    published: !!r.published,
    seoTitle: r.seo_title,
    seoDescription: r.seo_description,
    heroImageKey: mediaKey(r.hero_image_id, mediaMap, referenced),
    brochurePdfKey: mediaKey(r.brochure_pdf_id, mediaMap, referenced),
    ogImageKey: mediaKey(r.og_image_id, mediaMap, referenced),
  }))

  // SETTINGS — only the 8 push keys that exist.
  const [settingRows] = (await db.execute(sql`
    SELECT \`key\`, value FROM settings
    WHERE \`key\` IN (${sql.join(
      PUSH_SETTING_KEYS.map((k) => sql`${k}`),
      sql`, `,
    )})
  `)) as unknown as [Array<{ key: string; value: unknown }>]
  const settings: Record<string, unknown> = {}
  const settingsMediaRefs: Record<string, Record<string, string>> = {}
  for (const row of settingRows) {
    let raw: unknown
    try {
      raw = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
    } catch {
      // A malformed settings cell must not 500 the whole export — skip it (it
      // will simply be absent from the push; the operator's prod value stands).
      console.error(JSON.stringify({ level: 'warn', msg: 'sync_settings_parse_failed', key: row.key }))
      continue
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      // Lift settings media refs (site_header.logo, footer.logo,
      // default_seo.favicon, organization_json_ld.logo — all { media_id, alt })
      // the SAME way widget data is lifted, so they re-resolve to a prod
      // media_id at stage time instead of pushing the wrong local id.
      const { data: lifted, mediaRefs } = liftMediaRefs(
        raw as Record<string, unknown>,
        mediaMap,
        referenced,
      )
      settings[row.key] = lifted
      if (Object.keys(mediaRefs).length) settingsMediaRefs[row.key] = mediaRefs
    } else {
      settings[row.key] = raw
    }
  }

  // MEDIA entries for everything referenced.
  const media: MediaBundleEntryT[] = []
  for (const ident of mediaMap.values()) {
    if (!referenced.has(ident.bundleKey)) continue
    const isPdf = ident.mime === 'application/pdf'
    const files: MediaBundleEntryT['files'] = isPdf
      ? { pdf: `/api/cms/sync/media/pdf/${ident.filenameUuid}` }
      : {
          thumb: ident.variants?.thumb,
          md: ident.variants?.md,
          lg: ident.variants?.lg,
          og: ident.variants?.og,
        }
    media.push({
      bundleKey: ident.bundleKey,
      originalName: ident.originalName,
      mime: ident.mime,
      alt: ident.alt,
      width: ident.width,
      height: ident.height,
      byteSize: ident.byteSize,
      contentHash: ident.contentHash,
      kind: isPdf ? 'pdf' : 'image',
      files,
    })
  }

  return { pages, posts, projects, settings, settingsMediaRefs, media }
}

// Project the bundle content down to the hashable ContentGraph. Thin wrapper
// over the shared pure mapper so the DB path and the preflight path agree.
export function contentGraphOf(content: BundleContent) {
  return toContentGraph(content)
}
