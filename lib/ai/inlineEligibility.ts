// Per-block eligibility map for inline AI sparkle.
//
// The sparkle button is purely a text-editing affordance — it asks
// Gemini to rewrite, translate, suggest, or fill in the WORDS inside a
// block. It is not a structural tool (drag handles + the chatbot in PR
// 4 handle layout). So a block is sparkle-eligible only when its Zod
// schema carries one or more text/richtext fields the operator can
// edit through the inline editor.
//
// What this module exports:
//
//   - INLINE_AI_BLOCK_TYPES — the canonical allow-list. The sparkle
//     button reads this at render time AND the SSE endpoint at
//     /api/ai/stream re-validates against it. Two-layer gate — the
//     client can't bypass eligibility by hand-crafting a request.
//
//   - INLINE_AI_FIELDS_BY_BLOCK — per-block, the list of editable
//     text fields with dot-paths, max-lengths, and `primary` flag.
//     The runtime walks block.data along these paths to collect
//     current values for the AI prompt, and merges Gemini's response
//     back along the same paths before re-validation.
//
//   - getInlineFieldsForBlock(blockType) — convenience accessor.
//
//   - resolveFieldValues(blockType, data) — walks the data tree and
//     returns the current operator-facing text for every eligible
//     field (handles array indices for accordion/tabs/stats etc).
//
//   - mergeFieldValues(blockType, data, updates) — opposite of
//     resolveFieldValues. Applies Gemini's rewrites onto a copy of
//     the data tree without mutating the original.
//
//   - countEmptyFields(blockType, data) — for the "Fill in" tab
//     suggestion gate. A block is considered "mostly empty" when at
//     least one of its primary text fields is empty/whitespace OR
//     the eligible-field count > 0 and ALL of them are blank.
//
// Why a manual map vs Zod introspection: Zod introspection would
// require walking ZodObject internals (._def.shape, ._def.type,
// .unwrap() through optionals/effects/refines), which is brittle
// across Zod versions and would still need a hand-curated decision
// for which paths the operator actually edits (e.g. `level` is a Zod
// enum but is layout chrome, not text the AI should touch). One
// declarative table is clearer, faster to audit, and gives the
// runtime the dot-path it needs anyway.

import { TEXT_MAX } from '@/lib/cms/limits'

export type InlineAiFieldKind = 'plain' | 'richtext'

export interface InlineAiField {
  /** Dot-path with array notation. Examples:
   *    - 'text'            top-level scalar
   *    - 'cta.text'        nested scalar
   *    - 'items[].title'   per-item scalar across an array */
  path: string
  kind: InlineAiFieldKind
  maxLength: number
  /** True for the single primary headline-ish field that drives the
   *  Suggest tab. At most ONE per block. Blocks with no primary
   *  scalar (accordion, tabs, stats_row — item-only) have none, so
   *  Suggest is not offered for them. */
  primary?: boolean
}

