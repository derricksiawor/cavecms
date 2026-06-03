import 'server-only'
import { sql } from 'drizzle-orm'
import type { Tx } from '@/db/client'
import { HttpError } from '@/lib/auth/requireRole'

// Cap on how many terms a single post may carry. Bounds the inbound id arrays
// (a hostile editor can't post 10k ids → 10k junction rows on one save) and
// keeps the diff loops O(small). 50 categories + 50 tags is far past any real
// editorial need.
export const MAX_TERMS_PER_POST = 50

export interface TaxonomySyncResult {
  /** Slugs of every term whose membership for this post CHANGED (added or
   *  removed), split by kind. Drives cache invalidation
   *  (tagsForPostTaxonomySync) — only touched archives are busted, not every
   *  term the post still carries. */
  changedCategorySlugs: string[]
  changedTagSlugs: string[]
  /** Final id sets actually persisted (after validation). Audited so a
   *  forensic query reconstructs the post's taxonomy at save time. */
  finalCategoryIds: number[]
  finalTagIds: number[]
}

// Pure id-set diff. Exported for unit testing the add/remove computation in
// isolation (no DB). Returns the ids to INSERT and the ids to DELETE so the
// junction reaches `desired` from `current`, plus the unchanged set.
export function diffIdSets(
  current: readonly number[],
  desired: readonly number[],
): { toAdd: number[]; toRemove: number[]; unchanged: number[] } {
  const cur = new Set(current)
  const des = new Set(desired)
  const toAdd: number[] = []
  const toRemove: number[] = []
  const unchanged: number[] = []
  for (const id of des) {
    if (cur.has(id)) unchanged.push(id)
    else toAdd.push(id)
  }
  for (const id of cur) {
    if (!des.has(id)) toRemove.push(id)
  }
  return { toAdd, toRemove, unchanged }
}

// De-dupe + reject non-positive-int ids. The route Zod-validates each element
// is a positive int; this is defence-in-depth + the de-dupe (a payload with a
// repeated id must not attempt a duplicate-PK INSERT).
function normalizeIds(ids: readonly number[]): number[] {
  const out = new Set<number>()
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) out.add(id)
  }
  return [...out]
}

/**
 * Resolve a set of term ids → their slugs, asserting EVERY id exists.
 * Throws HttpError(400, 'unknown_<kind>_id') if any requested id is missing
 * (a stale picker / hostile payload). Returns id→slug in a Map so the caller
 * can map changed ids to slugs for cache invalidation. Empty input → empty Map
 * (no query). Parameterised IN-list (ids are validated ints).
 */
async function resolveSlugs(
  tx: Tx,
  table: 'categories' | 'tags',
  ids: number[],
  errorCode: string,
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map()
  const [rows] = (await tx.execute(sql`
    SELECT id, slug FROM ${sql.raw(table)}
    WHERE id IN (${sql.join(ids, sql.raw(','))})
  `)) as unknown as [Array<{ id: number; slug: string }>]
  const map = new Map<number, string>()
  for (const r of rows) map.set(r.id, r.slug)
  // Every requested id must resolve — a missing one is a stale/hostile id.
  for (const id of ids) {
    if (!map.has(id)) throw new HttpError(400, errorCode)
  }
  return map
}

/**
 * Sync ONE junction (post_categories OR post_tags) to the desired id set,
 * inside the caller's transaction. Diff-based (delete-removed + insert-added),
 * NOT delete-all-then-reinsert, so an unchanged save touches zero rows and the
 * audit/cache footprint reflects only real changes. Returns the slugs of the
 * terms whose membership changed (added ∪ removed) + the final id set.
 *
 * `undefined` desired means "the editor didn't send this axis — leave it
 * untouched" (so a body-only PATCH never wipes a post's taxonomy). An empty
 * array means "clear all of this axis".
 */
