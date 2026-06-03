// The supported SEO template variable vocabulary + their resolvers.
//
// Each entry pairs a literal `%token%` with a label (for the admin
// inserter UI), a UI group, and a PURE resolver `(ctx) => string`. A
// resolver returns `''` whenever the relevant context field is absent —
// the empty result is then stripped (and any dangling separator cleaned)
// by `resolveTemplate`. Vocabulary mirrors a useful subset of Rank Math's
// `%variable%` set so an operator migrating from WordPress sees familiar
// tokens.
//
// Pure data — NO server-only / DOM imports.

import type {
  TemplateContext,
  TemplateVariable,
  TemplateVariableGroup,
} from './types'

// Small helper: trim a possibly-undefined string, falling back to ''.
const s = (v: string | undefined | null): string => (v ?? '').trim()

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  // ── basic ──
  {
    token: '%sep%',
    label: 'Separator',
    group: 'basic',
    // The separator is always a string on the context; never trimmed away
    // (an operator may intentionally use a space-padded glyph).
    resolve: (ctx: TemplateContext) => ctx.separator ?? '',
  },
  {
    token: '%sitename%',
    label: 'Site title',
    group: 'basic',
    resolve: (ctx) => s(ctx.siteName),
  },
  {
    token: '%sitedesc%',
    label: 'Site description',
    group: 'basic',
    resolve: (ctx) => s(ctx.siteDesc),
  },
  {
    token: '%title%',
    label: 'Title',
    group: 'basic',
    resolve: (ctx) => s(ctx.title),
  },
  {
    token: '%excerpt%',
    label: 'Excerpt',
    group: 'basic',
    resolve: (ctx) => s(ctx.excerpt),
  },
  {
    token: '%focuskw%',
    label: 'Focus keyphrase',
    group: 'basic',
    resolve: (ctx) => s(ctx.focusKeyphrase),
  },

  // ── date ──
  {
    token: '%currentyear%',
    label: 'Current year',
    group: 'date',
    // Falls back to the live year so a "© %currentyear%"-style template
    // always has a value even when the caller didn't pre-compute one.
    resolve: (ctx) =>
      s(ctx.currentYear) || String(new Date().getFullYear()),
  },
  {
    token: '%currentdate%',
    label: 'Current date',
    group: 'date',
    resolve: (ctx) => s(ctx.currentDate),
  },
  {
    token: '%date%',
    label: 'Publish date',
    group: 'date',
    resolve: (ctx) => s(ctx.date),
  },
  {
    token: '%modified%',
    label: 'Last modified',
    group: 'date',
    resolve: (ctx) => s(ctx.modified),
  },

  // ── pagination (special) ──
  {
    token: '%page%',
    label: 'Page X of Y',
    group: 'special',
    // Renders "Page X of Y" ONLY for genuinely multi-page contexts; a
    // single-page entry strips the token entirely (matches Rank Math).
    resolve: (ctx) => {
      const p = ctx.page
      if (!p || !Number.isFinite(p.total) || p.total <= 1) return ''
      return `Page ${p.current} of ${p.total}`
    },
  },
  {
    token: '%pagenumber%',
    label: 'Page number',
    group: 'special',
    resolve: (ctx) =>
      ctx.page && Number.isFinite(ctx.page.current)
        ? String(ctx.page.current)
        : '',
  },
  {
    token: '%pagetotal%',
    label: 'Total pages',
    group: 'special',
    resolve: (ctx) =>
      ctx.page && Number.isFinite(ctx.page.total)
        ? String(ctx.page.total)
        : '',
  },
  {
    token: '%searchphrase%',
    label: 'Search query',
    group: 'special',
    resolve: (ctx) => s(ctx.searchPhrase),
  },
  {
    token: '%pt_single%',
    label: 'Post type (singular)',
    group: 'special',
    resolve: (ctx) => s(ctx.ptSingle),
  },
  {
    token: '%pt_plural%',
    label: 'Post type (plural)',
    group: 'special',
    resolve: (ctx) => s(ctx.ptPlural),
  },

  // ── taxonomy ──
  {
    token: '%category%',
    label: 'Category',
    group: 'taxonomy',
    resolve: (ctx) => s(ctx.category),
  },

  // ── author ──
  {
    token: '%name%',
    label: 'Author name',
    group: 'author',
    resolve: (ctx) => s(ctx.authorName),
  },
  {
    token: '%org_name%',
    label: 'Organisation name',
    group: 'author',
    resolve: (ctx) => s(ctx.orgName),
  },
]

/**
 * Variables bucketed by UI group, in inserter display order. Each group
 * key maps to the subset of `TEMPLATE_VARIABLES` in that group, preserving
 * registration order. Empty groups are omitted.
 */
export const VARIABLE_GROUPS: Record<
  TemplateVariableGroup,
  TemplateVariable[]
> = (() => {
  const order: TemplateVariableGroup[] = [
    'basic',
    'date',
    'taxonomy',
    'author',
    'special',
  ]
  const out = {} as Record<TemplateVariableGroup, TemplateVariable[]>
  for (const g of order) {
    out[g] = TEMPLATE_VARIABLES.filter((v) => v.group === g)
  }
  return out
})()

/**
 * Fast token → variable lookup, built once. Keys are the literal tokens
 * (e.g. `'%title%'`). Used by the resolver's replacement pass.
 */
export const VARIABLE_BY_TOKEN: ReadonlyMap<string, TemplateVariable> =
  new Map(TEMPLATE_VARIABLES.map((v) => [v.token, v]))
