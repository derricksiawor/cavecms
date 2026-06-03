import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { notificationFailures } from '@/db/schema'
import { parseForRead, parseProjectSectionForRead } from './parse'
import { collectMediaPaths } from './mediaRefs'
import { getProjectRow } from './getProjectRow'
import { isMissingTable } from '@/lib/db/errors'
import type { BlockData } from './block-registry'
import type { BlockKind } from './blockMeta'

// Dedup window for hydrate parse-failure notifications. Without
// this, every public render of a broken page/project inserts a
// fresh notification_failures row — a popular page with a corrupt
// payload generates one INSERT per request, unbounded until the
// Plan 09 sweeper resolves it. The dedup is per-process and held
// for 5 minutes; the sweeper still picks up the first row, and
// repeated occurrences within the window log a debug line instead
// of writing a duplicate. Outside the window the next render emits
// a fresh row so operators see continued breakage.
//
// PM2 cluster mode amplifies the first-burst signal by worker
// count (each worker has its own dedup map). For an N-worker
// deploy a broken section produces up to N concurrent inserts on
// the first burst, then converges. If the alert volume from
// cluster amplification becomes a problem, replace the dedup with
// an idempotent MySQL INSERT keyed on (kind, ref_table, ref_id,
// hour_bucket).
const HYDRATE_NOTIFY_DEDUP_MS = 5 * 60 * 1000
declare global {
  var __cavecmsHydrateNotifyDedup: Map<string, number> | undefined
}
const hydrateNotifyDedup: Map<string, number> =
  globalThis.__cavecmsHydrateNotifyDedup ?? new Map<string, number>()
globalThis.__cavecmsHydrateNotifyDedup = hydrateNotifyDedup

function shouldEmitNotify(key: string): boolean {
  const now = Date.now()
  const last = hydrateNotifyDedup.get(key)
  if (last && now - last < HYDRATE_NOTIFY_DEDUP_MS) return false
  hydrateNotifyDedup.set(key, now)
  // Crude cap: if the dedup map exceeds 10k keys, drop oldest 10%.
  if (hydrateNotifyDedup.size > 10_000) {
    const drop = Math.ceil(hydrateNotifyDedup.size * 0.1)
    let i = 0
    for (const k of hydrateNotifyDedup.keys()) {
      hydrateNotifyDedup.delete(k)
      if (++i >= drop) break
    }
  }
  return true
}

export interface HydratedBlock {
  id: number
  blockKey: string | null
  blockType: string
  position: number
  version: number
  data: BlockData
  // Migration 0011: section/column hierarchy on content_blocks.
  // Legacy rows default kind='widget' parentId=null and continue
  // rendering as top-level loose widgets. Sections + columns introduce
  // the 2-level tree (section → column → widget). Renderers walk the
  // tree by partitioning the flat result on parentId.
  kind: BlockKind
  parentId: number | null
  meta: unknown | null
}

export interface HydratedMedia {
  id: number
  alt_text: string
  variants: Record<string, string> | null
  width: number | null
  height: number | null
}

export interface HydratedProject {
  id: number
  slug: string
  name: string
  tagline: string | null
  hero_image_id: number | null
  og_image_id: number | null
}

// Recent published posts — populated only when the page has an
// lx_posts block. Mirrors the /blog index query (latest published,
// not soft-deleted). Keyed by id; iteration order is published_at DESC.
export interface HydratedPost {
  id: number
  slug: string
  title: string
  excerpt: string | null
  published_at: Date | string | null
  hero_image_id: number | null
}

export interface HydratedPage {
  blocks: HydratedBlock[]
  media: Map<number, HydratedMedia>
  // Featured projects (projects.featured_order), in featured order —
  // populated only when the page has an lx_featured_projects block.
  // Keyed by id for React keys; iteration order is the featured order.
  projects: Map<number, HydratedProject>
  // Recent posts — populated only when the page has an lx_posts block.
  // Iteration order is published_at DESC (newest first).
  posts: Map<number, HydratedPost>
}

/** Defensively parse a media row's `variants` JSON cell.
 *
 *  mysql2 returns the column as either a parsed object (when MariaDB
 *  reports JSON type) or a raw string (legacy TEXT column). Either
 *  shape could be corrupt — a manual SQL fixup, a buggy migration, or
 *  even a double-encoded write would otherwise throw SyntaxError from
 *  an unguarded `JSON.parse`, taking the whole public page render down
 *  with a 500. We treat any malformed cell as `null` and log structured
 *  so the operator can spot the corrupt row without losing the render
 *  for every other piece of media on the page. Matches the same
 *  per-block try/catch defensiveness used elsewhere in this file. */
