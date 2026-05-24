import 'server-only'
import { z } from 'zod'

// One Zod schema per project section key. parseSectionData is the write
// boundary on PATCH /api/cms/projects/[id]/sections/[sectionId]; the same
// schemas are also used at read-time (lib/cms/parse.ts → parseProjectSectionForRead)
// so a tampered DB cell can't slip past on the public render path.
//
// All ten sections are auto-seeded at project create time with the
// EMPTY_SECTION_DATA payloads below. Every empty payload MUST parse under
// its schema — otherwise hydrateProject crashes on a freshly-created row.
// The unit test in tests/unit/projectSectionRegistry.test.ts pins this
// invariant.

const MediaRef = z.object({
  media_id: z.number().int().positive(),
  alt: z.string().max(320),
})

// Constrains location section's embedded iframe src to Google Maps. The
// renderer drops this URL into <iframe src> verbatim, so a permissive
// validator here is a stored-XSS-via-iframe vector. The prefix is the
// canonical Maps embed share path. Length cap mirrors lib/cms/limits
// TEXT_MAX.url so a 10KB URL can't smuggle past the JSON column.
const MapEmbedUrl = z
  .string()
  .url()
  .max(500)
  .refine(
    (u) => u.startsWith('https://www.google.com/maps/embed?'),
    'must_be_google_maps_embed',
  )

export const sectionSchemas = {
  // banner_image is nullable so the empty seed (no image yet) parses
  // cleanly. The renderer (components/project-sections) treats a null
  // banner_image as "no hero" and falls back to a plain heading.
  hero: z.object({
    status_label: z.string().max(60).optional(),
    banner_image: MediaRef.nullable(),
    summary_richtext: z.string().max(2000).optional(),
  }),
  gallery: z.object({
    categories: z
      .array(
        z.object({
          name: z.string().max(60),
          images: z
            .array(MediaRef.extend({ caption: z.string().max(320).optional() }))
            .max(48),
        }),
      )
      .max(8),
  }),
  floor_plans: z.object({
    unit_types: z
      .array(
        z.object({
          name: z.string().max(60),
          beds: z.number().int().nonnegative(),
          baths: z.number().nonnegative(),
          sqft: z.number().int().positive(),
          image: MediaRef,
          description: z.string().max(800).optional(),
        }),
      )
      .max(20),
  }),
  // Pricing storage trade-off: price_min / price_max / price_currency /
  // handover_eta live inside `project_sections.data` (JSON blob), NOT
  // mirrored on `projects.*` columns. Implication: a future listing-page
  // price filter (e.g. "projects under $2M in East Legon") cannot
  // `WHERE projects.price_min < ?` directly — it would need either
  // `JSON_EXTRACT(project_sections.data, '$.price_min')` (works at our
  // scale, slower at index-scan time) or a generated-column migration
  // mirroring the field. We chose JSON-blob-only because (1) v1 has no
  // price-filter UI, (2) Zod validates every write, (3) one source of
  // truth costs less to maintain than a denormalised mirror.
  pricing: z.object({
    display: z.enum(['range', 'per_unit', 'contact']),
    value_richtext: z.string().max(2000),
    units_total: z.number().int().positive().optional(),
    units_remaining: z.number().int().nonnegative().optional(),
    // FactsStrip + Pricing renderers consume these. Optional so the
    // empty-seed payload above continues to parse, and so 'contact'
    // mode can omit numeric prices entirely. JSON.number on the wire
    // is fine for the small price magnitudes used here (DECIMAL-level
    // precision is not needed for a marketing page); the DB column is
    // still a JSON blob.
    price_min: z.number().nonnegative().finite().optional(),
    price_max: z.number().nonnegative().finite().optional(),
    // ISO 4217 codes are uppercase 3-letter alphabetic. The regex
    // refuses lowercase / digits / punctuation — a permissive string
    // would let an admin land "us$" or "$" which would render as
    // garbage in the FactsStrip.
    price_currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'must_be_iso4217')
      .optional(),
    // Free-text to support "Q3 2027", "Late 2026", "Phase 2: 2028"
    // — a DATE column would force a single milestone date and
    // misrepresent real-estate handover ranges.
    handover_eta: z.string().max(60).optional(),
  }),
  amenities: z.object({
    items: z
      .array(
        z.object({
          icon: z.string().max(60),
          label: z.string().max(120),
        }),
      )
      .max(60),
  }),
  location: z.object({
    map_embed_url: MapEmbedUrl.optional(),
    address: z.string().max(280),
    points_of_interest: z
      .array(
        z.object({
          label: z.string().max(120),
          drive_time_min: z.number().int().nonnegative(),
        }),
      )
      .max(20),
  }),
  brochure: z.object({
    pdf: MediaRef.nullable(),
    gate_message_richtext: z.string().max(2000).optional(),
  }),
  timeline: z.object({
    entries: z
      .array(
        z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must_be_iso_date'),
          title: z.string().max(220),
          body_richtext: z.string().max(2000).optional(),
          photo: MediaRef.optional(),
        }),
      )
      .max(40),
  }),
  testimonials: z.object({
    entries: z
      .array(
        z.object({
          quote: z.string().max(800),
          attribution: z.string().max(120),
          unit_type: z.string().max(60).optional(),
        }),
      )
      .max(20),
  }),
  inquiry: z.object({
    heading: z.string().max(220).optional(),
    body_richtext: z.string().max(2000).optional(),
  }),
} as const

export type SectionKey = keyof typeof sectionSchemas
export type SectionData<K extends SectionKey> = z.infer<typeof sectionSchemas[K]>

// Authoritative section order at create time. The POST handler seeds
// one row per key in this order at position 1000, 2000, 3000... so the
// editor can reorder freely without touching the seed list.
export const SECTION_KEYS: SectionKey[] = Object.keys(
  sectionSchemas,
) as SectionKey[]

export function parseSectionData(key: string, data: unknown) {
  const schema = (sectionSchemas as Record<string, z.ZodTypeAny>)[key]
  if (!schema) throw new Error(`unknown_section_key:${key}`)
  return schema.parse(data)
}

// Minimal-valid payload per key, used as the initial `data` JSON at
// project create-time. Each must pass its own Zod schema —
// tests/unit/projectSectionRegistry.test.ts pins this.
export const EMPTY_SECTION_DATA: {
  [K in SectionKey]: z.input<typeof sectionSchemas[K]>
} = {
  hero: { banner_image: null },
  gallery: { categories: [] },
  floor_plans: { unit_types: [] },
  pricing: { display: 'contact', value_richtext: '' },
  amenities: { items: [] },
  location: { address: '', points_of_interest: [] },
  brochure: { pdf: null },
  timeline: { entries: [] },
  testimonials: { entries: [] },
  inquiry: {},
}
