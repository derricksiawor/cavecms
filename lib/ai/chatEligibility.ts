// Per-block eligibility map for the Page Assistant chatbot.
//
// PR 4 surface. Broader than `inlineEligibility` (PR 3): the inline
// sparkle only edits text fields the operator can also click-to-edit
// inline. The chat assistant can rewrite ANY text-shaped field on any
// registered widget — captions, alt text, gallery item descriptions,
// channel labels, contact-form copy, etc.
//
// What this exports:
//
//   - CHAT_AI_FIELDS_BY_BLOCK — every text/richtext field path on every
//     registered widget, expressed in dot/array notation matching the
//     block-registry Zod shapes.
//
//   - isChatEditableBlockType(blockType) — predicate the inspect_page
//     tool consults when deciding whether to mark a block as "AI can
//     edit this" in the summary it returns to Gemini.
//
//   - summariseBlockText(blockType, data) — pulls a short text excerpt
//     (~80 chars) for the inspect_page outline. Falls back to '' for
//     blocks with no text-shaped fields.
//
// Implementation notes:
//   - The chat's actual editing gate is Zod (parseAndSanitize at propose
//     AND apply time). This map exists to (a) ground inspect_page output
//     and (b) tell Gemini which blocks have copy to touch vs structural
//     blocks (lx_figure with no caption, lx_space, divider, etc).
//   - Same dot-path grammar as inlineEligibility — `items[].title` style
//     across arrays. Indexed access via the same readPath helpers.

import { TEXT_MAX } from '@/lib/cms/limits'

export type ChatFieldKind = 'plain' | 'richtext'

export interface ChatField {
  /** Dot-path with optional `[]` array hop. Same grammar as
   *  inlineEligibility for consistency. */
  path: string
  kind: ChatFieldKind
  maxLength: number
}

