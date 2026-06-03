// Phase 8 (blog-system worktree): the post STATUS MODEL — DERIVED, no schema
// change. A post's status is a pure function of three existing columns
// (`published`, `published_at`, `deleted_at`):
//
//   draft     = published=0                              (deleted_at IS NULL)
//   scheduled = published=1 AND published_at >  NOW()    (deleted_at IS NULL)
//   published = published=1 AND published_at <= NOW()    (deleted_at IS NULL)
//   trash     = deleted_at IS NOT NULL                   (overrides the rest)
//
// This module is the SINGLE source of truth for that mapping, in BOTH SQL
// (the public gate + the admin grouped-count CASE) and TS (the admin list row
// status + the editor's "current status" chip). Keeping the rules in one file
// means a future status-model tweak ripples here once, not into every query.

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
 * row whose `published_at` is null OR already past is `published`. A
 * `published=0` row is a `draft`. `deleted_at` set wins over everything.
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
    // published=1 with no timestamp → treat as live (defensive: the PATCH route
    // always stamps published_at on publish, but a direct DB edit could leave it
    // null; an immediately-visible post is the safe interpretation here).
    return 'published'
  }
  const at =
    typeof row.published_at === 'string'
      ? new Date(row.published_at)
      : row.published_at
  if (Number.isNaN(at.getTime())) return 'published'
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
