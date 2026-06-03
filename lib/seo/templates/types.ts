// SEO title/description TEMPLATE resolver — shared types.
//
// CaveCMS stores per-content-type title/description templates in the
// `seo_titles` setting (see lib/cms/settings-registry.ts). Each template
// is a string with `%variable%` tokens — e.g. `%title% %sep% %sitename%` —
// resolved at render time against a `TemplateContext` built from the
// page/post/project row + site settings. The vocabulary mirrors a useful
// subset of Rank Math's `%variable%` set so an operator migrating from
// WordPress sees familiar tokens.
//
// Pure data + pure functions only — NO server-only / DOM imports. This
// module is consumed both at render time (server) and in the admin
// inserter UI (client), so it must stay isomorphic.

/**
 * Everything a template can reference. Only `siteName`, `siteDesc` and
 * `separator` are guaranteed present (they come from site settings); the
 * rest are optional because they depend on WHAT is being rendered (a post
 * has an author + excerpt, a paginated archive has a page number, a
 * search result page has a search phrase, etc.). A resolver for a token
 * whose context field is absent yields `''` (the token strips cleanly).
 */
export interface TemplateContext {
  // ── Always present (from site settings) ──
  /** Site title — `%sitename%`. */
  siteName: string
  /** Site tagline / description — `%sitedesc%`. */
  siteDesc: string
  /** The `%sep%` glyph (operator-chosen, default en-dash `–`). */
  separator: string

  // ── Entity-dependent (optional) ──
  /** The entity's own title/headline — `%title%`. */
  title?: string
  /** The entity's excerpt/summary — `%excerpt%`. */
  excerpt?: string

  // ── Dates ──
  /** Publish/creation date, pre-formatted by the caller — `%date%`. */
  date?: string
  /** Last-modified date, pre-formatted by the caller — `%modified%`. */
  modified?: string
  /** Current four-digit year — `%currentyear%`. Defaults to now if absent. */
  currentYear?: string
  /** Current date, pre-formatted by the caller — `%currentdate%`. */
  currentDate?: string

  // ── Pagination (archives / multi-page entries) ──
  /**
   * Current + total page count. `%page%` renders "Page X of Y" ONLY when
   * `total > 1`; otherwise it strips to ''. `%pagenumber%` / `%pagetotal%`
   * render the raw numbers.
   */
  page?: { current: number; total: number }

  // ── Taxonomy / SEO ──
  /** Focus keyphrase — `%focuskw%`. */
  focusKeyphrase?: string
  /** Primary category/term name — `%category%`. */
  category?: string
  /** The visitor's search query — `%searchphrase%`. */
  searchPhrase?: string

  // ── Post type labels ──
  /** Singular post-type label (e.g. "Project") — `%pt_single%`. */
  ptSingle?: string
  /** Plural post-type label (e.g. "Projects") — `%pt_plural%`. */
  ptPlural?: string

  // ── Author / organisation ──
  /** Organisation name — `%org_name%`. */
  orgName?: string
  /** Author display name — `%name%`. */
  authorName?: string
}

/** UI grouping for the admin variable inserter. */
export type TemplateVariableGroup =
  | 'basic'
  | 'date'
  | 'taxonomy'
  | 'author'
  | 'special'

/**
 * A single supported template variable: its literal token, a human label
 * for the inserter UI, the group it belongs to, and a pure resolver that
 * maps a context to the variable's string value (`''` when the relevant
 * context field is absent — the token then strips cleanly).
 */
export interface TemplateVariable {
  /** The literal token including the wrapping percents, e.g. `'%title%'`. */
  token: string
  /** Human-readable label for the inserter UI, e.g. "Title". */
  label: string
  /** UI group. */
  group: TemplateVariableGroup
  /** Pure resolver. Returns `''` when the value is unavailable. */
  resolve: (ctx: TemplateContext) => string
}