// Every text-shaped field on every registered widget. Order within a
// block: primary heading-ish field first, then supporting fields, then
// per-item arrays. Keep one block per generation and alphabetical
// within each generation so a future contributor can grep top-to-
// bottom without surprise.
const FIELDS: Record<string, ChatField[]> = {
  // ── Legacy block widgets ────────────────────────────────────────
  hero: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'subtitle', kind: 'plain', maxLength: TEXT_MAX.short },
    { path: 'image.alt', kind: 'plain', maxLength: TEXT_MAX.short },
    { path: 'cta.text', kind: 'plain', maxLength: TEXT_MAX.ctaText },
  ],
  services_intro: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextShort },
    { path: 'items[].title', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'items[].body', kind: 'plain', maxLength: TEXT_MAX.itemBody },
  ],
  featured_projects: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title },
  ],
  about_history: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextLong },
    { path: 'image.alt', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  cta: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'body', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'cta.text', kind: 'plain', maxLength: TEXT_MAX.ctaText },
  ],
  text: [
    { path: 'heading', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextLong },
  ],
  image: [
    { path: 'image.alt', kind: 'plain', maxLength: TEXT_MAX.short },
    { path: 'caption', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  gallery: [
    { path: 'images[].alt', kind: 'plain', maxLength: TEXT_MAX.short },
    { path: 'images[].caption', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  quote: [
    { path: 'quote', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'attribution', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'attribution_title', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  heading: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.title },
  ],
  button: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.ctaText },
  ],
  icon_box: [
    { path: 'headline', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'body', kind: 'plain', maxLength: TEXT_MAX.body },
  ],
  accordion: [
    { path: 'items[].title', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'items[].body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextShort },
  ],
  icon_list: [
    { path: 'items[].label', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  tabs: [
    { path: 'items[].label', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'items[].body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextShort },
  ],
  alert: [
    { path: 'title', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextShort },
  ],
  star_rating: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  testimonial: [
    { path: 'quote', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'attribution', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'role', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'image.alt', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  video_embed: [
    { path: 'caption', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  stats_row: [
    { path: 'items[].label', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'items[].helper_text', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'items[].prefix', kind: 'plain', maxLength: 8 },
    { path: 'items[].suffix', kind: 'plain', maxLength: 8 },
  ],
  eyebrow: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  channel_card: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'body', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'action.text', kind: 'plain', maxLength: TEXT_MAX.ctaText },
  ],
  contact_form: [
    { path: 'heading', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'intro', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'submit_label', kind: 'plain', maxLength: TEXT_MAX.ctaText },
    { path: 'success_headline', kind: 'plain', maxLength: TEXT_MAX.title },
    { path: 'success_body', kind: 'plain', maxLength: TEXT_MAX.body },
  ],

  // ── lx_* luxury primitives ──────────────────────────────────────
  lx_heading: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.title },
  ],
  lx_text: [
    { path: 'body_richtext', kind: 'richtext', maxLength: TEXT_MAX.richtextLong },
  ],
  lx_eyebrow: [
    { path: 'text', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
  lx_action: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.ctaText },
  ],
  lx_figure: [
    { path: 'caption', kind: 'plain', maxLength: TEXT_MAX.short },
    { path: 'image.alt', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  lx_map: [
    { path: 'caption', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  lx_cover_image: [
    { path: 'image.alt', kind: 'plain', maxLength: TEXT_MAX.short },
  ],
  lx_image_pair: [
    { path: 'leftImage.alt', kind: 'plain', maxLength: TEXT_MAX.short },
    { path: 'rightImage.alt', kind: 'plain', maxLength: TEXT_MAX.short },
  ],

  // ── lx_* composites ─────────────────────────────────────────────
  lx_channel_card: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'value', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'description', kind: 'plain', maxLength: TEXT_MAX.body },
  ],
  lx_stat: [
    { path: 'label', kind: 'plain', maxLength: TEXT_MAX.caption },
    { path: 'prefix', kind: 'plain', maxLength: 8 },
    { path: 'suffix', kind: 'plain', maxLength: 8 },
  ],
  lx_quote: [
    { path: 'quote', kind: 'plain', maxLength: TEXT_MAX.body },
    { path: 'attribution', kind: 'plain', maxLength: TEXT_MAX.caption },
  ],
}

export const CHAT_AI_FIELDS_BY_BLOCK: Readonly<
  Record<string, ReadonlyArray<ChatField>>
> = Object.freeze(FIELDS)

const CHAT_EDITABLE_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(
  Object.keys(FIELDS),
)

/** True when the widget has at least one text-shaped field the chat
 *  assistant can rewrite. Used by inspect_page to mark "has editable
 *  copy" — Gemini's own decision-making about which blocks to edit
 *  uses this signal. Sections + columns + structural-only widgets
 *  (lx_space, divider, spacer, social_icons) return false. */
export function isChatEditableBlockType(blockType: string): boolean {
  return CHAT_EDITABLE_BLOCK_TYPE_SET.has(blockType)
}

export function getChatFieldsForBlock(blockType: string): ReadonlyArray<ChatField> {
  return FIELDS[blockType] ?? []
}

/** Walk a block's data along its first text-shaped field path and
 *  return a short excerpt. Returns '' for blocks with no text or
 *  empty/whitespace values. Used by inspect_page to give Gemini a
 *  60-char preview without shipping the full block payload. */
export function summariseBlockText(
  blockType: string,
  data: unknown,
  maxChars = 80,
): string {
  const fields = getChatFieldsForBlock(blockType)
  if (fields.length === 0 || data === null || typeof data !== 'object') {
    return ''
  }
  for (const field of fields) {
    const value = readFirstStringAtPath(data, field.path)
    if (value && value.trim().length > 0) {
      const cleaned = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (cleaned.length === 0) continue
      if (cleaned.length <= maxChars) return cleaned
      return `${cleaned.slice(0, maxChars - 1)}…`
    }
  }
  return ''
}

/** Read the first string value at a dot-path, expanding `[]` to index 0.
 *  Returns '' on miss. Mirrors inlineEligibility's readPath / resolveField
 *  behaviour but optimised for the single-summary use case (no need to
 *  return every array element). */
function readFirstStringAtPath(data: unknown, path: string): string {
  const segments = path.split('.')
  let cursor: unknown = data
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object') return ''
    if (seg.endsWith('[]')) {
      const key = seg.slice(0, -2)
      const arr = (cursor as Record<string, unknown>)[key]
      if (!Array.isArray(arr) || arr.length === 0) return ''
      cursor = arr[0]
    } else {
      cursor = (cursor as Record<string, unknown>)[seg]
    }
  }
  return typeof cursor === 'string' ? cursor : ''
}
