import 'server-only'
import type { SeoSchemaDefaults } from '@/lib/seo/schema/forPage'
import {
  type PanelSeoMeta,
  parsePanelSeoMeta,
} from '@/lib/cms/seoEditorFields'

// Shared helpers for the per-entity `seo_meta` JSON column (added in
// migration 0032 to pages / posts / projects). The column is the
// render-only override bag: per-page OG/Twitter title+description plus
// the per-page structured-data override (schemaType + schemaData).
//
// Two driver realities this guards against:
//   • MariaDB aliases JSON → LONGTEXT, so mysql2 hands the column back
//     as a STRING (unlike MySQL native JSON which auto-parses). Every
//     raw-SQL JSON reader in this codebase JSON.parses manually (see
//     lib/cms/hydrate.ts content_blocks.data / media.variants) — mirror
//     that here.
//   • A tampered / half-written cell could be malformed JSON or the
//     wrong shape. Parsing fails closed to `{}` (no overrides) rather
//     than 500-ing the public route — the same fail-closed posture
//     getSettings.ts uses.

/** The parsed shape of the `seo_meta` column. ONE definition, shared with
 *  the editor + panel via `PanelSeoMeta` (lib/cms/seoEditorFields.ts) so
 *  the server render shape and the client editor shape can never drift.
 *  Every field optional — absence means "no override, fall back to the
 *  resolver default". */
export type SeoMeta = PanelSeoMeta

/**
 * Parse the raw `seo_meta` value off a DB row into a typed, well-formed
 * `SeoMeta`. Accepts:
 *   • a JSON string (the MariaDB-via-mysql2 reality) — JSON.parse'd,
 *   • an already-parsed object (defensive — a future driver flip),
 *   • null / undefined / malformed — all collapse to `{}`.
 *
 * Only the fields this codebase consumes are projected through; an
 * unknown `schemaType` is dropped (so a typo can't smuggle a bad
 * @type into the schema selector). Never throws.
 *
 * DELEGATES to the client-safe `parsePanelSeoMeta` (lib/cms/seoEditorFields.ts)
 * so there is exactly ONE parser body — the server render and the client
 * editor can never drift field-for-field. This module keeps the
 * `server-only` marker + the `schemaDefaultsFromSetting` helper; the parse
 * itself lives in the lower client-safe module.
 */
export const parseSeoMeta: (raw: unknown) => SeoMeta = parsePanelSeoMeta

/**
 * Narrow the full `seo_schema` settings row down to the `SeoSchemaDefaults`
 * that `schemaForEntity` consumes. The settings row's `websiteSearchAction`
 * is a boolean (registry shape) while `SeoSchemaDefaults` types it as a URL
 * string — that field is layout-only (never read inside `schemaForEntity`),
 * so we drop it here rather than fight the type mismatch. `entityType` is
 * likewise layout-only; we pass it through for symmetry.
 */
export function schemaDefaultsFromSetting(s: {
  entityType?: 'Organization' | 'Person'
  articleType?: 'Article' | 'BlogPosting' | 'NewsArticle'
  breadcrumbsEnabled?: boolean
}): SeoSchemaDefaults {
  return {
    entityType: s.entityType,
    articleType: s.articleType,
    breadcrumbsEnabled: s.breadcrumbsEnabled,
  }
}