// Concrete entries per block type. Keep alphabetical inside each
// generation (legacy block widgets first, then lx_* primitives,
// then lx_* composites) so a future contributor can scan top-to-
// bottom without surprise.
//
// IMPORTANT: every path here must exist on the block's Zod schema
// in lib/cms/block-registry.ts. A drift between the two surfaces is
// caught by tests/unit/ai/inlineEligibility.test.ts which iterates
// every entry and probes the schema with the seed data.
const FIELDS: Record<string, InlineAiField[]> = {
  // ── Fixed-slot widget ───────────────────────────────────────────
  contact_form: [
    { path: 'heading', kind: 'plain', maxLength: TEXT_MAX.title, primary: true },
    { path: 'intro', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'submit_label', kind: 'plain', maxLength: TEXT_MAX.ctaText },
    { path: 'success_headline', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'success_body', kind: 'plain', maxLength: TEXT_MAX.body },
  ],

  // ── lx_* luxury primitives ──────────────────────────────────────
  lx_heading: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.title, primary: true },
  ],
  lx_text: [
    { path: 'body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextLong, primary: true },
  ],
  lx_eyebrow: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.caption, primary: true },
  ],
  lx_action: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.ctaText, primary: true },
  ],
  lx_figure: [
    { path: 'caption', kind: 'plain', maxLength: TEXT_MAX.short, primary: true },
  ],
  lx_cover_image: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title, primary: true },
    { path: 'eyebrow', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'body', kind: 'plain', maxLength: TEXT_MAX.body },
  ],

  // ── lx_* composites ─────────────────────────────────────────────
  lx_channel_card: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.caption, primary: true },
    { path: 'value', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'description', kind: 'plain', maxLength: TEXT_MAX.body },
  ],
  lx_stat: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.caption, primary: true },
    { path: 'prefix', kind: 'plain', maxLength: 8 },
    { path: 'suffix', kind: 'plain', maxLength: 8 },
  ],
  lx_quote: [
    { path: 'quote', kind: 'plain', maxLength: TEXT_MAX.body, primary: true },
    { path: 'attribution', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  lx_testimonial: [
    { path: 'quote', kind: 'plain', maxLength: TEXT_MAX.body, primary: true },
    { path: 'attribution', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'attribution_title', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  lx_video: [
    { path: 'caption', kind: 'plain', maxLength: TEXT_MAX.short, primary: true },
  ],
  lx_accordion: [
    { path: 'items[].title', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'items[].body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextShort },
  ],
  lx_tabs: [
    { path: 'tabs[].label', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'tabs[].body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextShort },
  ],
  lx_icon_list: [
    { path: 'items[].headline', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'items[].body', kind: 'plain', maxLength: TEXT_MAX.body },
  ],
  lx_icon_box: [
    { path: 'headline', kind: 'plain', maxLength: TEXT_MAX.title, primary: true },
    { path: 'body', kind: 'plain', maxLength: TEXT_MAX.body },
  ],
  lx_cta_banner: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title, primary: true },
    { path: 'eyebrow', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'body', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'primaryCta.label', kind: 'plain', maxLength: TEXT_MAX.ctaText },
    { path: 'secondaryCta.label', kind: 'plain', maxLength: TEXT_MAX.ctaText },
  ],
}

export const INLINE_AI_FIELDS_BY_BLOCK: Readonly<Record<string, ReadonlyArray<InlineAiField>>> =
  Object.freeze(FIELDS)

export const INLINE_AI_BLOCK_TYPES: readonly string[] = Object.freeze(
  Object.keys(FIELDS).sort(),
)

const INLINE_AI_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(INLINE_AI_BLOCK_TYPES)

/** Eligibility predicate — the sparkle button gate. False for sections,
 *  columns, and any widget whose schema has no editable text. */
export function isInlineAiEligible(blockType: string): boolean {
  return INLINE_AI_BLOCK_TYPE_SET.has(blockType)
}

export function getInlineFieldsForBlock(blockType: string): ReadonlyArray<InlineAiField> {
  return FIELDS[blockType] ?? []
}

/** True when the block exposes exactly one primary scalar of short
 *  enough length for the Suggest tab. Limits Suggest to blocks where
 *  3 alternative single-line proposals are sensible. Long-form
 *  primary fields (lx_text body_richtext, text body_richtext) are
 *  excluded — Suggest's "3 cards side-by-side" UX would be unreadable. */
export function supportsSuggest(blockType: string): boolean {
  const fields = getInlineFieldsForBlock(blockType)
  const primary = fields.find((f) => f.primary)
  if (!primary) return false
  if (primary.kind !== 'plain') return false
  // Suggest cards render the 3 options side-by-side. Anything past
  // body-length (TEXT_MAX.body = 800) is too long for the 3-up
  // layout to read clearly.
  return primary.maxLength <= TEXT_MAX.body
}

/** Read the current text value at the dot-path. Returns '' for missing
 *  or non-string values so callers don't need null-checks. */
function readPath(data: unknown, segments: string[]): string {
  let cursor: unknown = data
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object') return ''
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return typeof cursor === 'string' ? cursor : ''
}

/** Resolve every field's current value, expanding `items[].x` into
 *  one entry per live array index. The expanded path uses '[N]'
 *  notation (e.g. 'items[0].title') so the runtime can address each
 *  array element distinctly when merging Gemini's response back. */
export interface ResolvedField {
  /** Path with concrete numeric indices substituted for `[]`. */
  path: string
  kind: InlineAiFieldKind
  maxLength: number
  primary: boolean
  value: string
}

export function resolveFieldValues(
  blockType: string,
  data: unknown,
): ResolvedField[] {
  const out: ResolvedField[] = []
  if (data === null || typeof data !== 'object') return out
  for (const field of getInlineFieldsForBlock(blockType)) {
    const segments = field.path.split('.')
    // Find the segment(s) with [] notation. Today we only support a
    // single array hop (items[].x); a future block with nested arrays
    // would need a recursive walker. Asserted by tests.
    const arrayIdx = segments.findIndex((s) => s.endsWith('[]'))
    if (arrayIdx === -1) {
      out.push({
        path: field.path,
        kind: field.kind,
        maxLength: field.maxLength,
        primary: field.primary === true,
        value: readPath(data, segments),
      })
      continue
    }
    const arrayKey = segments[arrayIdx]!.slice(0, -2) // strip '[]'
    const prefixSegments = segments.slice(0, arrayIdx)
    const suffixSegments = segments.slice(arrayIdx + 1)
    let prefixCursor: unknown = data
    for (const seg of prefixSegments) {
      if (prefixCursor === null || typeof prefixCursor !== 'object') {
        prefixCursor = null
        break
      }
      prefixCursor = (prefixCursor as Record<string, unknown>)[seg]
    }
    if (prefixCursor === null || typeof prefixCursor !== 'object') continue
    const arr = (prefixCursor as Record<string, unknown>)[arrayKey]
    if (!Array.isArray(arr)) continue
    for (let i = 0; i < arr.length; i++) {
      const concretePath = [
        ...prefixSegments,
        `${arrayKey}[${i}]`,
        ...suffixSegments,
      ].join('.')
      const value = readPath(arr[i], suffixSegments)
      out.push({
        path: concretePath,
        kind: field.kind,
        maxLength: field.maxLength,
        primary: field.primary === true,
        value,
      })
    }
  }
  return out
}

/** Apply a {path → newValue} map onto a deep clone of `data`. Returns
 *  the new shape; the input is never mutated. Unknown paths are
 *  silently skipped — the caller's re-validation through
 *  parseAndSanitize is the safety net. */
export function mergeFieldValues(
  data: unknown,
  updates: Record<string, string>,
): unknown {
  if (data === null || typeof data !== 'object') return data
  // Cheap deep clone — payloads are JSON-shaped by contract (Zod-parsed
  // upstream). structuredClone is global since Node 17.
  const next = structuredClone(data) as Record<string, unknown>
  for (const [rawPath, value] of Object.entries(updates)) {
    if (typeof value !== 'string') continue
    if (rawPath === '__proto__' || rawPath === 'constructor' || rawPath === 'prototype') {
      continue
    }
    setByPath(next, rawPath, value)
  }
  return next
}

/** Internal — write `value` at the parsed path. Path segments may be
 *  either plain keys ('cta') or array-indexed ('items[3]'). Refuses to
 *  create intermediate containers; if the destination doesn't exist on
 *  the source the write is dropped (Gemini hallucinated a path that
 *  isn't on the block — fail closed). */
function setByPath(root: Record<string, unknown>, path: string, value: string): void {
  const segments = path.split('.')
  let cursor: unknown = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!
    cursor = stepInto(cursor, seg)
    if (cursor === null || typeof cursor !== 'object') return
  }
  const last = segments[segments.length - 1]!
  writeLeaf(cursor, last, value)
}

function stepInto(cursor: unknown, segment: string): unknown {
  if (cursor === null || typeof cursor !== 'object') return null
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]$/.exec(segment)
  if (m) {
    const [, key, idxStr] = m
    if (!key || idxStr === undefined) return null
    const arr = (cursor as Record<string, unknown>)[key]
    if (!Array.isArray(arr)) return null
    const idx = Number(idxStr)
    if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) return null
    return arr[idx]
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment)) return null
  return (cursor as Record<string, unknown>)[segment]
}

