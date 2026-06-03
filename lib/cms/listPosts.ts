import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  type PostStatusFilter,
  isPostStatusFilter,
  statusFilterSql,
  statusBucketCaseSql,
  statusCountSumsSql,
} from '@/lib/cms/postStatus'

// Phase 8 (blog-system worktree): the SERVER-SIDE admin posts list query —
// status-filtered, searched, sorted, BOUNDED + paginated, plus a single grouped
// status-count query. Powers /admin/blog (server-mode AdminTable). All inputs
// are validated/clamped here so a hand-crafted URL can never inject SQL or ask
// for an unbounded scan (scalability rule #0.251).

// Sortable columns the admin list exposes. Mapped to a SQL ORDER BY expression
// from a CLOSED allow-list — the sort key NEVER reaches sql.raw as free text.
// `status` sorts by the derived ordering (draft < scheduled < published) via a
// CASE so clicking the Status header groups the list sensibly.
export const POST_SORT_COLUMNS = [
  'title',
  'status',
  'published',
  'updated',
] as const
export type PostSortColumn = (typeof POST_SORT_COLUMNS)[number]
export type SortDir = 'asc' | 'desc'

export function isPostSortColumn(v: unknown): v is PostSortColumn {
  return (
    typeof v === 'string' &&
    (POST_SORT_COLUMNS as readonly string[]).includes(v)
  )
}

// Page size + bounds. Admin lists are bounded surfaces; a hard page cap +
// per-page cap keep the LIMIT/OFFSET window from ever scanning unboundedly.
export const POST_LIST_PAGE_SIZES = [10, 15, 20, 25, 50, 100] as const
export const POST_LIST_DEFAULT_PAGE_SIZE = 25
// 1000 pages × 100/page = 100k posts deep — far past any real blog admin list.
export const POST_LIST_MAX_PAGE = 1000
// Cap the LIKE search term length so a giant needle can't bloat the query.
const SEARCH_MAX = 120

export interface PostListRow {
  id: number
  slug: string
  title: string
  published: number
  published_at: Date | string | null
  deleted_at: Date | string | null
  updated_at: Date | string
}

export interface PostStatusCounts {
  all: number // active (non-trash) total
  draft: number
  scheduled: number
  published: number
  trash: number
}

export interface ListPostsArgs {
  status: PostStatusFilter
  search?: string
  sort: PostSortColumn
  dir: SortDir
  page: number
  perPage: number
  /** Taxonomy filter — at most one of these (a category XOR tag slug). The
   *  slug is bound as a parameter (the EXISTS join is injection-safe). */
  categorySlug?: string
  tagSlug?: string
}

export interface ListPostsResult {
  rows: PostListRow[]
  total: number
  counts: PostStatusCounts
  // The clamped/normalised values actually used (so the caller can reflect them
  // back into the URL / table state without re-deriving).
  page: number
  perPage: number
}

// ── input normalisers (exported for the page + tests) ────────────────────────

export function clampPerPage(raw: number): number {
  return (POST_LIST_PAGE_SIZES as readonly number[]).includes(raw)
    ? raw
    : POST_LIST_DEFAULT_PAGE_SIZE
}

export function clampPage(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.min(POST_LIST_MAX_PAGE, Math.floor(raw))
}

export function normalizeStatus(raw: unknown): PostStatusFilter {
  return isPostStatusFilter(raw) ? raw : 'all'
}

// MySQL LIKE-escape: a search needle containing %, _ or \ must match those
// LITERAL characters, not the wildcard meaning. Escapes them so `50%` searches
// for the literal string, and bounds the length.
function buildLikeNeedle(search: string): string {
  const trimmed = search.trim().slice(0, SEARCH_MAX)
  const escaped = trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)
  return `%${escaped}%`
}

// ── WHERE-fragment builders (status + search + taxonomy) ─────────────────────
//
// The status taxonomy (tab filter + ordering CASE + grouped-count SUMs) is NOT
// re-implemented here — it lives in lib/cms/postStatus (statusFilterSql /
// statusBucketCaseSql / statusCountSumsSql) so the admin axis is the SAME single
// source of truth as the public gate + derivePostStatus (F5/F7). Search +
// taxonomy + sort wiring stay local because they're admin-list-specific.

function searchCondition(needle: string | null) {
  if (needle === null) return sql``
  return sql` AND (p.title LIKE ${needle} OR p.slug LIKE ${needle} OR p.excerpt LIKE ${needle})`
}

function taxonomyCondition(categorySlug?: string, tagSlug?: string) {
  if (categorySlug) {
    return sql` AND EXISTS (
      SELECT 1 FROM post_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.post_id = p.id AND c.slug = ${categorySlug}
    )`
  }
  if (tagSlug) {
    return sql` AND EXISTS (
      SELECT 1 FROM post_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.post_id = p.id AND t.slug = ${tagSlug}
    )`
  }
  return sql``
}

