// Shared public-render types for the header navigation. The footer keeps
// its own { label, links:[{ text, href }] } shape inline in SiteFooter.tsx.
export interface NavChild {
  label: string
  href: string
}
export interface NavItem {
  label: string
  href: string
  children?: NavChild[]
}
