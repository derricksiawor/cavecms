import 'server-only'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { publicPostGateSql } from './postStatus'
import { readingTimeSql } from './readingTime'
import { isMissingTable } from '@/lib/db/errors'
import { categoryUrl, postUrl } from '@/lib/blog/urls'
import type { PermalinkSegments } from '@/lib/blog/urls'

// ════════════════════════════════════════════════════════════════════
// Posts-widget SOURCE model (#2). The "add to any page" query layer for
// the SELF-CONTAINED sources of the expanded lx_posts block:
//
//   latest    — newest published posts (offset/orderBy/orderDir aware)
//   category  — posts in a category slug
//   tag       — posts in a tag slug
//   author    — posts by an author id
//   manual    — operator-picked post ids, IN the picked order
//   related   — same-category-then-recency relative to the current post
//
// The 'current' source (the paginated /blog archive) is NOT handled here —
// it stays in hydrate.fetchPostsLoopSlice (keyset/OFFSET pager + ?page=).
// This module returns a FLAT, bounded, non-paginated card list; the
// template (grid/cards/list/magazine/carousel) decides how to lay it out.
//
// SCALABILITY (#0.251): every query is parameterised + bounded by a hard
// LIMIT (the block's `limit`, ceiling 24). reading_minutes is computed in
// SQL (body text never crosses into app memory). Categories + authors for
// the WHOLE slice are batch-fetched in ONE query each (no N+1). A 5,000-
// post blog renders a 6-card grid in the same constant cost as a 6-post
// blog.
// ════════════════════════════════════════════════════════════════════

/** One card the posts-widget renderer consumes. Superset of the loop-item
 *  shape (adds the optional author block); every URL is baked here at
 *  hydrate so the SYNCHRONOUS renderer never builds a segment-aware URL. */
export interface HydratedPostCard {
  id: number
  slug: string
  title: string
  excerpt: string | null
  published_at: Date | string | null
  hero_image_id: number | null
  reading_minutes: number
  categories: Array<{ slug: string; name: string; url: string }>
  /** Author display block — populated only when the slice resolves authors
   *  (showAuthor). `name` may be null (anonymous / deleted author); the
   *  renderer falls back to a generic monogram. */
  author?: { id: number; name: string | null } | null
  url: string
}

export type PostsWidgetOrderBy = 'date' | 'modified' | 'title' | 'reading-time' | 'random'
export type PostsWidgetOrderDir = 'desc' | 'asc'

export type PostsWidgetSource =
  | { kind: 'latest' }
  | { kind: 'category'; slug: string }
  | { kind: 'tag'; slug: string }
  | { kind: 'author'; authorId: number }
  | { kind: 'manual'; ids: number[] }
  | { kind: 'related'; currentPostId: number; categorySlugs?: string[] }

export interface PostsWidgetSliceArgs {
  segments: PermalinkSegments
  source: PostsWidgetSource
  /** Hard upper bound on cards returned. Clamped to [1, 24]. */
  limit: number
  /** Skip the first N matches (so a magazine lead + a grid below don't
   *  duplicate). Clamped to [0, 100]. Ignored for `manual` (the operator's
   *  picked order IS the source; an offset there is surprising). */
  offset?: number
  orderBy?: PostsWidgetOrderBy
  orderDir?: PostsWidgetOrderDir
  /** Drop this post id from the result (post-detail placements). `related`
   *  always excludes its own currentPostId regardless of this flag. */
  excludePostId?: number
  /** Whether the slice should resolve author display names (one batch query
   *  when true). Off by default to save a round-trip when showAuthor is off. */
  withAuthors?: boolean
}

const MAX_CARDS = 24
const MAX_OFFSET = 100

function clampLimit(n: number): number {
  return Math.min(MAX_CARDS, Math.max(1, Math.floor(n)))
}
function clampOffset(n: number | undefined): number {
  return Math.min(MAX_OFFSET, Math.max(0, Math.floor(n ?? 0)))
}

// ORDER BY expression — parameter-free (column names are fixed literals, not
// user input). `random` uses RAND(); bounded by the LIMIT so it never sorts a
// huge set into memory (MySQL still scans, but the gate + LIMIT cap the cost at
// v1 blog scale). The (col, id) tiebreak keeps pagination/order deterministic.
function orderExpr(orderBy: PostsWidgetOrderBy, dir: PostsWidgetOrderDir): SQL {
  const d = dir === 'asc' ? sql.raw('ASC') : sql.raw('DESC')
  switch (orderBy) {
    case 'title':
      return sql`ORDER BY p.title ${d}, p.id ${d}`
    case 'modified':
      return sql`ORDER BY p.updated_at ${d}, p.id ${d}`
    case 'reading-time':
      return sql`ORDER BY reading_minutes ${d}, p.id ${d}`
    case 'random':
      return sql`ORDER BY RAND()`
    case 'date':
    default:
      return sql`ORDER BY p.published_at ${d}, p.id ${d}`
  }
}

