import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { SeoMetaSchema } from '@/lib/cms/seoEditorFields'

// Shared persistence helper for the SEO editor fields (migration 0032)
// across the pages / posts / projects PATCH routes. ONE place that knows
// how each SEO column is mapped (camelCase → snake_case) and serialized
// (booleans → TINYINT 0/1, seoMeta → JSON string, scores → INT|null) so
// the three routes stay byte-for-byte consistent and DRY.
//
// The routes already have their own dynamic-UPDATE machinery; this helper
// only contributes the SEO `column = value` fragments + the value-delta
// detection, mirroring the existing per-route loops.

// The validated shape of the SEO fields after SeoEditorFields parsing —
// derived from the Zod definitions so it can never drift from what the
// schemas actually accept. Every field optional; `null` is an explicit
// clear, `undefined` means "field absent from the PATCH → leave the
// column unchanged".
export interface SeoEditorInput {
  focusKeyphrase?: string | null
  robotsNoindex?: boolean
  robotsNofollow?: boolean
  canonicalUrl?: string | null
  cornerstone?: boolean
  seoScore?: number | null
  readabilityScore?: number | null
  seoMeta?: z.infer<typeof SeoMetaSchema>
}

// Boolean fields → stored as TINYINT(0|1). The row carries the column as
// a number (0|1) when read back via raw SQL; the body sends a JS boolean.
export const SEO_BOOL_FIELDS = [
  ['robotsNoindex', 'robots_noindex'],
  ['robotsNofollow', 'robots_nofollow'],
  ['cornerstone', 'cornerstone'],
] as const

// Plain scalar fields → string|null (varchar) or number|null (int). These
// bind straight into the parameterized SQL with no transform.
export const SEO_SCALAR_COLS = [
  ['focusKeyphrase', 'focus_keyphrase'],
  ['canonicalUrl', 'canonical_url'],
  ['seoScore', 'seo_score'],
  ['readabilityScore', 'readability_score'],
] as const

// The DB row's snake_case keys for the same fields, so a route can
// compare the incoming value against the loaded row and skip a no-op
// write (matches the existing value-delta detection in each route).
export type SeoRowSnapshot = {
  focus_keyphrase: string | null
  robots_noindex: number
  robots_nofollow: number
  canonical_url: string | null
  cornerstone: number
  seo_score: number | null
  readability_score: number | null
  seo_meta: unknown
}

/**
 * Build the SEO portion of a dynamic UPDATE SET clause.
 *
 * Returns the list of `column = value` sql fragments to append to the
 * route's existing `parts` array, plus an `applied` map of the
 * camelCase fields actually written (value differed from the row).
 *
 * Serialization rules (the whole point of centralizing this):
 *   • booleans  → `v ? 1 : 0`  (TINYINT column)
 *   • scalars   → bound as-is  (string|null / number|null)
 *   • seoMeta   → `null` binds a real SQL NULL (clears the column);
 *                 an object is JSON.stringify'd into the parameterized
 *                 value (MariaDB JSON ≡ LONGTEXT, so it stores the
 *                 string — mirrors content_blocks.data / .meta writes;
 *                 parseSeoMeta JSON.parses it back at render).
 *
 * A field whose value equals the current row value is skipped (no-op
 * delta) so a client echoing unchanged values doesn't inflate the
 * UPDATE or the cache-invalidation surface.
 */
export function buildSeoSetParts(
  body: SeoEditorInput,
  row: SeoRowSnapshot,
): {
  parts: ReturnType<typeof sql>[]
  applied: Record<string, unknown>
} {
  const parts: ReturnType<typeof sql>[] = []
  const applied: Record<string, unknown> = {}

  for (const [field, col] of SEO_BOOL_FIELDS) {
    const v = body[field]
    if (v === undefined) continue
    const rowVal = row[col] === 1
    if (v === rowVal) continue
    parts.push(sql`${sql.raw(col)} = ${v ? 1 : 0}`)
    applied[field] = v
  }

  for (const [field, col] of SEO_SCALAR_COLS) {
    const v = body[field]
    if (v === undefined) continue
    const rowVal = row[col] as unknown
    if (v === rowVal) continue
    parts.push(sql`${sql.raw(col)} = ${v as string | number | null}`)
    applied[field] = v
  }

  // seoMeta (JSON). `undefined` → leave unchanged. `null` → clear (bind
  // a real NULL, never the literal string "null"). Object → store the
  // JSON string. Always write when present in the body (we don't deep-
  // compare against the row's stored JSON — an equality skip would need
  // a stable canonical-stringify of both sides; the cost of an
  // occasional identical re-write of a small JSON blob is not worth that
  // complexity, and parseSeoMeta is idempotent at render).
  if (body.seoMeta !== undefined) {
    if (body.seoMeta === null) {
      parts.push(sql`seo_meta = ${null}`)
      applied['seoMeta'] = null
    } else {
      parts.push(sql`seo_meta = ${JSON.stringify(body.seoMeta)}`)
      applied['seoMeta'] = body.seoMeta
    }
  }

  return { parts, applied }
}
