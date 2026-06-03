import { z } from 'zod'

// Shared Zod fields for the per-entity SEO columns added in migration
// 0032 to pages / posts / projects. ONE definition spread into each of
// the three editor PATCH schemas so the validation stays DRY and the
// three content surfaces can never drift apart.
//
// These are CONTENT fields — any editor (not just admin) may set them,
// the same way `seo_title` / `seo_description` are editor-writable. They
// live in the editor schema, not the admin-only extension.
//
// Persistence notes for the consuming routes:
//   • booleans → TINYINT columns: write `v ? 1 : 0`.
//   • seoScore / readabilityScore → INT, nullable.
//   • seoMeta → JSON column. MariaDB aliases JSON → LONGTEXT, so the
//     value must be JSON.stringify'd into the parameterized SQL (mirrors
//     content_blocks.data / .meta). A literal `null` clears it; an
//     omitted field leaves it unchanged.
//   • canonicalUrl `.refine` closes the Phase-3 security LOW: only an
//     absolute http(s) URL or a root-relative path is accepted, so a
//     `javascript:`/`data:` canonical can never reach the <link> tag.

// ── Single source of truth for the 8 structured-data schemaType values ──
// EVERY other reference to this set derives from `SCHEMA_TYPE_VALUES`:
//   • the Zod enum below,
//   • lib/seo/seoMeta.ts's SCHEMA_TYPES Set (render-time re-validation),
//   • lib/seo/schema/forPage.ts's PageSchemaType (= the union of these),
//   • components/seo/PageSeoPanel.tsx's tile picker + selection guard,
//   • app/(admin)/admin/pages/[id]/PageEditor.tsx's client parser set.
// This module is client-safe (only imports `zod`) so client components
// can import the const + the parser without dragging in `server-only`.
export const SCHEMA_TYPE_VALUES = [
  'Article',
  'BlogPosting',
  'NewsArticle',
  'FAQPage',
  'HowTo',
  'Product',
  'SoftwareApplication',
  'WebPage',
] as const

/** The union of accepted structured-data schema types. This is the ONE
 *  definition; `forPage.ts:PageSchemaType` aliases to it. */
export type SchemaTypeValue = (typeof SCHEMA_TYPE_VALUES)[number]

/** Fast membership set, shared by every runtime guard. */
export const SCHEMA_TYPE_SET: ReadonlySet<string> = new Set(SCHEMA_TYPE_VALUES)

