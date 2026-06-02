/**
 * Operator-uploaded custom fonts — the runtime tier alongside the bundled
 * @fontsource catalog. Stored in the `custom_fonts` setting (metadata) with
 * the binary on disk under UPLOADS_ROOT/fonts, served self-hosted from
 * /uploads/fonts/<file> (CSP stays font-src 'self' — no external requests).
 *
 * PURE module: shared by the server Zod schema (settings-registry), the CSS
 * emitter (fontCss), the upload endpoint, and the client picker. No DOM /
 * server-only imports.
 */

import type { FontCategory } from './catalog'

export type FontFileFormat = 'woff2' | 'woff' | 'ttf' | 'otf'

export interface CustomFont {
  /** `cf-<slug>-<id>` — namespaced so it can never collide with a bundled
   *  catalog slug, and so the @font-face / serving paths are predictable. */
  key: string
  /** Operator-chosen display label (shown in the picker). */
  family: string
  category: FontCategory
  /** Filename under UPLOADS_ROOT/fonts — always `<key>.<ext>`. */
  file: string
  format: FontFileFormat
  /** Variable wght axis [min,max], or null/absent for a static weight. */
  weightRange?: readonly [number, number] | null
  staticWeight?: number
  italic?: boolean
}

// Validation regexes — re-checked at EVERY trust boundary (schema, emitter,
// endpoint, delete) so a tampered settings row can never inject CSS or
// escape the fonts dir.
export const CUSTOM_FONT_KEY_RE = /^cf-[a-z0-9-]{1,48}$/
export const CUSTOM_FONT_FILE_RE = /^cf-[a-z0-9-]+\.(woff2|woff|ttf|otf)$/

// Fallback stack appended after the custom face, by category. Mirrors the
// bundled catalog's category fallbacks so a custom font degrades sensibly.
export const CUSTOM_FONT_FALLBACK: Record<FontCategory, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  display: 'system-ui, -apple-system, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
}

// woff2→woff2, woff→woff, ttf→truetype, otf→opentype (the CSS `format()` hint).
export const CSS_FONT_FORMAT: Record<FontFileFormat, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
}

/** Slugify an operator-typed family name into the `<slug>` portion of a key. */
export function slugifyFamily(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}