/** Build the source-specific WHERE fragment (taxonomy / author / id filters).
 *  Every value is bound as a parameter; slugs are SLUG_RE-validated at the
 *  block boundary and ids are positive ints from the Zod schema. */
function sourceFilter(source: PostsWidgetSource): SQL {
  switch (source.kind) {
    case 'category':
      return sql`
        AND EXISTS (
          SELECT 1 FROM post_categories pc
          JOIN categories c ON c.id = pc.category_id
          WHERE pc.post_id = p.id AND c.slug = ${source.slug}
        )`
    case 'tag':
      return sql`
        AND EXISTS (
          SELECT 1 FROM post_tags pt
          JOIN tags t ON t.id = pt.tag_id
          WHERE pt.post_id = p.id AND t.slug = ${source.slug}
        )`
    case 'author':
      return sql`AND p.author_id = ${source.authorId}`
    case 'related':
      // Same-category-then-recency. The category set is resolved by the caller
      // (one query) and passed in; when the current post has NO categories we
      // fall back to plain recency (empty fragment), still excluding self.
      if (source.categorySlugs && source.categorySlugs.length > 0) {
        return sql`
          AND EXISTS (
            SELECT 1 FROM post_categories pc
            JOIN categories c ON c.id = pc.category_id
            WHERE pc.post_id = p.id AND c.slug IN (${sql.join(source.categorySlugs, sql.raw(','))})
          )`
      }
      return sql``
    case 'manual':
    case 'latest':
    default:
      return sql``
  }
}

/** Resolve a SELF-CONTAINED posts-widget slice. Returns at most `limit` cards
 *  (bounded), public-gated, with categories (+ optionally authors) batch-
 *  fetched. Missing-table-safe (returns []), so the widget renders its empty
 *  state on an install without the blog schema yet. */
export async function fetchPostsWidgetSlice(
  args: PostsWidgetSliceArgs,
): Promise<HydratedPostCard[]> {
  const limit = clampLimit(args.limit)
  const offset = args.source.kind === 'manual' ? 0 : clampOffset(args.offset)

  // ── manual: fetch the picked ids, then re-order IN the operator's order ──
  if (args.source.kind === 'manual') {
    const ids = Array.from(new Set(args.source.ids))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, limit)
    if (ids.length === 0) return []
    try {
      const readingExpr = readingTimeSql('p')
      const [rows] = (await db.execute(sql`
        SELECT
          p.id, p.slug, p.title, p.excerpt, p.published_at, p.hero_image_id,
          p.author_id, ${readingExpr} AS reading_minutes
        FROM posts p
        WHERE p.id IN (${sql.join(ids, sql.raw(','))})
          ${publicPostGateSql('p')}
        LIMIT ${ids.length}
      `)) as unknown as [Array<RawCardRow>]
      const byId = new Map(rows.map((r) => [r.id, r]))
      // Preserve the operator's picked order; drop ids that didn't resolve
      // (unpublished / trashed / scheduled — public-gated out).
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((r): r is RawCardRow => r !== undefined)
        .filter((r) => r.id !== args.excludePostId)
      return await decorateCards(ordered, args.segments, args.withAuthors ?? false)
    } catch (err) {
      if (isMissingTable(err)) return []
      throw err
    }
  }

  // ── latest / category / tag / author / related ──────────────────────────
  try {
    const readingExpr = readingTimeSql('p')
    const filter = sourceFilter(args.source)
    const order = orderExpr(args.orderBy ?? 'date', args.orderDir ?? 'desc')
    // related always excludes its own post; other sources exclude only when
    // the caller asks (post-detail placement).
    const excludeId =
      args.source.kind === 'related' ? args.source.currentPostId : args.excludePostId
    const excludeFragment = excludeId ? sql`AND p.id <> ${excludeId}` : sql``

    const [rows] = (await db.execute(sql`
      SELECT
        p.id, p.slug, p.title, p.excerpt, p.published_at, p.hero_image_id,
        p.author_id, ${readingExpr} AS reading_minutes
      FROM posts p
      WHERE 1 = 1
        ${publicPostGateSql('p')}
        ${filter}
        ${excludeFragment}
      ${order}
      LIMIT ${limit} OFFSET ${offset}
    `)) as unknown as [Array<RawCardRow>]
    return await decorateCards(rows, args.segments, args.withAuthors ?? false)
  } catch (err) {
    if (isMissingTable(err)) return []
    throw err
  }
}

