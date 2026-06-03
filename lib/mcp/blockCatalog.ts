import 'server-only'
import {
  SEED_ENTRIES,
  SEED_DATA,
  CATEGORY_BY_TYPE,
  BLOCK_CATEGORIES,
  type SeedBlockType,
} from '@/lib/cms/blockSeeds'

// describe_block_types reuses the SAME palette the admin widget-picker reads
// (lib/cms/blockSeeds.ts) so an agent sees exactly the block vocabulary an
// operator sees — labels, descriptions, categories, and a CONCRETE example of
// each block's `data` JSON (the per-entry override, else the type default).
//
// We deliberately project from the curated palette rather than reflecting the
// Zod schemas to JSON Schema: (a) blockSchemas are built with the v3 `z` import
// and `z.toJSONSchema` is v4-only (cross-version projection is unsupported), and
// (b) a worked example + label + description is a better authoring affordance
// for an LLM than a raw JSON-Schema dump. The Zod schema still governs writes —
// parseAndSanitize rejects anything malformed at the save boundary.

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  BLOCK_CATEGORIES.map((c) => [c.key, c.label]),
)

export interface BlockTypeDoc {
  type: string
  label: string
  description: string
  category: string
  categoryLabel: string
  /** A ready-to-use `data` payload for this block — fill/edit, then pass as the
   *  `data` of a create op or update_block. Mirrors what the picker seeds. */
  exampleData: Record<string, unknown>
}

export function getBlockTypeCatalog(): BlockTypeDoc[] {
  return SEED_ENTRIES.map((entry) => {
    const category = CATEGORY_BY_TYPE[entry.type]
    return {
      type: entry.type,
      label: entry.label,
      description: entry.description,
      category,
      categoryLabel: CATEGORY_LABEL[category] ?? category,
      // Per-entry override (e.g. Counter vs Stats Row share stats_row) wins,
      // else the canonical per-type default. Both are plain JSON.
      exampleData:
        entry.data ?? SEED_DATA[entry.type as SeedBlockType] ?? {},
    }
  })
}

export interface BlockCategoryDoc {
  key: string
  label: string
}

export function getBlockCategories(): BlockCategoryDoc[] {
  return BLOCK_CATEGORIES.map((c) => ({ key: c.key, label: c.label }))
}
