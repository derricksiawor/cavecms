// The SEO title/description TEMPLATE resolver.
//
// `resolveTemplate(template, ctx)` takes a stored template string like
// `'%title% %sep% %sitename%'` and produces the final, render-ready string:
//
//   1. Replace every `%token%` (and the graceful `%token(args)%` form) with
//      its resolved value. Known tokens use their registered resolver;
//      well-formed-but-unknown tokens strip to ''. The raw `%x%` never
//      survives into output.
//   2. Collapse runs of whitespace to a single space and trim.
//   3. Remove DANGLING SEPARATORS — a leading / trailing / duplicated
//      separator glyph left behind when an adjacent variable resolved to ''
//      (e.g. `"Foo  –  – Bar"` → `"Foo – Bar"`, `" – Bar"` → `"Bar"`).
//      Yoast + Rank Math both perform this cleanup so an empty %title% or
//      %sitename% doesn't leave an orphan separator in the <title>.
//
// Pure functions — NO server-only / DOM imports.

import type { TemplateContext } from './types'
import { VARIABLE_BY_TOKEN } from './variables'

// Matches a single `%token%` or `%token(args)%`. The token name is
// [A-Za-z0-9_], optionally followed by a parenthesised argument list. We
// deliberately do NOT allow nested `%` inside the name so a stray lone `%`
// in operator copy is left untouched rather than greedily consumed.
const TOKEN_RE = /%([a-z0-9_]+)(\([^)]*\))?%/gi

/**
 * Replace every well-formed `%token%` / `%token(args)%` with its resolved
 * value. Known tokens resolve via their registry entry; well-formed but
 * UNKNOWN tokens resolve to '' (stripped). Lone/unbalanced `%` and any
 * text that isn't a well-formed token are passed through verbatim.
 *
 * Args form: if a known variable doesn't implement arguments (none do yet)
 * the args are ignored and the base token resolves; an unknown token with
 * args strips to '' like any other unknown.
 */
export function stripUnknownVariables(
  template: string,
  ctx: TemplateContext,
): string {
  return template.replace(TOKEN_RE, (_match, rawName: string) => {
    const token = `%${rawName.toLowerCase()}%`
    const variable = VARIABLE_BY_TOKEN.get(token)
    if (!variable) return '' // well-formed but unknown → strip
    return variable.resolve(ctx)
  })
}

/**
 * Collapse all internal whitespace (including newlines/tabs) to single
 * spaces and trim the ends.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * Remove dangling/duplicated separator glyphs left when an adjacent
 * variable resolved to ''. Operates on the already-whitespace-collapsed
 * string. `separator` is the operator's `%sep%` glyph (treated literally —
 * regex-escaped before matching, since it can be any character such as
 * `|`, `-`, `·`, etc.).
 *
 * Cleans:
 *   - a leading separator:   `"– Bar"`        → `"Bar"`
 *   - a trailing separator:  `"Foo –"`        → `"Foo"`
 *   - duplicated separators: `"Foo – – Bar"`  → `"Foo – Bar"`
 *
 * CRITICAL CORRECTNESS GUARD: a separator occurrence is only "dangling"
 * (strip-eligible) when it is WHITESPACE-FLANKED ON BOTH SIDES — i.e. it
 * has whitespace (or the string edge) immediately on each side. A
 * separator that abuts a non-space content character on EITHER side is
 * legitimate content and is left untouched. This matters when the
 * operator's `%sep%` glyph is itself a content character like `.`/`!`/
 * `?`/`)` — e.g. `"Acme Inc."` with sep `.` must stay `"Acme Inc."` (the
 * period of "Inc." abuts "c" on its left, so it is NOT dangling), while a
 * genuinely orphaned `"Foo ."` (space-flanked, edge on the right) still
 * strips to `"Foo"`.
 *
 * If the separator is empty/whitespace-only there is nothing to clean.
 */
function cleanDanglingSeparators(value: string, separator: string): string {
  const sep = separator.trim()
  if (!sep) return value
  const e = escapeRegExp(sep)

  // A string that is NOTHING BUT the separator (optionally space-padded) is
  // an orphan glyph with no content on either side — strip it entirely. This
  // is the "a <title> of just '–'" case (Yoast/Rank Math both blank it). We
  // special-case it here because the side-aware leading/trailing trims below
  // require whitespace on the INNER side, which a lone separator lacks.
  if (new RegExp(`^${e}$`).test(value.trim())) return ''

  let out = value

  // Collapse a RUN of dangling separators down to one. A run is two-or-more
  // separators where (a) the whole run is whitespace-flanked on both outer
  // sides (lookbehind for start-or-space, lookahead for end-or-space) and
  // (b) each separator inside the run is space/edge-separated from the next.
  // This never touches `"Inc."` (no whitespace before the dot) but collapses
  // `"Foo – – Bar"` (space-flanked run). Run repeatedly so a triple `– – –`
  // collapses fully, not just pairwise once.
  const dupRe = new RegExp(
    `(?<=^|\\s)${e}(?:\\s+${e})+(?=\\s|$)`,
    'g',
  )
  let prev: string
  do {
    prev = out
    out = out.replace(dupRe, sep)
  } while (out !== prev)

  // Trim a leading separator ONLY when it is followed by whitespace (i.e.
  // it is space-flanked: string-start on the left, whitespace on the right).
  // A leading separator that abuts content (`".5 release"` with sep `.`)
  // is NOT stripped.
  out = out.replace(new RegExp(`^${e}(?=\\s)\\s*`), '')
  // Trim a trailing separator ONLY when it is preceded by whitespace.
  out = out.replace(new RegExp(`\\s*(?<=\\s)${e}$`), '')

  return collapseWhitespace(out)
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve a stored SEO template against a context into the final
 * render-ready string. See module header for the full pipeline.
 */
export function resolveTemplate(
  template: string,
  ctx: TemplateContext,
): string {
  if (!template) return ''
  const replaced = stripUnknownVariables(template, ctx)
  const collapsed = collapseWhitespace(replaced)
  return cleanDanglingSeparators(collapsed, ctx.separator ?? '')
}