interface RawCardRow {
  id: number
  slug: string
  title: string
  excerpt: string | null
  published_at: Date | string | null
  hero_image_id: number | null
  author_id: number | null
  reading_minutes: number | string | bigint
}

/** Batch-attach categories (always) + authors (optional) to a raw row set in
 *  ONE query each (no N+1), then bake the segment-aware URLs. Shared by every
 *  source branch. */
async function decorateCards(
  rows: RawCardRow[],
  segments: PermalinkSegments,
  withAuthors: boolean,
): Promise<HydratedPostCard[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  // Categories for ALL cards in one query, ordered by (post, category position)
  // so each card's pills are stable. Capped to 2 per card at map time.
  const catByPost = new Map<number, Array<{ slug: string; name: string; url: string }>>()
  const [pcRows] = (await db.execute(sql`
    SELECT pc.post_id, c.slug, c.name
    FROM post_categories pc
    JOIN categories c ON c.id = pc.category_id
    WHERE pc.post_id IN (${sql.join(ids, sql.raw(','))})
    ORDER BY pc.post_id, c.position, c.id
  `)) as unknown as [Array<{ post_id: number; slug: string; name: string }>]
  for (const pc of pcRows) {
    const list = catByPost.get(pc.post_id) ?? []
    list.push({ slug: pc.slug, name: pc.name, url: categoryUrl(pc.slug, 1, segments) })
    catByPost.set(pc.post_id, list)
  }

  // Authors for ALL cards in one query (only when requested). A null/absent
  // author_id, or a deleted user, leaves author null → renderer monogram.
  const authorById = new Map<number, { id: number; name: string | null }>()
  if (withAuthors) {
    const authorIds = Array.from(
      new Set(rows.map((r) => r.author_id).filter((a): a is number => typeof a === 'number')),
    )
    if (authorIds.length > 0) {
      const [aRows] = (await db.execute(sql`
        SELECT id, name FROM users
        WHERE id IN (${sql.join(authorIds, sql.raw(','))})
      `)) as unknown as [Array<{ id: number; name: string | null }>]
      for (const a of aRows) authorById.set(a.id, { id: a.id, name: a.name })
    }
  }

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    published_at: r.published_at,
    hero_image_id: r.hero_image_id,
    reading_minutes: Math.max(1, Number(r.reading_minutes) || 1),
    categories: (catByPost.get(r.id) ?? []).slice(0, 2),
    author: withAuthors
      ? r.author_id != null
        ? authorById.get(r.author_id) ?? { id: r.author_id, name: null }
        : null
      : undefined,
    url: postUrl(r.slug, segments, r.published_at),
  }))
}

/** Map a parsed self-contained lx_posts block's fields → the source descriptor
 *  the fetcher consumes. Returns null when the source's required operand is
 *  missing (e.g. source:'category' with no slug, source:'author' with no id,
 *  source:'related' off a non-post page) — the caller then renders the empty
 *  state. `current` is handled by the loop path, never here. Pure (no DB), so
 *  it's unit-testable independent of hydrate.
 *
 *  Typed structurally (not against the server-only block-registry) so the test
 *  can call it with a plain object. */
export function resolvePostsWidgetSource(
  d: {
    source: string
    category?: string
    tag?: string
    authorId?: number
    manualPostIds?: number[]
  },
  currentPostId: number | undefined,
  relatedCategorySlugs: string[] | undefined,
): PostsWidgetSource | null {
  switch (d.source) {
    case 'latest':
      return { kind: 'latest' }
    case 'category':
      return d.category ? { kind: 'category', slug: d.category } : null
    case 'tag':
      return d.tag ? { kind: 'tag', slug: d.tag } : null
    case 'author':
      return typeof d.authorId === 'number' ? { kind: 'author', authorId: d.authorId } : null
    case 'manual':
      return d.manualPostIds && d.manualPostIds.length > 0
        ? { kind: 'manual', ids: d.manualPostIds }
        : null
    case 'related':
      return typeof currentPostId === 'number'
        ? { kind: 'related', currentPostId, categorySlugs: relatedCategorySlugs }
        : null
    case 'current':
    default:
      return null
  }
}

/** Resolve the category slugs of a post (for `source:'related'`). One bounded
 *  query, capped. Missing-table-safe. Exported so hydrate can resolve the
 *  related anchor's categories before fetching the related slice. */
export async function fetchPostCategorySlugs(postId: number): Promise<string[]> {
  try {
    const [rows] = (await db.execute(sql`
      SELECT c.slug
      FROM post_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.post_id = ${postId}
      ORDER BY c.position, c.id
      LIMIT 10
    `)) as unknown as [Array<{ slug: string }>]
    return rows.map((r) => r.slug)
  } catch (err) {
    if (isMissingTable(err)) return []
    throw err
  }
}
