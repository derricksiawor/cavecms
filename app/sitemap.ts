import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { env } from '@/lib/env'
import { isMissingTable } from '@/lib/db/errors'
import { getSetting } from '@/lib/cms/getSettings'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────
// SEO-suite-aware dynamic sitemap.
//
// This route reads the operator-configured `seo_sitemap` setting
// (Settings → SEO → Sitemap; see lib/cms/settings-registry.ts →
// seoSitemap) and shapes the output accordingly:
//
//   • enabled        — false → emit a completely empty sitemap.
//   • includePages / includePosts / includeProjects — per-type toggles.
//     A disabled type contributes NEITHER its detail URLs NOR its
//     /projects /blog listing route (a listing whose children are all
//     suppressed is itself a dead crawl signal).
//   • excludeNoindex — default true. Entities carrying robots_noindex=1
//     (migration 0032) are filtered out of the sitemap at the SQL layer.
//     A noindexed URL that nonetheless appears in the sitemap is a
//     contradictory crawl signal ("index this" vs "don't index this");
//     excluding it keeps the two channels consistent.
//   • includeImages  — attach each entity's OG/hero image (absolute URL)
//     to its sitemap entry via Next's per-entry `images: string[]`.
//     Images are resolved with a SINGLE batched `WHERE id IN (…)` media
//     query (NOT per row) so there is no N+1 — see resolveImageMap below.
//
// Also honoured: the global `seo_indexing.discourageSearchEngines`
// kill-switch — when the operator hides the whole site, robots.txt drops
// its `Sitemap:` line and a direct /sitemap.xml hit serves an empty
// sitemap (buildEntries returns null), so the two channels never
// contradict.
//
// SCALABILITY (#0.251): this is a SINGLE-FILE sitemap. The ordered entry
// list is capped at MAX_TOTAL_ENTRIES (50,000 — the sitemaps.org
// single-file URL ceiling), home-first so the homepage is never dropped;
// any overflow is truncated from the TAIL and logged — never silently
// lost. A CaveCMS install with >50k indexable URLs is not realistic for
// this product; see the default export for the (deliberately not-taken)
// sitemap-index path and why.
//
// Preserved from the prior implementation: host-awareness (only the
// configured apex serves production URLs), Promise.allSettled resilience
// (one failing query yields a partial sitemap, never a 500), the posts
// missing-table feature-detect, the `url_path` canonical column, and
// home-first ordering.
// ─────────────────────────────────────────────────────────────────────

// /projects and /blog are listing routes, not CMS-managed `pages` rows.
// They are emitted only when their corresponding content type is
// included (see buildEntries). The per-detail entries (project/post)
// are appended separately from their own SELECTs.
const STATIC_PROJECTS_PATH = '/projects'
const STATIC_BLOG_PATH = '/blog'

// Build-time constant for static-path lastModified, validated at boot via
// lib/env.ts. Using `new Date()` per request would lie to crawlers
// ("everything changed!") and burn crawl budget; pinning to
// CAVECMS_RELEASE_TS stays stable across the lifetime of a release.
const RELEASE_LAST_MOD = new Date(env.CAVECMS_RELEASE_TS)

// Hard ceiling on TOTAL URLs in this single-file sitemap — the
// sitemaps.org per-file limit is 50,000 URLs. We cap at exactly that for
// crawl-budget hygiene and so a runaway content table can't stream an
// unbounded entry list. If the real entry count exceeds this, the
// overflow is logged and truncated from the TAIL of the ordered list
// (home `/` is at the head, so it is never the entry that falls off).
const MAX_TOTAL_ENTRIES = 50_000

type Entry = MetadataRoute.Sitemap[number]

interface PageRow {
  url_path: string | null
  is_home: number | boolean
  updated_at: Date
  og_image_id: number | null
  hero_image_id: number | null
}
interface ProjectRow {
  slug: string
  updated_at: Date
  og_image_id: number | null
  hero_image_id: number | null
}
interface PostRow {
  slug: string
  updated_at: Date
  og_image_id: number | null
  hero_image_id: number | null
}

// Resolve a set of media ids → their best public path in ONE query.
// Mirrors lib/cms/resolveMedia.ts's variant selection (og → lg → md →
// thumb) but batches across all referenced ids so the image-enabled
// sitemap stays O(1) queries instead of O(rows). Returns a map of
// id → relative path (e.g. `/uploads/…`); callers absolutize with the
// origin. Failures degrade to an empty map (the sitemap still emits,
// just without images) — an image-less sitemap is strictly better than
// a 500.
async function resolveImageMap(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const unique = [...new Set(ids.filter((n): n is number => typeof n === 'number' && n > 0))]
  if (unique.length === 0) return out
  let rows: Array<{ id: number; variants: unknown }>
  try {
    const [r] = (await db.execute(sql`
      SELECT id, variants
      FROM media
      WHERE id IN (${sql.join(unique, sql`, `)})
        AND deleted_at IS NULL
    `)) as unknown as [Array<{ id: number; variants: unknown }>]
    rows = r
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'sitemap_image_query_failed',
        err_name: err instanceof Error ? err.name : 'unknown',
      }),
    )
    return out
  }
  for (const row of rows) {
    let raw: unknown = row.variants
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch {
        continue
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const v = raw as { thumb?: string; md?: string; lg?: string; og?: string }
    const best = v.og ?? v.lg ?? v.md ?? v.thumb
    if (typeof best === 'string' && best.length > 0) out.set(row.id, best)
  }
  return out
}