function parseMediaVariants(
  raw: string | Record<string, string> | null,
  mediaId: number,
): Record<string, string> | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>
      }
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'hydrate_media_variants_invalid_shape',
          media_id: mediaId,
        }),
      )
      return null
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'hydrate_media_variants_invalid_json',
          media_id: mediaId,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      return null
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw
  }
  return null
}

/**
 * Two-phase fetch for a page render. Single index walk + 2 bulk fetches
 * — no N+1.
 *
 *   Phase 1: SELECT all living blocks for pageId. parseForRead re-runs
 *            the parse boundary so even a tampered DB cell can't slip a
 *            javascript: URI through. Collect media_id / project_id
 *            sets while walking.
 *
 *   Phase 2: Bulk SELECT projects by id. Add their hero_image_id /
 *            og_image_id to the media set.
 *
 *   Phase 3: Bulk SELECT every media row in one round trip. Return as
 *            Map<id, row> so consumers do constant-time lookups.
 */
export async function hydratePage(
  pageId: number,
): Promise<HydratedPage | null> {
  // Verify the page exists before fetching blocks — distinguishes
  // "real page with zero blocks" (returns an empty-shaped HydratedPage)
  // from "no such page" (returns null so the route can 404 cleanly).
  const [pageRows] = (await db.execute(sql`
    SELECT id FROM pages WHERE id = ${pageId}
  `)) as unknown as [Array<{ id: number }>]
  if (pageRows.length === 0) return null

  // Tree-aware fetch. Sections/columns/widgets all live in the same
  // table; we pull them ALL in one round-trip ordered by position so
  // the renderer can partition the flat set into the section→column→
  // widget tree client-side. The (parent_id, position) index added in
  // migration 0011 covers the per-parent ORDER BY position sub-scans
  // a future tree-aware query refactor would do, but a single flat
  // SELECT is simpler and faster at v1 scale (10–100 blocks per page).
  const [blockRows] = (await db.execute(sql`
    SELECT id, parent_id, kind, block_key, block_type, position, data, meta, version
    FROM content_blocks
    WHERE page_id = ${pageId} AND deleted_at IS NULL
    ORDER BY position
  `)) as unknown as [
    Array<{
      id: number
      parent_id: number | null
      kind: BlockKind
      block_key: string | null
      block_type: string
      position: number
      data: string
      meta: string | null
      version: number
    }>,
  ]

  const mediaIds = new Set<number>()
  // Per-render batch of notification_failures intents. Collected during
  // the block-parse loop, flushed fire-and-forget after the loop so a
  // page with K broken blocks doesn't pay K × insert latency on TTFB.
  const pendingNotifications: Array<{
    blockId: number
    payload: Record<string, unknown>
  }> = []

  const blocks: HydratedBlock[] = []
  for (const b of blockRows) {
    // mysql2 returns JSON columns as strings via raw SQL. Parse once,
    // re-validate via the read boundary (Zod + sanitize on every field).
    // Per-block try/catch — one malformed row (post-write schema bump,
    // operator INSERT, restore of pre-validation data) must NOT 500 the
    // whole page. Log a structured signal and OMIT the block from the
    // render set; admin tooling can surface this via the audit/error feed.
    let raw: unknown
    try {
      raw = JSON.parse(b.data)
    } catch {
      raw = {}
    }
    // Section + column rows are containers — their `data` column is an
    // empty object placeholder (the content_blocks.data NOT NULL contract
    // is honoured by INSERT-time `'{}'`). They have no block-registry
    // schema; parseForRead would throw `unknown_block_type` and the row
    // would be skipped + a notification_failures row inserted on every
    // render. Container kinds bypass the parse boundary entirely; their
    // settings live in `meta` (parsed below) and they emit no widget HTML.
    let data: BlockData
    if (b.kind !== 'widget') {
      data = {} as BlockData
    } else {
      try {
        data = parseForRead(b.block_type, raw)
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'hydrate_block_parse_failed',
          page_id: pageId,
          block_id: b.id,
          block_key: b.block_key,
          block_type: b.block_type,
          err_name: err instanceof Error ? err.name : 'unknown',
        }))
        // Enqueue a durable signal so admin tooling (Plan 09 sweeper /
        // admin error feed) can surface "page rendered missing block X"
        // without having to grep logs. Dedup window prevents one bad
        // row from amplifying a flood of duplicate notification_failures
        // INSERTs under heavy traffic. On insert failure, log fatal —
        // a silent .catch(()=>{}) would hide a broken page from every
        // operator alert path.
        // Collect into a per-render batch — flushed fire-and-forget
        // after the block-parse loop completes. Pre-fix the await
        // blocked the loop per failed row, inflating public-page TTFB
        // by N × insert latency on pages with multiple broken blocks.
        // The render's response is unaffected by these inserts; the
        // structured-error log above already carries the operator
        // signal for live triage.
        if (shouldEmitNotify(`content_blocks:${b.id}`)) {
          pendingNotifications.push({
            blockId: b.id,
            payload: {
              page_id: pageId,
              block_key: b.block_key,
              block_type: b.block_type,
              err_name: err instanceof Error ? err.name : 'unknown',
            },
          })
        }
        continue
      }
    }

    collectMediaPaths(data).forEach((p) => mediaIds.add(p.mediaId))
    // Parse `meta` (per-kind container settings JSON) defensively —
    // same pattern as `data` above. A corrupt meta blob renders as
    // null instead of 500-ing the page.
    let parsedMeta: unknown = null
    if (b.meta !== null && b.meta !== undefined) {
      try {
        parsedMeta = JSON.parse(b.meta)
      } catch {
        parsedMeta = null
      }
    }
    // Section / column meta carries an optional `backgroundImage.media_id`
    // (Elementor-parity cover-image-as-bg feature). Add it to mediaIds
    // so the lookup below fetches the variants — without this, the
    // section renderer's `media.get(id)` returns undefined and the
    // cover image never renders. Same shape for both kinds because
    // both SectionMeta and ColumnMeta carry the field at the same key.
    if (parsedMeta && typeof parsedMeta === 'object') {
      const mm = parsedMeta as Record<string, unknown>
      const bgImg = mm['backgroundImage']
      if (bgImg && typeof bgImg === 'object') {
        const id = (bgImg as Record<string, unknown>)['media_id']
        if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
          mediaIds.add(id)
        }
      }
    }
    blocks.push({
      id: b.id,
      blockKey: b.block_key,
      blockType: b.block_type,
      position: b.position,
      version: b.version,
      data,
      kind: b.kind,
      parentId: b.parent_id,
      meta: parsedMeta,
    })
  }

  // lx_featured_projects auto-renders the projects marked Featured
  // (projects.featured_order), in that order — there is no per-block
  // selection. Fetch them ONLY when such a block is on the page so
  // pages without it pay no extra query. The Map below preserves the
  // featured_order insertion order, which the renderer iterates.
  const hasFeaturedBlock = blocks.some(
    (b) => b.blockType === 'lx_featured_projects',
  )
  const projects = hasFeaturedBlock ? await fetchFeaturedProjectsSafely() : []
  for (const p of projects) {
    if (p.hero_image_id) mediaIds.add(p.hero_image_id)
    if (p.og_image_id) mediaIds.add(p.og_image_id)
  }

  // lx_posts auto-renders the latest published posts (no per-block
  // selection). Fetch ONLY when such a block is on the page. A page can
  // hold several lx_posts blocks with different `limit`s — fetch MAX
  // once (capped at 12), each renderer slices to its own data.limit.
  const postsBlocks = blocks.filter((b) => b.blockType === 'lx_posts')
  let posts: HydratedPost[] = []
  if (postsBlocks.length > 0) {
    const maxLimit = postsBlocks.reduce((m, b) => {
      // b.blockType === 'lx_posts' here (filtered above), so b.data is
      // the lx_posts shape; `limit` is a Zod-validated 1..12 int.
      const lim = (b.data as BlockData<'lx_posts'>).limit
      return typeof lim === 'number' && lim > m ? lim : m
    }, 1)
    posts = await fetchRecentPostsSafely(Math.min(12, Math.max(1, maxLimit)))
    for (const p of posts) {
      if (p.hero_image_id) mediaIds.add(p.hero_image_id)
    }
  }

  let mediaRows: Array<{ id: number; alt_text: string; variants: Record<string, string> | null; width: number | null; height: number | null }> = []
  if (mediaIds.size) {
    const ids = [...mediaIds]
    const [rows] = (await db.execute(sql`
      SELECT id, alt_text, variants, width, height
      FROM media
      WHERE id IN (${sql.join(ids, sql.raw(','))})
        AND deleted_at IS NULL
    `)) as unknown as [
      Array<{ id: number; alt_text: string; variants: string | Record<string, string> | null; width: number | null; height: number | null }>,
    ]
    mediaRows = rows.map((r) => ({
      ...r,
      variants: parseMediaVariants(r.variants, r.id),
      width: r.width ?? null,
      height: r.height ?? null,
    }))
  }

  // Fire-and-forget the batched notification inserts. The render's
  // response is unaffected by these writes; a fatal log on failure is
  // the operator-facing signal.
  if (pendingNotifications.length > 0) {
    void Promise.allSettled(
      pendingNotifications.map((n) =>
        db
          .insert(notificationFailures)
          .values({
            kind: 'hydrate_block_parse_failed',
            refTable: 'content_blocks',
            refId: n.blockId,
            payload: n.payload,
          })
          .catch((e: unknown) => {
            console.error(
              JSON.stringify({
                level: 'fatal',
                msg: 'hydrate_block_notify_insert_failed',
                page_id: pageId,
                block_id: n.blockId,
                err: e instanceof Error ? e.message : String(e),
              }),
            )
          }),
      ),
    )
  }

  return {
    blocks,
    media: new Map(mediaRows.map((r) => [r.id, r])),
    projects: new Map(projects.map((p) => [p.id, p])),
    posts: new Map(posts.map((p) => [p.id, p])),
  }
}

