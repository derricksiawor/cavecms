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
  preview_epoch: number
  version: number
  updated_by: number | null
  created_at: Date | string
  updated_at: Date | string
  url_path: string | null
}