function writeLeaf(cursor: unknown, segment: string, value: string): void {
  if (cursor === null || typeof cursor !== 'object') return
  const m = /^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]$/.exec(segment)
  if (m) {
    const [, key, idxStr] = m
    if (!key || idxStr === undefined) return
    const arr = (cursor as Record<string, unknown>)[key]
    if (!Array.isArray(arr)) return
    const idx = Number(idxStr)
    if (!Number.isInteger(idx) || idx < 0 || idx >= arr.length) return
    arr[idx] = value
    return
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment)) return
  ;(cursor as Record<string, unknown>)[segment] = value
}

/** Count text fields whose current value is empty/whitespace. Used by
 *  the popover to decide whether to surface the "Fill in" tab as the
 *  default for a fresh-empty block. */
export function countEmptyFields(blockType: string, data: unknown): number {
  const resolved = resolveFieldValues(blockType, data)
  let empty = 0
  for (const f of resolved) {
    if (f.value.trim().length === 0) empty++
  }
  return empty
}

/** True when ALL primary fields are empty OR the block has only one
 *  primary field and it's empty. Drives the "Fill in" tab's default-
 *  selected state on first open. */
export function isMostlyEmpty(blockType: string, data: unknown): boolean {
  const resolved = resolveFieldValues(blockType, data)
  if (resolved.length === 0) return false
  const primaries = resolved.filter((r) => r.primary)
  if (primaries.length === 0) {
    // Item-only blocks (accordion, tabs, stats_row) — "mostly empty"
    // means EVERY resolved item field is blank.
    return resolved.every((r) => r.value.trim().length === 0)
  }
  return primaries.every((r) => r.value.trim().length === 0)
}