// The render-only override bag. `.strict()` rejects unknown keys so an
// operator can't smuggle arbitrary top-level fields into the JSON; the
// `schemaType` enum bounds the structured-data selector; `schemaData`
// is intentionally loose (operator-authored JSON) but bounded by the
// strict wrapper + re-validated by parseSeoMeta at render.
export const SeoMetaSchema = z
  .object({
    ogTitle: z.string().max(180).nullable().optional(),
    ogDescription: z.string().max(320).nullable().optional(),
    twitterTitle: z.string().max(180).nullable().optional(),
    twitterDescription: z.string().max(320).nullable().optional(),
    extraKeyphrases: z.array(z.string().max(160)).max(5).optional(),
    schemaType: z.enum(SCHEMA_TYPE_VALUES).optional(),
    schemaData: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .nullable()
  .optional()

// ── The ONE override-bag shape ──
// `PanelSeoMeta` is derived directly from `SeoMetaSchema` (now possible
// because every field is `.nullable().optional()` after the C1 fix). The
// editors + the panel + the server `SeoMeta` interface all reference THIS
// type, so the override-bag shape can never drift across the five sites
// that used to hand-copy it.
export type PanelSeoMeta = NonNullable<z.infer<typeof SeoMetaSchema>>

/**
 * Drop "no override" keys from an override bag so the empty/cleared state
 * has ONE canonical representation: the key is ABSENT, never `null` /
 * `''` / `[]` / `{}`. This makes the editor dirty-check symmetric — the
 * client parser, the server `parseSeoMeta`, and the panel's clear path
 * all converge on the same object shape, so `structuralEqual` no longer
 * sees a phantom diff between `{ogTitle: null}` and `{}` (or between a
 * `null` field and an `undefined` one).
 */
export function normalizeSeoMeta(m: PanelSeoMeta): PanelSeoMeta {
  const out: PanelSeoMeta = {}
  if (m.ogTitle) out.ogTitle = m.ogTitle
  if (m.ogDescription) out.ogDescription = m.ogDescription
  if (m.twitterTitle) out.twitterTitle = m.twitterTitle
  if (m.twitterDescription) out.twitterDescription = m.twitterDescription
  if (m.extraKeyphrases && m.extraKeyphrases.length > 0) {
    out.extraKeyphrases = m.extraKeyphrases
  }
  if (m.schemaType) out.schemaType = m.schemaType
  if (m.schemaData && Object.keys(m.schemaData).length > 0) {
    out.schemaData = m.schemaData
  }
  return out
}

/**
 * An override bag with no meaningful fields → clear the column (the route
 * sends `null`). The ONE definition the page / blog / project editors all
 * import, so the empty-bag rule lives in a single place. Equivalent to
 * `Object.keys(normalizeSeoMeta(m)).length === 0`.
 */
export function isEmptySeoMeta(m: PanelSeoMeta): boolean {
  return Object.keys(normalizeSeoMeta(m)).length === 0
}

/**
 * Client-safe parse of the raw `seo_meta` cell (a JSON string from
 * MariaDB, or an already-parsed object) into a NORMALIZED `PanelSeoMeta`.
 * Mirrors the server-only `parseSeoMeta` (lib/seo/seoMeta.ts) field-for-
 * field, then normalizes so "no override" keys are dropped. Never throws;
 * malformed input → `{}`. This is the ONE client parser; PageEditor +
 * any other client component import it instead of hand-rolling their own.
 */
export function parsePanelSeoMeta(raw: unknown): PanelSeoMeta {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {}
    try {
      obj = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const r = obj as Record<string, unknown>
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined
  return normalizeSeoMeta({
    ogTitle: str(r.ogTitle),
    ogDescription: str(r.ogDescription),
    twitterTitle: str(r.twitterTitle),
    twitterDescription: str(r.twitterDescription),
    extraKeyphrases: Array.isArray(r.extraKeyphrases)
      ? r.extraKeyphrases.filter((x): x is string => typeof x === 'string')
      : undefined,
    schemaType:
      typeof r.schemaType === 'string' && SCHEMA_TYPE_SET.has(r.schemaType)
        ? (r.schemaType as SchemaTypeValue)
        : undefined,
    schemaData:
      r.schemaData != null &&
      typeof r.schemaData === 'object' &&
      !Array.isArray(r.schemaData)
        ? (r.schemaData as Record<string, unknown>)
        : undefined,
  })
}

// Spread into each editor object schema (BEFORE the `.strict()` call so
// the keys are part of the accepted set):
//   z.object({ ...existingFields, ...SeoEditorFields }).strict()
export const SeoEditorFields = {
  focusKeyphrase: z.string().max(160).nullable().optional(),
  robotsNoindex: z.boolean().optional(),
  robotsNofollow: z.boolean().optional(),
  canonicalUrl: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .refine(
      // Accept an absolute http(s) URL OR a root-relative path whose leading
      // slash is NOT followed by another slash. The `(?!\/)` negative
      // lookahead rejects a protocol-relative `//evil.com` (which `^\/` alone
      // would accept) — that value would otherwise become a canonical/og:url
      // pointing at an attacker host. `javascript:`/`data:` are already
      // excluded by requiring either http(s):// or a leading slash.
      (v) => v == null || v === '' || /^(https?:\/\/|\/(?!\/))/.test(v),
      'must_be_https_or_path',
    ),
  cornerstone: z.boolean().optional(),
  seoScore: z.number().int().min(0).max(100).nullable().optional(),
  readabilityScore: z.number().int().min(0).max(100).nullable().optional(),
  seoMeta: SeoMetaSchema,
}