/** Fetches the Featured projects (projects.featured_order set) in order,
 *  capped at 12 — the data source for the lx_featured_projects grid.
 *  Wrapped in a missing-table feature detect so hydrate stays useful on
 *  installs without the projects schema yet. Any other DB error
 *  propagates — silent fallbacks were masking real outages. */
async function fetchFeaturedProjectsSafely(): Promise<HydratedProject[]> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT id, slug, name, tagline, hero_image_id, og_image_id
      FROM projects
      WHERE featured_order IS NOT NULL
        AND published = TRUE
        AND deleted_at IS NULL
      ORDER BY featured_order
      LIMIT 12
    `)) as unknown as [HydratedProject[]]
    return rows
  } catch (err) {
    if (isMissingTable(err)) return []
    throw err
  }
}

/** Fetches the latest published, not-soft-deleted posts (newest first),
 *  capped at `limit` — the data source for the lx_posts block. Mirrors
 *  the /blog index query. Missing-table-safe like the projects fetch. */
async function fetchRecentPostsSafely(limit: number): Promise<HydratedPost[]> {
  const cap = Math.min(12, Math.max(1, Math.floor(limit)))
  try {
    const [rows] = (await db.execute(sql`
      SELECT id, slug, title, excerpt, published_at, hero_image_id
      FROM posts
      WHERE published = TRUE
        AND deleted_at IS NULL
      ORDER BY published_at DESC, id DESC
      LIMIT ${cap}
    `)) as unknown as [HydratedPost[]]
    return rows
  } catch (err) {
    if (isMissingTable(err)) return []
    throw err
  }
}

// ---- hydrateProject ----

export interface HydratedProjectRow {
  id: number
  slug: string
  name: string
  tagline: string | null
  status: string
  location: string | null
  hero_image_id: number | null
  brochure_pdf_id: number | null
  og_image_id: number | null
  preview_epoch: number
  published: number
  published_at: Date | null
  seo_title: string | null
  seo_description: string | null
  // SEO suite per-entity fields (migration 0032). Optional because some
  // raw reads of this shape predate them; the project route's
  // getProjectRow SELECT now projects them for the metadata + per-page
  // schema wiring. TINYINT(1) surfaces as 0|1; seo_meta is JSON-as-string
  // from MariaDB (parse via lib/seo/seoMeta.ts:parseSeoMeta).
  robots_noindex?: number | null
  robots_nofollow?: number | null
  canonical_url?: string | null
  seo_meta?: unknown
  version: number
}

export interface HydratedProjectSection {
  id: number
  sectionKey: string
  position: number
  version: number
  data: unknown
}

export interface HydratedProjectDetail {
  project: HydratedProjectRow
  sections: HydratedProjectSection[]
  media: Map<number, HydratedMedia>
}

/**
 * Resolves a public project page (or an admin preview). Returns null
 * when:
 *   - the slug doesn't exist, OR
 *   - the project is soft-deleted, OR
 *   - allowUnpublished is false and the project is unpublished.
 *
 * On a hit, fetches all 10 section rows in position order, runs each
 * through parseProjectSectionForRead (per-section try/catch — one bad
 * row never 500s the whole page, parallel to hydratePage's block
 * pattern), then bulk-loads every media_id referenced across the
 * project row + sections in one round trip.
 */
export async function hydrateProject(
  slug: string,
  opts: { allowUnpublished?: boolean } = {},
): Promise<HydratedProjectDetail | null> {
  // Cached row reader — request-scoped via React cache(). Same call
  // inside generateMetadata returns the same row without a second
  // DB hit. See lib/cms/getProjectRow.ts.
  const project = await getProjectRow(slug)
  if (!project) return null
  if (!opts.allowUnpublished && project.published !== 1) return null

  const [sectionRows] = (await db.execute(sql`
    SELECT id, section_key, position, version, data
    FROM project_sections
    WHERE project_id = ${project.id}
    ORDER BY position
  `)) as unknown as [
    Array<{
      id: number
      section_key: string
      position: number
      version: number
      data: string | unknown
    }>,
  ]

  const sections: HydratedProjectSection[] = []
  for (const s of sectionRows) {
    let raw: unknown
    try {
      raw = typeof s.data === 'string' ? JSON.parse(s.data) : s.data
    } catch {
      raw = {}
    }
    let parsed: unknown
    try {
      parsed = parseProjectSectionForRead(s.section_key, raw)
    } catch (err) {
      // Mirror hydratePage's block-parse-failure pattern: log +
      // enqueue a durable signal, skip the section, never 500 the
      // page. Admin error feed (Plan 09 sweeper) surfaces these so an
      // operator can fix the offending payload.
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'hydrate_project_section_parse_failed',
          project_id: project.id,
          section_id: s.id,
          section_key: s.section_key,
          err_name: err instanceof Error ? err.name : 'unknown',
        }),
      )
      if (shouldEmitNotify(`project_sections:${s.id}`)) {
        await db
          .insert(notificationFailures)
          .values({
            kind: 'hydrate_project_section_parse_failed',
            refTable: 'project_sections',
            refId: s.id,
            payload: {
              project_id: project.id,
              section_key: s.section_key,
              err_name: err instanceof Error ? err.name : 'unknown',
            },
          })
          .catch((e: unknown) => {
            console.error(JSON.stringify({
              level: 'fatal',
              msg: 'hydrate_project_section_notify_insert_failed',
              project_id: project.id,
              section_id: s.id,
              err: e instanceof Error ? e.message : String(e),
            }))
          })
      }
      continue
    }
    sections.push({
      id: s.id,
      sectionKey: s.section_key,
      position: s.position,
      version: s.version,
      data: parsed,
    })
  }

  // Single bulk media fetch: union of every media_id reachable from
  // the project row (hero, brochure pdf, og image) and from any
  // section payload (collectMediaPaths walks recursively).
  const mediaIds = new Set<number>()
  if (project.hero_image_id) mediaIds.add(project.hero_image_id)
  if (project.brochure_pdf_id) mediaIds.add(project.brochure_pdf_id)
  if (project.og_image_id) mediaIds.add(project.og_image_id)
  for (const s of sections) {
    collectMediaPaths(s.data).forEach((p) => mediaIds.add(p.mediaId))
  }

  let mediaRows: Array<{
    id: number
    alt_text: string
    variants: Record<string, string> | null
    width: number | null
    height: number | null
  }> = []
  if (mediaIds.size > 0) {
    const ids = [...mediaIds]
    const [rows] = (await db.execute(sql`
      SELECT id, alt_text, variants, width, height
      FROM media
      WHERE id IN (${sql.join(ids, sql.raw(','))})
        AND deleted_at IS NULL
    `)) as unknown as [
      Array<{
        id: number
        alt_text: string
        variants: string | Record<string, string> | null
        width: number | null
        height: number | null
      }>,
    ]
    mediaRows = rows.map((r) => ({
      ...r,
      variants: parseMediaVariants(r.variants, r.id),
      width: r.width ?? null,
      height: r.height ?? null,
    }))
  }

  return {
    project,
    sections,
    media: new Map(mediaRows.map((r) => [r.id, r])),
  }
}
