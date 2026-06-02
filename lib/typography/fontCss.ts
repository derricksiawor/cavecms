/**
 * Font CSS emitters — injected as a nonce'd <style> by app/layout.tsx,
 * mirroring lib/cms/themeCss.brandVarsCss.
 *
 *   catalogVarsCss()  — static `--font-cat-<key>` map (one per catalog
 *                       font). Deterministic; computed once.
 *   roleVarsCss(roles)— points `--font-display` / `--font-body` at the
 *                       operator-chosen catalog fonts (Settings →
 *                       Typography). Re-validates every key against the
 *                       catalog as defence-in-depth: a tampered settings
 *                       cell can never inject arbitrary CSS — an unknown
 *                       key falls back to the shipped role default.
 *
 * PURE module (no server-only) so it can be unit-tested in isolation.
 */

import {
  FONT_CATALOG,
  FONT_CATALOG_ORDER,
  fontCatalogVar,
  TYPOGRAPHY_ROLES,
  TYPOGRAPHY_ROLE_META,
  TYPOGRAPHY_ROLES_DEFAULT,
  type TypographyRole,
} from './catalog'
import {
  CUSTOM_FONT_KEY_RE,
  CUSTOM_FONT_FILE_RE,
  CUSTOM_FONT_FALLBACK,
  CSS_FONT_FORMAT,
  type CustomFont,
} from './customFonts'
import { GOOGLE_FONT_KEY_RE, GOOGLE_FONT_FILE_RE } from './googleFontKeys'

// A runtime font (operator-uploaded custom OR activated Google) is valid for
// CSS emission when its key + file BOTH match EITHER tier's strict regexes —
// `cf-…` (custom) or `gf-…` (Google). Defence-in-depth: re-checked at the CSS
// boundary so a tampered settings row of either kind can never break out of
// the @font-face declaration and inject arbitrary CSS. Both tiers store the
// identical CustomFont member shape, so one emitter serves both.
function isEmittableRuntimeFont(f: CustomFont): boolean {
  return (
    (CUSTOM_FONT_KEY_RE.test(f.key) && CUSTOM_FONT_FILE_RE.test(f.file)) ||
    (GOOGLE_FONT_KEY_RE.test(f.key) && GOOGLE_FONT_FILE_RE.test(f.file))
  )
}

// `--font-cat-<key>: "<@font-face name>", <fallback>;` for every font.
// Quote the @font-face name (it contains spaces); the fallback brings its
// own quoting. Computed once — the catalog is static.
const CATALOG_VARS_CSS: string = (() => {
  const decls = FONT_CATALOG_ORDER.map((key) => {
    const f = FONT_CATALOG[key]!
    return `${fontCatalogVar(key)}:"${f.cssFamily}", ${f.fallback}`
  })
  return `:root{${decls.join(';')}}`
})()

export function catalogVarsCss(): string {
  return CATALOG_VARS_CSS
}

// `@font-face` + `--font-cat-<key>` for each runtime font — operator-uploaded
// custom (`cf-…`) AND activated Google (`gf-…`) fonts, both served self-hosted
// from /uploads/fonts (a visitor NEVER talks to Google). Defence-in-depth:
// re-validate each key + file against the tier regexes before interpolating
// into CSS, so a tampered settings row of either kind can never break out of
// the declaration and inject arbitrary CSS. Returns '' when there are none.
export function customFontFaceCss(fonts: readonly CustomFont[] | null | undefined): string {
  if (!fonts || fonts.length === 0) return ''
  const parts: string[] = []
  for (const f of fonts) {
    if (!isEmittableRuntimeFont(f)) continue
    // The key (already `cf-…`, regex-safe, unique) IS the @font-face name —
    // no extra prefix. Quoting handles the hyphens.
    const cssFamily = f.key
    const weight = f.weightRange
      ? `${f.weightRange[0]} ${f.weightRange[1]}`
      : `${f.staticWeight ?? 400}`
    const style = f.italic ? 'italic' : 'normal'
    const fmt = CSS_FONT_FORMAT[f.format]
    const fallback = CUSTOM_FONT_FALLBACK[f.category] ?? CUSTOM_FONT_FALLBACK.sans
    parts.push(
      `@font-face{font-family:"${cssFamily}";` +
        `src:url("/uploads/fonts/${f.file}") format("${fmt}");` +
        `font-weight:${weight};font-style:${style};font-display:swap;}`,
    )
    parts.push(`${fontCatalogVar(f.key)}:"${cssFamily}", ${fallback}`)
  }
  if (parts.length === 0) return ''
  // Split the @font-face rules (top-level) from the :root var decls.
  const faces = parts.filter((p) => p.startsWith('@font-face'))
  const vars = parts.filter((p) => !p.startsWith('@font-face'))
  return `${faces.join('')}:root{${vars.join(';')}}`
}

export type TypographyRoles = Record<TypographyRole, string>

// Resolve a role's font key. Fails closed to the shipped default unless the
// key is ACTIVE — a bundled catalog font OR one of the supplied runtime
// (custom `cf-…` / Google `gf-…`) font keys (so a role pointing at one
// renders, but a deleted/garbage key still degrades safely to
// Marcellus/Montserrat).
function resolveRoleKey(
  roles: Partial<TypographyRoles>,
  role: TypographyRole,
  activeKeys: ReadonlySet<string>,
): string {
  const k = roles?.[role]
  return k && activeKeys.has(k) ? k : TYPOGRAPHY_ROLES_DEFAULT[role]
}

export function roleVarsCss(
  roles: Partial<TypographyRoles> | null | undefined,
  customFonts?: readonly CustomFont[] | null,
): string {
  const safe = roles ?? {}
  const active = new Set<string>(FONT_CATALOG_ORDER)
  for (const f of customFonts ?? []) {
    // Either tier's key (custom `cf-…` or Google `gf-…`) counts as active.
    if (CUSTOM_FONT_KEY_RE.test(f.key) || GOOGLE_FONT_KEY_RE.test(f.key)) {
      active.add(f.key)
    }
  }
  const decls = TYPOGRAPHY_ROLES.map((role) => {
    const key = resolveRoleKey(safe, role, active)
    return `${TYPOGRAPHY_ROLE_META[role].cssVar}:var(${fontCatalogVar(key)})`
  })
  return `:root{${decls.join(';')}}`
}

// Convenience for the layout: catalog vars + runtime @font-face + role vars,
// in cascade order (runtime vars before role vars so a role can reference a
// runtime key). `runtimeFonts` is the COMBINED active list — operator-uploaded
// custom (`cf-…`) ∪ activated Google (`gf-…`) — both stored as the same
// CustomFont shape; the layout passes `[...custom_fonts, ...google_fonts]`.
export function typographyCss(
  roles: Partial<TypographyRoles> | null | undefined,
  runtimeFonts?: readonly CustomFont[] | null,
): string {
  return `${catalogVarsCss()}${customFontFaceCss(runtimeFonts)}${roleVarsCss(roles, runtimeFonts)}`
}
