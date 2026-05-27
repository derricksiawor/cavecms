// Site-template registry types. These mirror the WidgetSpec / ColumnSpec /
// SectionSpec shapes used in db/seeds/systemPageBlocks.ts — kept here as a
// public surface so siteTemplates/*.ts files can import them without
// reaching across into the seed module.
//
// A SiteTemplate is a complete site bundle: an industry name + colour
// palette + a tree of pages, each with their CMS block tree + branding
// defaults the install wizard seeds into settings.site_header / footer
// when the operator picks the template.

export interface WidgetSpec {
  kind: 'widget'
  blockType: string
  data: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface ColumnSpec {
  kind: 'column'
  meta?: Record<string, unknown>
  widgets: WidgetSpec[]
}

export interface SectionSpec {
  kind: 'section'
  meta: Record<string, unknown>
  columns: ColumnSpec[]
}

export interface PageSpec {
  /** url slug, e.g. 'home', 'rooms', 'reservations' */
  slug: string
  /** page title (also seeds seo_title when seoTitle is unset) */
  title: string
  /** exactly one PageSpec per template should be home */
  isHome?: boolean
  /** SEO overrides */
  seoTitle?: string
  seoDescription?: string
  /** body — tree of sections */
  sections: SectionSpec[]
}

export type TemplateVibe =
  | 'hospitality'
  | 'realestate'
  | 'construction'
  | 'church'
  | 'software'
  | 'freelance'
  | 'restaurant'
  | 'wellness'
  | 'generic'

export interface ThemePalette {
  bg: string
  fg: string
  accent: string
  muted: string
}

export interface NavItem {
  label: string
  href: string
}

export interface FooterColumn {
  label: string
  links: Array<{ text: string; href: string }>
}

export interface BrandingSpec {
  /** brand name shown in the header (defaults to template name when unset) */
  brandText: string
  /** Site header palette — maps to settings.site_header.theme enum */
  headerTheme: 'cream' | 'obsidian' | 'ivory' | 'champagne' | 'bone'
  /** Primary navigation links (max 6 per site_header schema) */
  primaryNav: NavItem[]
  /** Single primary CTA shown to the right of the nav (null = no button) */
  primaryCta: { text: string; href: string } | null
  /** Footer columns (max 6) */
  footerColumns: FooterColumn[]
  /** Footer tagline (small text under brandText in the footer) */
  footerTagline: string
}

export interface SiteTemplate {
  /** stable slug used as the API selector */
  slug: string
  /** Human-readable name shown on the tile */
  name: string
  /** One-line kind label ("Boutique hotel", "Real estate", …) */
  kind: string
  /** Tagline shown on the tile */
  tagline: string
  /** Long-form description rendered on the tile description line */
  description: string
  /** Vibe — used for tile sort + accent treatment */
  vibe: TemplateVibe
  /** Palette used to render the tile preview */
  themePalette: ThemePalette
  /** Full page tree (Home + 4+ others). Exactly one page MUST have isHome */
  pages: PageSpec[]
  /** Branding defaults seeded into settings on template selection */
  branding: BrandingSpec
}
