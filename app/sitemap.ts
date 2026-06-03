import type { MetadataRoute } from 'next'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { env } from '@/lib/env'
import { isMissingTable } from '@/lib/db/errors'
// blog-system worktree (Phase 5): segment-aware URL construction for the blog +
// projects index/detail/archive entries. resolveSegments() reads the configured
// permalink segments once; the helpers below honor them.
import { blogIndexUrl, categoryUrl, postUrl, projectUrl, tagUrl } from '@/lib/blog/urls'
import { resolveSegments } from '@/lib/blog/resolveSegments'
// blog-system worktree (Phase 8): public post-visibility gate. Applied to the
// per-post entries AND the category/tag archive "has ≥1 live post" gates so a
// scheduled (future-dated) post never seeds a sitemap URL — for the post itself
// OR for an archive that would otherwise become indexable on the strength of a
// not-yet-live post.
import { publicPostConditionSql } from '@/lib/cms/postStatus'

export const dynamic = 'force-dynamic'

// PR-2 §2.7: the static-page URL set is no longer hard-coded — it
// comes from the `pages` table via `url_path` (the STORED generated
// column). The home row emits `/` and non-home rows emit `/{slug}`
// from a single column — no special-case branching, no `'/' + slug`
// ad-hoc construction anywhere.
//
// ORDER BY discipline: `is_home DESC` ensures the home row is always
// the first row returned. The 5000 cap (`slice(0, 5000)`) is taken
// from the START of the ordered list, so the home `/` URL is NEVER
// truncated even if `pages` grows past the cap. `updated_at DESC` is
// the tiebreaker so the most-recently-edited content surfaces first.
//
// The /projects and /blog INDEX entries are emitted explicitly in the return
// below — they are listing routes, not CMS-managed pages. blog-system worktree
// (Phase 5): those index URLs are now SEGMENT-AWARE (built from the configured
// permalink segments via lib/blog/urls), so the former hard-coded
// STATIC_LISTING_PATHS array was removed. The posts SELECT below adds per-post
// entries once the table exists.

// Build-time constant for static-path lastModified, validated at
// boot via lib/env.ts. Using `new Date()` per request would lie to
// crawlers ("everything changed!") and burn crawl budget; pinning
// to CAVECMS_RELEASE_TS stays stable across the lifetime of a release.
const RELEASE_LAST_MOD = new Date(env.CAVECMS_RELEASE_TS)

