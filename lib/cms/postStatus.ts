// Phase 8 (blog-system worktree): the post STATUS MODEL — DERIVED, no schema
// change. A post's status is a pure function of three existing columns
// (`published`, `published_at`, `deleted_at`):
//
//   draft     = published=0 OR published_at IS NULL      (deleted_at IS NULL)
//   scheduled = published=1 AND published_at >  NOW()    (deleted_at IS NULL)
//   published = published=1 AND published_at IS NOT NULL
//               AND published_at <= NOW()                (deleted_at IS NULL)
//   trash     = deleted_at IS NOT NULL                   (overrides the rest)
//
// This module is the SINGLE source of truth for that mapping — and now owns
// BOTH axes: the PUBLIC-visibility gate (publicPostGateSql / *Condition) AND
// the ADMIN status axis (the status-tab WHERE filter, the status-ordering CASE,
// and the grouped-count SUMs). lib/cms/listPosts imports those fragments rather
// than re-implementing the taxonomy inline (F5), so a future status-model tweak
// ripples here once, not into every query.
//
// ALIGNMENT (F7): a `published=1` row with a NULL `published_at` is NOT publicly
// visible (the public gate requires `published_at IS NOT NULL`), so it MUST NOT
// read as plain 'published' in the admin either — it is classified as 'draft'
// ("not live"), consistent across derivePostStatus (TS) and the admin SQL.

import { sql } from 'drizzle-orm'

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'trash'

// The four admin status TABS (Trash is surfaced via the existing `?trashed=1`
// recovery view, but is also a first-class tab here so counts are complete).
export const POST_STATUS_FILTERS = [
  'all',
  'draft',
  'scheduled',
  'published',
  'trash',
] as const
export type PostStatusFilter = (typeof POST_STATUS_FILTERS)[number]

export function isPostStatusFilter(v: unknown): v is PostStatusFilter {
  return (
    typeof v === 'string' &&
    (POST_STATUS_FILTERS as readonly string[]).includes(v)
  )
}

/**
 * Derive a post's status from its raw columns. `published_at` accepts a Date,
 * an ISO string (mysql2 `dateStrings`), or null. `now` is injectable so unit
 * tests are deterministic; defaults to the call-time clock.
 *
 * A future `published_at` on a `published=1` row is `scheduled`. A `published=1`
 * row whose `published_at` is in the past is `published`. A `published=0` row —
 * OR a `published=1` row whose `published_at` is null (not publicly visible,
 * F7) — is a `draft`. `deleted_at` set wins over everything.
 */
export function derivePostStatus(
  row: {
    published: number | boolean
    published_at: Date | string | null
    deleted_at: Date | string | null
  },
  now: Date = new Date(),
): PostStatus {
  if (row.deleted_at !== null && row.deleted_at !== undefined) return 'trash'
  const isPublished = row.published === 1 || row.published === true
  if (!isPublished) return 'draft'
  if (row.published_at === null || row.published_at === undefined) {
    // published=1 with no timestamp → NOT publicly visible (the public gate
    // requires published_at IS NOT NULL), so it must NOT read as 'published'.
    // Classify as 'draft' ("not live"), aligned with publicPostGateSql + the
    // admin SQL (F7). The PATCH route always stamps published_at on publish; a
    // null here means a direct DB edit left it inconsistent — fail to "draft".
    return 'draft'
  }
  const at =
    typeof row.published_at === 'string'
      ? new Date(row.published_at)
      : row.published_at
  // A malformed published_at can't satisfy the public `published_at <= NOW(3)`
  // gate, so it isn't publicly visible → classify as 'draft', not 'published'.
  if (Number.isNaN(at.getTime())) return 'draft'
  return at.getTime() > now.getTime() ? 'scheduled' : 'published'
}

// ── SQL fragments (single source of truth for the gate / count) ──────────────

/**
 * The PUBLIC-visibility gate for a post, as a SQL fragment. `alias` is the table
 * alias the caller uses (`'p'` for `FROM posts p`, `''` for `FROM posts`). The
 * fragment is `AND`-prefixed so it slots into an existing WHERE without a join.
 *
 * A post is publicly visible iff it is published, NOT soft-deleted, AND its
 * publish time has arrived (`published_at <= NOW(3)`). The `IS NOT NULL` guard
 * makes a `published=1` row with a null `published_at` (shouldn't happen via the
 * app, but possible via direct DB edit) explicitly hidden from the public until
 * a real timestamp exists — fail-closed, the safe direction.
 *
 * NOW(3) matches the fsp:3 precision the `published_at` column stores, so a
 * post scheduled to the millisecond flips visible exactly on time.
 */