function absolutizeImage(origin: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${origin}${path.startsWith('/') ? '' : '/'}${path}`
}

// Build the COMPLETE ordered entry list for the current request. Returns
// null when the sitemap is disabled or no site origin is configured
// (caller emits []). Home-first ordering (is_home DESC) keeps the
// homepage at the head so the 50k tail-cap never drops it.
async function buildEntries(): Promise<Entry[] | null> {
  // Host-aware. Only the apex production host serves a sitemap of
  // production URLs; staging hosts, preview hosts, localhost, IP access
  // etc. all serve an empty sitemap so a non-production origin can never
  // leak production URLs as canonical. Site URL is operator-configured
  // (Settings → General); until set, we return null → empty sitemap.
  const { getSiteOrigin } = await import('@/lib/cms/getSiteOrigin')
  const configuredOrigin = await getSiteOrigin()
  if (!configuredOrigin) return null
  const host = (await headers()).get('host') ?? ''
  const apexHost = new URL(configuredOrigin).host
  if (host !== apexHost) return null
  const origin = configuredOrigin

  // Sitemap configuration. getSetting fails closed to the registry
  // default (enabled + every include true + excludeNoindex true + images
  // on), so `cfg` is always a well-formed object.
  const cfg = await getSetting('seo_sitemap')
  if (cfg.enabled === false) return null

  // Global "discourage search engines" kill-switch. When the operator
  // hides the whole site, robots.txt already drops the `Sitemap:` line —
  // a direct /sitemap.xml hit must likewise serve nothing, or the two
  // channels contradict (robots says "don't crawl", sitemap says "here's
  // everything"). Read alongside the sitemap config.
  const indexing = await getSetting('seo_indexing')
  if (indexing.discourageSearchEngines) return null

  // `excludeNoindex` (default true): keep only entities whose
  // robots_noindex is 0/NULL. The `IS NULL` arm covers rows created
  // before migration 0032 backfilled the column on some engines.
  const noindexClause = cfg.excludeNoindex
    ? sql` AND (robots_noindex = 0 OR robots_noindex IS NULL)`
    : sql``

  // Image columns are only SELECTed (and the media batch only runs) when
  // includeImages is on — no wasted columns / no media round-trip when off.
  const wantImages = cfg.includeImages === true

  // Parallel reads via Promise.allSettled — one query rejecting (a slow
  // lock on projects, a transient pages query) must NOT take down the
  // whole sitemap. A 500 on the sitemap burns crawl budget and trains a
  // negative crawler signal; a partial sitemap is strictly better. Each
  // rejected branch emits a structured warning. A disabled content type
  // skips its query entirely (resolves to []). posts retains its
  // missing-table feature-detect (the table may not exist on early deploys).
  const settled = await Promise.allSettled([
    cfg.includePages
      ? (async () => {
          // SELECT all matching rows ordered home-first. The hard
          // MAX_TOTAL_ENTRIES guard is applied after the merge, not per
          // table, so home (is_home=1, first) is never the dropped row.
          const [rows] = (await db.execute(sql`
            SELECT url_path, is_home, updated_at, og_image_id, hero_image_id
            FROM pages
            WHERE published = 1 AND deleted_at IS NULL${noindexClause}
            ORDER BY is_home DESC, updated_at DESC
            LIMIT ${MAX_TOTAL_ENTRIES + 1}
          `)) as unknown as [PageRow[]]
          return rows
        })()
      : Promise.resolve([] as PageRow[]),
    cfg.includeProjects
      ? (async () => {
          const [rows] = (await db.execute(sql`
            SELECT slug, updated_at, og_image_id, hero_image_id
            FROM projects
            WHERE published = TRUE AND deleted_at IS NULL${noindexClause}
            LIMIT ${MAX_TOTAL_ENTRIES + 1}
          `)) as unknown as [ProjectRow[]]
          return rows
        })()
      : Promise.resolve([] as ProjectRow[]),
    cfg.includePosts
      ? (async () => {
          try {
            const [rows] = (await db.execute(sql`
              SELECT slug, updated_at, og_image_id, hero_image_id
              FROM posts
              WHERE published = TRUE AND deleted_at IS NULL${noindexClause}
              LIMIT ${MAX_TOTAL_ENTRIES + 1}
            `)) as unknown as [PostRow[]]
            return rows
          } catch (err) {
            if (!isMissingTable(err)) throw err
            return [] as PostRow[]
          }
        })()
      : Promise.resolve([] as PostRow[]),
  ])

  function unwrap<T>(result: PromiseSettledResult<T>, label: string): T | null {
    if (result.status === 'fulfilled') return result.value
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'sitemap_query_failed',
        which: label,
        err_name: result.reason instanceof Error ? result.reason.name : 'unknown',
      }),
    )
    return null
  }
  const pageRows = unwrap(settled[0], 'pages') ?? []
  const projectRows = unwrap(settled[1], 'projects') ?? []
  const postRows = unwrap(settled[2], 'posts') ?? []

  // Image resolution: collect every referenced media id across all three
  // surfaces and resolve them in ONE batched query (no N+1). Prefer the
  // entity's og_image_id, fall back to hero_image_id.
  let imageMap = new Map<number, string>()
  if (wantImages) {
    const ids: number[] = []
    const collect = (r: { og_image_id: number | null; hero_image_id: number | null }) => {
      if (r.og_image_id) ids.push(r.og_image_id)
      if (r.hero_image_id) ids.push(r.hero_image_id)
    }
    pageRows.forEach(collect)
    projectRows.forEach(collect)
    postRows.forEach(collect)
    imageMap = await resolveImageMap(ids)
  }
  // Pick the best image URL for an entity (og first, then hero) and
  // absolutize it. Returns undefined when images are off or none resolved.
  const imagesFor = (
    r: { og_image_id: number | null; hero_image_id: number | null },
  ): string[] | undefined => {
    if (!wantImages) return undefined
    const path =
      (r.og_image_id != null ? imageMap.get(r.og_image_id) : undefined) ??
      (r.hero_image_id != null ? imageMap.get(r.hero_image_id) : undefined)
    return path ? [absolutizeImage(origin, path)] : undefined
  }

  const pageEntries: Entry[] = pageRows.map((p) => {
    const images = imagesFor(p)
    return {
      // `url_path` is the canonical single column. Fall back to `/` for
      // the home row (the runtime expression never produces NULL, but the
      // TS column type is nullable per Drizzle 0.36 + MariaDB STORED-
      // generated-column limitations).
      url: `${origin}${p.url_path ?? '/'}`,
      lastModified: p.updated_at,
      changeFrequency: 'monthly' as const,
      // Truthy check (not `=== 1`) so a future mysql2 typecast config that
      // converts TINYINT(1) to JS boolean doesn't silently collapse home
      // priority to 0.7. is_home is `0|1|true|false` at the row layer.
      priority: p.is_home ? 1.0 : 0.7,
      ...(images ? { images } : {}),
    }
  })

  // Listing routes are tied to their content type: /projects only when
  // projects are included, /blog only when posts are included.
  const listingEntries: Entry[] = []
  if (cfg.includeProjects) {
    listingEntries.push({ url: `${origin}${STATIC_PROJECTS_PATH}`, lastModified: RELEASE_LAST_MOD })
  }
  if (cfg.includePosts) {
    listingEntries.push({ url: `${origin}${STATIC_BLOG_PATH}`, lastModified: RELEASE_LAST_MOD })
  }

  const projectEntries: Entry[] = projectRows.map((p) => {
    const images = imagesFor(p)
    return {
      url: `${origin}/projects/${p.slug}`,
      lastModified: p.updated_at,
      ...(images ? { images } : {}),
    }
  })
  const postEntries: Entry[] = postRows.map((p) => {
    const images = imagesFor(p)
    return {
      url: `${origin}/blog/${p.slug}`,
      lastModified: p.updated_at,
      ...(images ? { images } : {}),
    }
  })

  const all = [...pageEntries, ...listingEntries, ...projectEntries, ...postEntries]

  // Absolute safety cap on the single-file URL count. Home (`/`) is
  // ordered first (pageEntries leads, is_home first within it), so the
  // tail is what falls off — never the homepage.
  if (all.length > MAX_TOTAL_ENTRIES) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'sitemap_total_capped',
        count: all.length,
        omitted: all.length - MAX_TOTAL_ENTRIES,
        cap: MAX_TOTAL_ENTRIES,
      }),
    )
    return all.slice(0, MAX_TOTAL_ENTRIES)
  }
  return all
}

// Single `/sitemap.xml`. A default export with NO `generateSitemaps`
// makes Next serve the canonical `/sitemap.xml` URL that robots.txt
// references. (We deliberately do NOT use Next 15's `generateSitemaps`
// sitemap-index splitting: in this Next version it serves shards at
// `/sitemap/<id>.xml` and does NOT auto-create a `/sitemap.xml` index,
// so robots.txt's `Sitemap: …/sitemap.xml` would 404 — verified at
// runtime. A valid single sitemap beats a clever-but-unreachable split.)
//
// `buildEntries()` already caps the ordered list at MAX_TOTAL_ENTRIES
// (50,000 — the sitemaps.org single-file URL limit), home-first so the
// homepage is never the dropped entry, logging the overflow. A CaveCMS
// install exceeding 50k indexable URLs is not a realistic scenario; if it
// ever became one, the correct evolution is a hand-built `<sitemapindex>`
// route (NOT generateSitemaps, which breaks the canonical URL).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return (await buildEntries()) ?? []
}
