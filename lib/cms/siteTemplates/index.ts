// Site-template registry. The install wizard's template chooser picks
// from here; the POST /api/install/template endpoint validates the
// selected slug against this list before seeding pages + branding.
//
// Add a new template:
//   1. Author <slug>.ts in this folder following the existing files
//   2. Import + add to SITE_TEMPLATES below
//   3. Optionally add a roadmap entry in the marketing site
//      (cavecms-web/components/marketing/templates-data.ts) — the two
//      lists are intentionally separate (one is product, one is
//      marketing) but should stay roughly in sync.
//
// Default template slug: 'default-welcome'. The wizard pre-selects this
// tile, and if the operator skips the step entirely the API endpoint
// falls back to this slug. Picking this slug seeds the same content
// the previous default install shipped (no regression vs. pre-template
// behaviour).

import { defaultWelcomeTemplate } from './default-welcome'
import { hotelSolenneTemplate } from './hotel-solenne'
import { harborAndLaneTemplate } from './harbor-and-lane'
import { ironcladBuildTemplate } from './ironclad-build'
import { graceHillTemplate } from './grace-hill'
import { velocityTemplate } from './velocity'
import { studioVerdeTemplate } from './studio-verde'
import { maisonBruleeTemplate } from './maison-brulee'
import { anaraWellnessTemplate } from './anara-wellness'
import type { SiteTemplate } from './types'

export const DEFAULT_TEMPLATE_SLUG = 'default-welcome' as const

export const SITE_TEMPLATES: SiteTemplate[] = [
  defaultWelcomeTemplate,
  hotelSolenneTemplate,
  harborAndLaneTemplate,
  ironcladBuildTemplate,
  graceHillTemplate,
  velocityTemplate,
  studioVerdeTemplate,
  maisonBruleeTemplate,
  anaraWellnessTemplate,
]

// Bomb-defuse: the install template endpoint builds a Zod enum from
// TEMPLATE_SLUGS via `z.enum(TEMPLATE_SLUGS as [string, ...string[]])`.
// If a future refactor tree-shakes SITE_TEMPLATES to empty (or someone
// comments out every import while bisecting), z.enum([]) throws at
// import time and bricks every /api/install/* route during module load.
// Fail loud at import here instead of mysteriously at runtime.
if (SITE_TEMPLATES.length === 0) {
  throw new Error(
    '[siteTemplates] SITE_TEMPLATES is empty — at least one template must be registered.',
  )
}

export const TEMPLATE_SLUGS = SITE_TEMPLATES.map((t) => t.slug)

export function getTemplate(slug: string): SiteTemplate | null {
  return SITE_TEMPLATES.find((t) => t.slug === slug) ?? null
}

export function isValidTemplateSlug(slug: string): boolean {
  return TEMPLATE_SLUGS.includes(slug)
}

export type { SiteTemplate, PageSpec, SectionSpec, ColumnSpec, WidgetSpec } from './types'
