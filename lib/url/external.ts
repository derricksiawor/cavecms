// One predicate + one rel helper for every "operator-set link" surface
// (SiteHeader, SiteHeaderMobile, SiteFooter columns, footer legal
// links, future header dropdowns). Lifting these into a shared module
// keeps the security semantics consistent — if the rule ever tightens
// (e.g., treat `mailto:` as same-tab regardless of openInNew), every
// surface follows.

export function isLikelyExternal(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

// Whenever we set `target="_blank"` on an operator-controlled link we
// must also set `rel="noopener noreferrer"` to prevent reverse-tabnab
// + Referer leak. For same-tab external links we drop `noopener`
// (it's only relevant with _blank) but keep `noreferrer` to avoid
// leaking the page path to third parties.
export function externalRel(href: string, openInNew?: boolean): string | undefined {
  if (!isLikelyExternal(href)) return undefined
  return openInNew ? 'noopener noreferrer' : 'noreferrer'
}
