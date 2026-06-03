// PageRawRow: mysql2 verbatim shape for the `pages` table — snake_case
// keys, TINYINT(1) returned as number (`0`/`1`, NOT `boolean`). Use this
// to annotate raw-SQL reads (`as unknown as [PageRawRow[]]`). The
// codebase convention (verified in lib/cms/hydrate.ts:327, app/projects/
// [slug]/page.tsx:99) is snake_case + numeric for raw rows; mirror it
// rather than building lying camelCase aliases that break at runtime.
//
// Date/timestamp columns may surface as `Date` or `string` depending on
// mysql2 driver config (`dateStrings`). Accept both.
export interface PageRawRow {
  id: number
  slug: string
  title: string
  is_home: number
  system: number
  published: number
  published_at: Date | string | null
  deleted_at: Date | string | null
  seo_title: string | null
  seo_description: string | null
  og_image_id: number | null
  hero_image_id: number | null
  // Per-entity SEO columns (migration 0032). Booleans surface as 0|1
  // from raw SQL; seo_meta is the raw JSON string (MariaDB JSON ≡
  // LONGTEXT — parse with parseSeoMeta).
  focus_keyphrase: string | null
  robots_noindex: number
  robots_nofollow: number
  canonical_url: string | null
  cornerstone: number
  seo_score: number | null
  readability_score: number | null
  seo_meta: unknown
  preview_epoch: number
  version: number
  updated_by: number | null
  created_at: Date | string
  updated_at: Date | string
  url_path: string | null
}
