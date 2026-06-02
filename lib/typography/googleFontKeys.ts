/**
 * Google-font key + file validation regexes. PURE module (no `server-only`,
 * no JSON import) so the settings registry, the activation endpoint, the
 * delete endpoint, and any client code can re-validate the `gf-<slug>` shape
 * at every trust boundary WITHOUT dragging the 163 KB googleFontsData.json
 * blob (imported by googleFonts.ts) into their module graph.
 *
 * `gf-<slug>` is namespaced so an activated Google font can never collide
 * with a bundled catalog slug or a `cf-` custom-font key. The 60-char slug
 * ceiling keeps the key within catalog.ts FONT_KEY_RE's 64-char total budget
 * (the `gf-` prefix is 3 chars), so resolveFamilyRender / isFontKeySlug treat
 * `gf-*` keys as valid font-key slugs and emit `var(--font-cat-gf-<slug>)`.
 */
export const GOOGLE_FONT_KEY_RE = /^gf-[a-z0-9-]{1,60}$/
export const GOOGLE_FONT_FILE_RE = /^gf-[a-z0-9-]+\.woff2$/

export function googleKey(slug: string): string {
  return `gf-${slug}`
}