// ORDER BY from the closed sort-column allow-list. `status` uses a derived CASE
// (draft=0 < scheduled=1 < published=2) so the column groups sensibly; every
// sort gets a stable `p.id` tiebreak so pagination is deterministic.
function orderByClause(sort: PostSortColumn, dir: SortDir) {
  const d = dir === 'asc' ? sql`ASC` : sql`DESC`
  switch (sort) {
    case 'title':
      return sql`ORDER BY p.title ${d}, p.id DESC`
    case 'status':
      // Status-ordering bucket CASE — single source of truth in postStatus.
      return sql`ORDER BY ${statusBucketCaseSql('p')} ${d}, p.published_at DESC, p.id DESC`
    case 'published':
      // Nulls (drafts) sort last on DESC, first on ASC — MySQL's default null
      // ordering. Acceptable for an admin column header.
      return sql`ORDER BY p.published_at ${d}, p.id DESC`
    case 'updated':
    default:
      return sql`ORDER BY p.updated_at ${d}, p.id DESC`
  }
}

/**
 * Run the admin posts list query + the grouped status counts. Two round-trips:
 * the bounded LIMIT/OFFSET slice and ONE grouped-count query (NOT N queries).
 * All inputs are clamped here; the caller passes already-validated enums.
 */
export async function listPosts(
  args: ListPostsArgs,
): Promise<ListPostsResult> {
  const page = clampPage(args.page)
  const perPage = clampPerPage(args.perPage)
  const offset = (page - 1) * perPage
  const needle =
    args.search && args.search.trim() !== ''
      ? buildLikeNeedle(args.search)
      : null

  const whereSql = sql`${statusFilterSql(args.status, 'p')}${searchCondition(
    needle,
  )}${taxonomyCondition(args.categorySlug, args.tagSlug)}`

  // Counts: ONE grouped query over the ACTIVE/trash partition derived from the
  // same search + taxonomy filter, so each tab's badge reflects what the
  // operator would see if they clicked it (search/taxonomy narrow every tab
  // consistently). SUM(<cond>) counts the rows matching each derived status.
  const countWhere = sql`1 = 1${searchCondition(needle)}${taxonomyCondition(
    args.categorySlug,
    args.tagSlug,
  )}`
  const [countRows] = (await db.execute(sql`
    SELECT ${statusCountSumsSql('p')}
    FROM posts p
    WHERE ${countWhere}
  `)) as unknown as [
    Array<{
      all_active: number | string | null
      draft: number | string | null
      scheduled: number | string | null
      published_: number | string | null
      trash: number | string | null
    }>,
  ]
  const c = countRows[0]
  const counts: PostStatusCounts = {
    all: Number(c?.all_active ?? 0),
    draft: Number(c?.draft ?? 0),
    scheduled: Number(c?.scheduled ?? 0),
    published: Number(c?.published_ ?? 0),
    trash: Number(c?.trash ?? 0),
  }

  // The total for the CURRENT tab drives pagination. Pick the count we already
  // computed for the active tabs; for a search/taxonomy-narrowed list the tab
  // count already reflects the filter, so no extra COUNT query is needed.
  const total =
    args.status === 'trash'
      ? counts.trash
      : args.status === 'draft'
        ? counts.draft
        : args.status === 'scheduled'
          ? counts.scheduled
          : args.status === 'published'
            ? counts.published
            : counts.all

  // Bounded slice. OFFSET is clamped via clampPage(MAX_PAGE); the filter +
  // index keep the scan bounded.
  const [rows] = (await db.execute(sql`
    SELECT p.id, p.slug, p.title, p.published, p.published_at,
           p.deleted_at, p.updated_at
    FROM posts p
    WHERE ${whereSql}
    ${orderByClause(args.sort, args.dir)}
    LIMIT ${perPage} OFFSET ${offset}
  `)) as unknown as [PostListRow[]]

  return { rows, total, counts, page, perPage }
}

// Catalog of categories + tags (capped) for the taxonomy filter chips AND the
// bulk-assign chip picker. Carries the id (bulk-assign needs it), slug + name
// (filter chips use slug; both render the name). Small bounded reads. parentId
// drives the one-level category indent in the chip picker.
export interface TaxonomyFilterTerm {
  id: number
  slug: string
  name: string
  parentId?: number | null
}
export async function fetchTaxonomyFilterCatalog(): Promise<{
  categories: TaxonomyFilterTerm[]
  tags: TaxonomyFilterTerm[]
}> {
  const [[cats], [tags]] = await Promise.all([
    db.execute(sql`
      SELECT id, slug, name, parent_id AS parentId FROM categories
      ORDER BY COALESCE(parent_id, id), (parent_id IS NOT NULL), position, id
      LIMIT 200
    `) as unknown as Promise<[TaxonomyFilterTerm[]]>,
    db.execute(sql`
      SELECT id, slug, name FROM tags ORDER BY name, id LIMIT 200
    `) as unknown as Promise<[TaxonomyFilterTerm[]]>,
  ])
  return { categories: cats, tags }
}