// Hard cap matching the sitemap spec recommendation (50k per file)
// but lower for crawl-budget hygiene. When `pages` grows past this,
// `logWarn`-style structured log surfaces in PM2/nginx logs so ops
// can schedule the sitemap-index migration (out of scope this PR).
const SITEMAP_PAGE_CAP = 5000

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Host-aware. Only the apex production host serves a sitemap of
  // production URLs; staging hosts, preview hosts, localhost, IP
  // access etc. all serve an empty sitemap so a non-production
  // origin can never leak production URLs as canonical to a
  // crawler that happens to find it.
  // Site URL is operator-configured (Settings → General). Until the
  // operator sets it, we return an empty sitemap — better than
  // emitting URLs against the wrong origin.
  const { getSiteOrigin } = await import('@/lib/cms/getSiteOrigin')
  const configuredOrigin = await getSiteOrigin()
  if (!configuredOrigin) return []
  const host = (await headers()).get('host') ?? ''
  const apexHost = new URL(configuredOrigin).host
  if (host !== apexHost) return []
  const origin = configuredOrigin

  // blog-system worktree (Phase 5): resolve the configured permalink segments
  // once so every blog/projects URL below honors a custom segment + structure.
  const segments = await resolveSegments()

  // Parallel reads via Promise.allSettled — one query rejecting (a
  // slow lock on projects, a transient pages query) must NOT take
  // down the whole sitemap. A 500 on /sitemap.xml burns crawl budget
  // and trains a negative crawler signal; partial sitemap is
  // strictly better than no sitemap. Each rejected branch emits a
  // structured warning so operators see the partial-failure signal.
  // posts retains its existing missing-table feature-detect (the
  // table may not exist yet during early Plan 06 deploys).
  const settled = await Promise.allSettled([
    (async () => {
      // SELECT one over the cap so we can detect overflow. The
      // ORDER BY guarantees the home row (is_home=1) is first and
      // therefore never truncated.
      const [rows] = (await db.execute(sql`
        SELECT url_path, is_home, updated_at
        FROM pages
        WHERE published = 1 AND deleted_at IS NULL
          -- Exclude hidden post-body pages (kind='post_body'); they are
          -- never routable URLs (spec §4.4 guard checklist).
          AND kind = 'page'
        ORDER BY is_home DESC, updated_at DESC
        LIMIT ${SITEMAP_PAGE_CAP + 1}
      `)) as unknown as [
        Array<{ url_path: string | null; is_home: number | boolean; updated_at: Date }>,
      ]
      return rows
    })(),
    (async () => {
      const [rows] = (await db.execute(sql`
        SELECT slug, updated_at
        FROM projects
        WHERE published = TRUE AND deleted_at IS NULL
      `)) as unknown as [Array<{ slug: string; updated_at: Date }>]
      return rows
    })(),
    (async () => {
      try {
        const [rows] = (await db.execute(sql`
          SELECT p.slug, p.updated_at, p.published_at
          FROM posts p
          WHERE ${publicPostConditionSql('p')}
        `)) as unknown as [
          Array<{ slug: string; updated_at: Date; published_at: Date | string | null }>,
        ]
        return rows
      } catch (err) {
        if (!isMissingTable(err)) throw err
        return []
      }
    })(),
    // ── blog-system worktree: taxonomy archives (do not interleave) ─────
    // Category + tag archive URLs — ONLY for terms with ≥1 PUBLICLY-VISIBLE post
    // (Phase 8 gate: published + non-trashed + publish time arrived, so a term
    // whose only post is scheduled stays out of the sitemap until it goes live).
    // An empty/not-yet-live archive is a thin/soft-404 page Google shouldn't
    // index. EXISTS keeps the gate sargable. lastModified is the newest VISIBLE
    // post in the term so crawlers get an honest signal.
    // Missing-table-safe (taxonomy may not exist on an early-migration box).
    (async () => {
      try {
        const [rows] = (await db.execute(sql`
          SELECT c.slug,
                 (SELECT MAX(p.updated_at)
                  FROM post_categories pc
                  JOIN posts p ON p.id = pc.post_id
                  WHERE pc.category_id = c.id
                    AND ${publicPostConditionSql('p')}) AS last_mod
          FROM categories c
          WHERE EXISTS (
            SELECT 1 FROM post_categories pc
            JOIN posts p ON p.id = pc.post_id
            WHERE pc.category_id = c.id
              AND ${publicPostConditionSql('p')}
          )
        `)) as unknown as [Array<{ slug: string; last_mod: Date | null }>]
        return rows
      } catch (err) {
        if (!isMissingTable(err)) throw err
        return []
      }
    })(),
    (async () => {
      try {
        const [rows] = (await db.execute(sql`
          SELECT t.slug,
                 (SELECT MAX(p.updated_at)
                  FROM post_tags pt
                  JOIN posts p ON p.id = pt.post_id
                  WHERE pt.tag_id = t.id
                    AND ${publicPostConditionSql('p')}) AS last_mod
          FROM tags t
          WHERE EXISTS (
            SELECT 1 FROM post_tags pt
            JOIN posts p ON p.id = pt.post_id
            WHERE pt.tag_id = t.id
              AND ${publicPostConditionSql('p')}
          )
        `)) as unknown as [Array<{ slug: string; last_mod: Date | null }>]
        return rows
      } catch (err) {
        if (!isMissingTable(err)) throw err
        return []
      }
    })(),
    // ── end blog-system worktree taxonomy archives ─────────────────────
  ])
  const pageRowsResult = settled[0]
  const projectRowsResult = settled[1]
  const postRowsResult = settled[2]
  // blog-system worktree: taxonomy archive results
  const categoryRowsResult = settled[3]
  const tagRowsResult = settled[4]
  function unwrap<T>(
    result: PromiseSettledResult<T>,
    label: string,
  ): T | null {
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
  const pageRows = unwrap(pageRowsResult, 'pages') ?? []
  const projectRows = unwrap(projectRowsResult, 'projects') ?? []
  const postRows = unwrap(postRowsResult, 'posts') ?? []
  // blog-system worktree: taxonomy archive rows
  const categoryRows = unwrap(categoryRowsResult, 'categories') ?? []
  const tagRows = unwrap(tagRowsResult, 'tags') ?? []

  if (pageRows.length > SITEMAP_PAGE_CAP) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'sitemap_truncated',
        count: pageRows.length,
        omitted: pageRows.length - SITEMAP_PAGE_CAP,
      }),
    )
  }

  const pageEntries = pageRows.slice(0, SITEMAP_PAGE_CAP).map((p) => ({
    // `url_path` is the canonical single column. Fall back to `/`
    // for the home row (the runtime expression never produces NULL,
    // but the TS column type is nullable per Drizzle 0.36 + MariaDB
    // STORED-generated-column limitations).
    url: `${origin}${p.url_path ?? '/'}`,
    lastModified: p.updated_at,
    changeFrequency: 'monthly' as const,
    // Truthy check (not `=== 1`) so a future mysql2 typecast config
    // that converts TINYINT(1) to JS boolean doesn't silently
    // collapse home priority to 0.7. is_home is `0|1|true|false` at
    // the row layer; both `1` and `true` are truthy.
    priority: p.is_home ? 1.0 : 0.7,
  }))

  return [
    ...pageEntries,
    // blog-system worktree (Phase 5): the blog + projects INDEX URLs are
    // segment-aware (STATIC_LISTING_PATHS' literals are kept only as the
    // structural marker — the emitted URLs come from the helpers).
    {
      url: `${origin}/${segments.projects}`,
      lastModified: RELEASE_LAST_MOD,
    },
    {
      url: `${origin}${blogIndexUrl(1, segments)}`,
      lastModified: RELEASE_LAST_MOD,
    },
    ...projectRows.map((p) => ({
      url: `${origin}${projectUrl(p.slug, segments)}`,
      lastModified: p.updated_at,
    })),
    ...postRows.map((p) => ({
      url: `${origin}${postUrl(p.slug, segments, p.published_at)}`,
      lastModified: p.updated_at,
    })),
    // ── blog-system worktree: taxonomy archive URLs (do not interleave) ──
    // Category + tag archives with ≥1 live post. lastModified falls back to
    // the release timestamp when the MAX() subquery returned NULL (shouldn't
    // happen given the EXISTS gate, but defends against a race). URLs route
    // through lib/blog/urls (segment-aware) so a Phase-5 segment change updates
    // them here too.
    ...categoryRows.map((c) => ({
      url: `${origin}${categoryUrl(c.slug, 1, segments)}`,
      lastModified: c.last_mod ?? RELEASE_LAST_MOD,
    })),
    ...tagRows.map((t) => ({
      url: `${origin}${tagUrl(t.slug, 1, segments)}`,
      lastModified: t.last_mod ?? RELEASE_LAST_MOD,
    })),
    // ── end blog-system worktree taxonomy archive URLs ──────────────────
  ]
}
