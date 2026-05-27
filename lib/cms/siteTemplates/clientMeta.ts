// Client-safe template metadata. The full SITE_TEMPLATES registry
// imports every template's heavy page-tree content (5 pages × 9
// templates ≈ thousands of lines), which the install wizard's tile
// picker doesn't need on the client. This module exports JUST the
// fields the picker needs to render — name, slug, kind, tagline,
// description, palette — so the client bundle stays small.
//
// Keep this list in sync with SITE_TEMPLATES in ./index.ts. The
// install/template API endpoint enforces the slug allowlist via the
// server-side registry, so a drift here just shows a misleading tile
// — never lets an invalid slug through.

export type TemplateClientMeta = {
  slug: string
  name: string
  kind: string
  tagline: string
  description: string
  vibe:
    | 'hospitality'
    | 'realestate'
    | 'construction'
    | 'church'
    | 'software'
    | 'freelance'
    | 'restaurant'
    | 'wellness'
    | 'generic'
  themePalette: { bg: string; fg: string; accent: string; muted: string }
  /** Whether this is the no-op default ("I'll pick later") tile. */
  isDefault?: boolean
}

export const TEMPLATE_CLIENT_META: TemplateClientMeta[] = [
  {
    slug: 'default-welcome',
    name: "I'll pick later",
    kind: 'CaveCMS welcome',
    tagline: 'A clean slate to build from.',
    description:
      'Skip the template chooser. Installs the CaveCMS welcome one-pager — a blank canvas you build out yourself.',
    vibe: 'generic',
    themePalette: {
      bg: '#0a0a0c',
      fg: '#f5f1ea',
      accent: '#b88f6a',
      muted: '#6e665a',
    },
    isDefault: true,
  },
  {
    slug: 'hotel-solenne',
    name: 'Hôtel Solenne',
    kind: 'Boutique hotel',
    tagline: 'A quieter way to stay.',
    description:
      'A grand-yet-quiet boutique hotel. Rooms, dining, story, gallery, reservations.',
    vibe: 'hospitality',
    themePalette: {
      bg: '#0a0a0c',
      fg: '#f5f1ea',
      accent: '#c9a961',
      muted: '#6e665a',
    },
  },
  {
    slug: 'harbor-and-lane',
    name: 'Harbor & Lane',
    kind: 'Real estate',
    tagline: 'Homes that hold a life.',
    description:
      'A modern brokerage. Listing grid, agents, neighborhood guides, contact.',
    vibe: 'realestate',
    themePalette: {
      bg: '#f5f1ea',
      fg: '#0e0e0c',
      accent: '#7a8a6a',
      muted: '#857e72',
    },
  },
  {
    slug: 'ironclad-build',
    name: 'Ironclad Build',
    kind: 'Construction',
    tagline: 'Done. Properly.',
    description:
      'A confident contractor site. Services, project timeline, quote requests, certifications.',
    vibe: 'construction',
    themePalette: {
      bg: '#10141a',
      fg: '#eaefef',
      accent: '#d97a3c',
      muted: '#7a8090',
    },
  },
  {
    slug: 'grace-hill',
    name: 'Grace Hill',
    kind: 'Church',
    tagline: 'Come as you are.',
    description:
      'A warm community church. Sermons, service times, ministries, giving.',
    vibe: 'church',
    themePalette: {
      bg: '#faf6ee',
      fg: '#1c1814',
      accent: '#8a6a4c',
      muted: '#867e72',
    },
  },
  {
    slug: 'velocity',
    name: 'Velocity',
    kind: 'Software',
    tagline: 'Faster than yesterday.',
    description:
      'A modern SaaS landing. Hero, feature matrix, pricing, changelog, docs.',
    vibe: 'software',
    themePalette: {
      bg: '#06080d',
      fg: '#f4f6fb',
      accent: '#7da6ff',
      muted: '#7d8597',
    },
  },
  {
    slug: 'studio-verde',
    name: 'Studio Verde',
    kind: 'Design studio',
    tagline: 'Brands that move people.',
    description:
      'A creative studio portfolio. Case studies, process, the team, contact.',
    vibe: 'freelance',
    themePalette: {
      bg: '#0d0e0d',
      fg: '#eef0ec',
      accent: '#a8c97a',
      muted: '#7f8278',
    },
  },
  {
    slug: 'maison-brulee',
    name: 'Maison Brûlée',
    kind: 'Restaurant',
    tagline: 'A table worth keeping.',
    description:
      'A neighborhood restaurant. Menu, story, chef, reservations, press.',
    vibe: 'restaurant',
    themePalette: {
      bg: '#1a0e0a',
      fg: '#f5e6d3',
      accent: '#c97a3a',
      muted: '#7a6a5a',
    },
  },
  {
    slug: 'anara-wellness',
    name: 'Anara Wellness',
    kind: 'Spa & wellness',
    tagline: 'Quiet, restored.',
    description:
      'A serene spa. Treatments, practitioners, journal, booking.',
    vibe: 'wellness',
    themePalette: {
      bg: '#f4ede2',
      fg: '#1f1c18',
      accent: '#b88f6a',
      muted: '#7c7468',
    },
  },
]