export async function syncPostTaxonomy(
  tx: Tx,
  args: {
    postId: number
    /** Desired category ids, or undefined to leave categories untouched. */
    categoryIds?: readonly number[]
    /** Desired tag ids, or undefined to leave tags untouched. */
    tagIds?: readonly number[]
  },
): Promise<TaxonomySyncResult> {
  const result: TaxonomySyncResult = {
    changedCategorySlugs: [],
    changedTagSlugs: [],
    finalCategoryIds: [],
    finalTagIds: [],
  }

  // ── categories ──────────────────────────────────────────────────
  if (args.categoryIds !== undefined) {
    const desired = normalizeIds(args.categoryIds)
    if (desired.length > MAX_TERMS_PER_POST) {
      throw new HttpError(400, 'too_many_categories')
    }
    // Validate all desired ids exist BEFORE mutating (clean 400, not an FK
    // error mid-TX). Resolving slugs here also feeds cache invalidation.
    const desiredSlugs = await resolveSlugs(
      tx,
      'categories',
      desired,
      'unknown_category_id',
    )
    const [curRows] = (await tx.execute(sql`
      SELECT pc.category_id AS id, c.slug AS slug
      FROM post_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.post_id = ${args.postId}
    `)) as unknown as [Array<{ id: number; slug: string }>]
    const currentIds = curRows.map((r) => r.id)
    const currentSlugById = new Map(curRows.map((r) => [r.id, r.slug]))
    const { toAdd, toRemove } = diffIdSets(currentIds, desired)

    if (toRemove.length > 0) {
      await tx.execute(sql`
        DELETE FROM post_categories
        WHERE post_id = ${args.postId}
          AND category_id IN (${sql.join(toRemove, sql.raw(','))})
      `)
    }
    for (const cid of toAdd) {
      await tx.execute(sql`
        INSERT INTO post_categories (post_id, category_id)
        VALUES (${args.postId}, ${cid})
      `)
    }
    const changed = new Set<string>()
    for (const id of toAdd) {
      const s = desiredSlugs.get(id)
      if (s) changed.add(s)
    }
    for (const id of toRemove) {
      const s = currentSlugById.get(id)
      if (s) changed.add(s)
    }
    result.changedCategorySlugs = [...changed]
    result.finalCategoryIds = desired
  }

  // ── tags ────────────────────────────────────────────────────────
  if (args.tagIds !== undefined) {
    const desired = normalizeIds(args.tagIds)
    if (desired.length > MAX_TERMS_PER_POST) {
      throw new HttpError(400, 'too_many_tags')
    }
    const desiredSlugs = await resolveSlugs(
      tx,
      'tags',
      desired,
      'unknown_tag_id',
    )
    const [curRows] = (await tx.execute(sql`
      SELECT pt.tag_id AS id, t.slug AS slug
      FROM post_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.post_id = ${args.postId}
    `)) as unknown as [Array<{ id: number; slug: string }>]
    const currentIds = curRows.map((r) => r.id)
    const currentSlugById = new Map(curRows.map((r) => [r.id, r.slug]))
    const { toAdd, toRemove } = diffIdSets(currentIds, desired)

    if (toRemove.length > 0) {
      await tx.execute(sql`
        DELETE FROM post_tags
        WHERE post_id = ${args.postId}
          AND tag_id IN (${sql.join(toRemove, sql.raw(','))})
      `)
    }
    for (const tid of toAdd) {
      await tx.execute(sql`
        INSERT INTO post_tags (post_id, tag_id)
        VALUES (${args.postId}, ${tid})
      `)
    }
    const changed = new Set<string>()
    for (const id of toAdd) {
      const s = desiredSlugs.get(id)
      if (s) changed.add(s)
    }
    for (const id of toRemove) {
      const s = currentSlugById.get(id)
      if (s) changed.add(s)
    }
    result.changedTagSlugs = [...changed]
    result.finalTagIds = desired
  }

  return result
}
