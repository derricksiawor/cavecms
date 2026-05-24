// Chunk J — section templates registry.
//
// Each template is a server-side JSON definition describing a tree of
// blocks (section → columns → widgets). The instantiate endpoint
// (POST /api/cms/templates/instantiate) reads from this registry by
// templateId and recursively inserts the tree in one TX.
//
// Adding a new template = one new file in this directory + one line
// in this registry. The shape is enforced by Zod via the existing
// block-registry (each widget's `data` payload must parse cleanly
// through parseAndSanitize on the server). tests/unit/sectionTemplates.test.ts
// pins the round-trip — a template whose data drifts from its schema
// fails the suite at build time.
//
// Why server-side definitions instead of letting operators upload:
// the V1 ships a curated set so we control the design language; an
// operator-authored "save section as template" UX is Phase 2 and
// needs its own auth + storage story.

import type { BlockKind } from '@/lib/cms/blockMeta'

import { TEMPLATE_HERO_FEATURES_CTA } from './heroFeaturesCta'
import { TEMPLATE_HERO_STATS_TESTIMONIAL } from './heroStatsTestimonial'
import { TEMPLATE_FAQ_ACCORDION } from './faqAccordion'
import { TEMPLATE_PRICING_TABLE } from './pricingTable'
import { TEMPLATE_CONTACT_SECTION } from './contactSection'
import { TEMPLATE_TEAM_GRID } from './teamGrid'
import { TEMPLATE_PROJECT_SHOWCASE } from './projectShowcase'
import { TEMPLATE_QUOTE_WALL } from './quoteWall'

/** Widget leaf — lives under a column. `blockType` MUST be a key of
 *  blockSchemas (enforced at instantiate time via parseAndSanitize). */
export interface WidgetSeed {
  kind: 'widget'
  blockType: string
  /** Widget data payload. Parsed through parseAndSanitize on insert
   *  — anything that fails validation surfaces as 400 on the endpoint
   *  + as a test failure in tests/unit/sectionTemplates.test.ts. */
  data: Record<string, unknown>
  /** Optional widget-level meta (spacing overrides). Sparingly used —
   *  most templates leave it null and rely on the section/column meta
   *  for layout rhythm. */
  meta?: Record<string, unknown>
}

/** Column branch — lives under a section. Holds 0..N widgets. */
export interface ColumnSeed {
  kind: 'column'
  /** Column meta (background, alignment, vertical fill). Container
   *  defaults cover any omitted knob. */
  meta?: Record<string, unknown>
  widgets: WidgetSeed[]
}

/** Section root — top-level template node. The instantiate endpoint
 *  creates exactly ONE section row per SectionSeed, then recurses
 *  into columns + widgets. */
export interface SectionSeed {
  kind: 'section'
  /** Section meta (background, max-width, vertical padding). */
  meta?: Record<string, unknown>
  columns: ColumnSeed[]
}

/** Public-facing template descriptor. Carries the tree + UI metadata
 *  the gallery uses (name, description, preview SVG). */
export interface SectionTemplate {
  /** Stable id used by the gallery's button + by the instantiate
   *  endpoint's body. Lowercase kebab-case. */
  id: string
  /** Display name shown on the gallery card. */
  name: string
  /** One-line description shown under the name. Keep terse (< 80
   *  chars) so the card stays readable. */
  description: string
  /** Public path to the preview schematic SVG. */
  previewImage: string
  /** The tree to instantiate. Each SectionSeed becomes one section
   *  row + its columns + their widgets in one TX. Multi-section
   *  templates are allowed but uncommon — most V1 templates are
   *  one section. */
  blocks: SectionSeed[]
}

/** Per-request blast-radius cap for the instantiate endpoint. A
 *  pathological template that fans out past this is rejected by the
 *  endpoint's pre-flight guard. 200 sits comfortably above today's
 *  largest template (Hero + Features + CTA = 9 blocks) with headroom
 *  for Phase-2 multi-section templates.
 *
 *  Lives here (registry) rather than inside the route handler so the
 *  round-trip test (tests/unit/sectionTemplates.test.ts) can pin
 *  countBlocks(template) ≤ MAX_INSTANTIATE_BLOCKS for every entry. */
export const MAX_INSTANTIATE_BLOCKS = 200

export const ALL_TEMPLATES: ReadonlyArray<SectionTemplate> = Object.freeze([
  TEMPLATE_HERO_FEATURES_CTA,
  TEMPLATE_HERO_STATS_TESTIMONIAL,
  TEMPLATE_FAQ_ACCORDION,
  TEMPLATE_PRICING_TABLE,
  TEMPLATE_CONTACT_SECTION,
  TEMPLATE_TEAM_GRID,
  TEMPLATE_PROJECT_SHOWCASE,
  TEMPLATE_QUOTE_WALL,
])

/** Lookup by id. Returns null when the id is unknown — the endpoint
 *  returns 404 unknown_template_id rather than crashing. */
export function getTemplateById(id: string): SectionTemplate | null {
  return ALL_TEMPLATES.find((t) => t.id === id) ?? null
}

/** Count the total blocks (section + columns + widgets) a template
 *  will instantiate. Used by the gallery card "N blocks" badge. */
export function countBlocks(template: SectionTemplate): number {
  let n = 0
  for (const s of template.blocks) {
    n += 1 // section
    for (const c of s.columns) {
      n += 1 // column
      n += c.widgets.length
    }
  }
  return n
}

/** Asserts every leaf's blockType is registered. Used by the round-
 *  trip test + the endpoint's pre-flight check. Returns the offending
 *  blockType on failure (or null on success). */
export function findUnknownBlockType(
  template: SectionTemplate,
  knownBlockTypes: ReadonlySet<string>,
): string | null {
  for (const s of template.blocks) {
    for (const c of s.columns) {
      for (const w of c.widgets) {
        if (!knownBlockTypes.has(w.blockType)) return w.blockType
      }
    }
  }
  return null
}

// Convenience exports used by tests + the endpoint.
export type SeedNodeKind = BlockKind
