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

// Deep-freeze every template at module load. The install route's
// `injectMediaRefs` USED to mutate widget.data and strip _imageKeys
// in place, which silently poisoned the registry singleton across
// requests in a long-lived Node process. The fix in the install route
// is to `structuredClone` the template before mutating; the freeze
// here is defence-in-depth so a future contributor who forgets the
// clone gets a loud TypeError at the mutation site instead of a
// quiet 0.1.38-era data-corruption bug. Object.freeze is shallow —
// we walk every nested object so frozen-ness reaches every widget.
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  Object.freeze(obj)
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key])
  }
  return obj
}
for (const t of SITE_TEMPLATES) deepFreeze(t)

export const TEMPLATE_SLUGS = SITE_TEMPLATES.map((t) => t.slug)

export function getTemplate(slug: string): SiteTemplate | null {
  return SITE_TEMPLATES.find((t) => t.slug === slug) ?? null
}

export function isValidTemplateSlug(slug: string): boolean {
  return TEMPLATE_SLUGS.includes(slug)
}

export type { SiteTemplate, PageSpec, SectionSpec, ColumnSpec, WidgetSpec } from './types'