export function publicPostGateSql(alias = 'p') {
  const col = alias ? sql.raw(`${alias}.`) : sql.raw('')
  return sql`AND ${col}published = TRUE AND ${col}deleted_at IS NULL AND ${col}published_at IS NOT NULL AND ${col}published_at <= NOW(3)`
}

/**
 * The same gate as a STANDALONE condition (no leading `AND`), for callers that
 * build the whole WHERE from fragments. Used in correlated sub-SELECTs where the
 * post alias differs (sitemap archive EXISTS/MAX subqueries use `p`).
 */
export function publicPostConditionSql(alias = 'p') {
  const col = alias ? sql.raw(`${alias}.`) : sql.raw('')
  return sql`${col}published = TRUE AND ${col}deleted_at IS NULL AND ${col}published_at IS NOT NULL AND ${col}published_at <= NOW(3)`
}

// ── ADMIN status axis (single source of truth — imported by lib/cms/listPosts)
//
// These fragments encode the SAME taxonomy as derivePostStatus, so the admin
// list (status tab filter + status-ordering CASE + grouped counts) can never
// drift from the TS classifier or the public gate. Each takes the table alias
// the caller uses (`'p'` for `FROM posts p`). All comparisons use NOW(3) to
// match the `published_at` column fsp. The 'published' bucket requires
// `published_at IS NOT NULL` (F7) so a null-timestamp published=1 row falls into
// 'draft', exactly like the public gate hides it + derivePostStatus labels it.

function aliasCol(alias: string) {
  return alias ? `${alias}.` : ''
}

/**
 * WHERE fragment for ONE admin status tab (no leading `AND` — the caller chains
 * it as the first condition). `all` = the active set (everything not in Trash);
 * Trash is its own tab.
 */
export function statusFilterSql(filter: PostStatusFilter, alias = 'p') {
  const c = sql.raw(aliasCol(alias))
  switch (filter) {
    case 'trash':
      return sql`${c}deleted_at IS NOT NULL`
    case 'draft':
      // published=0 OR (published=1 with no publish timestamp) — both "not live".
      return sql`${c}deleted_at IS NULL AND (${c}published = 0 OR ${c}published_at IS NULL)`
    case 'scheduled':
      return sql`${c}deleted_at IS NULL AND ${c}published = 1 AND ${c}published_at IS NOT NULL AND ${c}published_at > NOW(3)`
    case 'published':
      return sql`${c}deleted_at IS NULL AND ${c}published = 1 AND ${c}published_at IS NOT NULL AND ${c}published_at <= NOW(3)`
    case 'all':
    default:
      return sql`${c}deleted_at IS NULL`
  }
}

/**
 * The status-ordering CASE expression (draft=0 < scheduled=1 < published=2 <
 * trash=3) for the admin list's `ORDER BY status`. Buckets match statusFilterSql
 * exactly: a null-published_at published=1 row falls through to the `ELSE 0`
 * (draft) bucket because neither the scheduled nor published WHEN matches it.
 */
export function statusBucketCaseSql(alias = 'p') {
  const c = sql.raw(aliasCol(alias))
  return sql`CASE
          WHEN ${c}deleted_at IS NOT NULL THEN 3
          WHEN ${c}published = 0 THEN 0
          WHEN ${c}published_at IS NULL THEN 0
          WHEN ${c}published_at > NOW(3) THEN 1
          ELSE 2
        END`
}

/**
 * The five grouped-count SUM expressions for the admin status badges, as a
 * single SELECT-list fragment (`all_active`, `draft`, `scheduled`, `published_`,
 * `trash`). `published_` is trailing-underscored to dodge the SQL keyword. Each
 * SUM(<bool>) counts the rows matching that derived status — identical buckets
 * to statusFilterSql, so every badge equals what the operator sees on click.
 */
export function statusCountSumsSql(alias = 'p') {
  const c = sql.raw(aliasCol(alias))
  return sql`
      SUM(${c}deleted_at IS NULL) AS all_active,
      SUM(${c}deleted_at IS NULL AND (${c}published = 0 OR ${c}published_at IS NULL)) AS draft,
      SUM(${c}deleted_at IS NULL AND ${c}published = 1 AND ${c}published_at IS NOT NULL AND ${c}published_at > NOW(3)) AS scheduled,
      SUM(${c}deleted_at IS NULL AND ${c}published = 1 AND ${c}published_at IS NOT NULL AND ${c}published_at <= NOW(3)) AS published_,
      SUM(${c}deleted_at IS NOT NULL) AS trash`
}
