import 'server-only'
import data from './googleFontsData.json'
import type { FontCategory } from './catalog'
import { GOOGLE_FONT_KEY_RE, GOOGLE_FONT_FILE_RE, googleKey } from './googleFontKeys'

// Re-export the pure key helpers so server callers can `import … from
// './googleFonts'` without also reaching into googleFontKeys directly.
export { GOOGLE_FONT_KEY_RE, GOOGLE_FONT_FILE_RE, googleKey }

/**
 * Google Fonts catalog — the full ~1,934-family library, surfaced in the
 * admin picker. Selecting one ACTIVATES it: the server fetches its woff2
 * ONCE, stores it self-hosted under UPLOADS_ROOT/fonts, and registers it in
 * the `google_fonts` setting with the SAME shape as a CustomFont (key
 * `gf-<slug>`). Public pages then emit ONLY a self-hosted @font-face — a
 * visitor NEVER talks to Google (privacy / GDPR; the product's
 * "self-hosted, nothing leaks to third parties" promise).
 *
 * This module is the metadata source of truth, parsed from the pre-generated
 * googleFontsData.json (163 KB). It is `server-only` so the 163 KB blob never
 * lands in the client bundle — the admin picker fetches the catalog from
 * GET /api/admin/fonts/google instead.
 */

// Compact on-disk shape of each entry in googleFontsData.json.
interface RawGoogleFont {
  /** slug — lowercase/dash family slug, the `<slug>` in key `gf-<slug>`. */
  s: string
  /** family — Google's display name (e.g. "Playfair Display"). */
  f: string
  /** category — our four buckets. */
  c: FontCategory
  /** weights — discrete weights the family ships. */
  w: number[]
  /** italic — true when the family has an italic style. */
  i?: boolean
  /** variable wght axis [min,max] — present only for variable fonts. */
  v?: [number, number]
}

export interface GoogleFontMeta {
  slug: string
  family: string
  category: FontCategory
  weights: readonly number[]
  italic: boolean
  /** Variable wght axis [min,max], or null for a static family. */
  variable: readonly [number, number] | null
}

// Parse the compact blob into the wide GoogleFontMeta shape ONCE at module
// load. Sorted-by-popularity order is preserved (Roboto first) for the picker.
export const GOOGLE_FONTS: GoogleFontMeta[] = (data as RawGoogleFont[]).map((d) => ({
  slug: d.s,
  family: d.f,
  category: d.c,
  weights: d.w,
  italic: d.i === true,
  variable: d.v ?? null,
}))

// O(1) slug lookup for the activation endpoint's existence check.
const BY_SLUG: Map<string, GoogleFontMeta> = new Map(
  GOOGLE_FONTS.map((g) => [g.slug, g]),
)

export function googleFontBySlug(slug: string): GoogleFontMeta | undefined {
  return BY_SLUG.get(slug)
}
