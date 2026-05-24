import { z } from 'zod'

// Shared schemas + types for the per-user "Saved blocks / My library"
// feature. Imported by both the server route handlers (validation at
// the wire boundary) and the client SavedBlocksPanel (TS types for the
// fetched payload).
//
// Name validation mirrors LabelSchema in lib/cms/blockMeta.ts — strip
// control bytes + collapse interior whitespace BEFORE the length cap so
// a paste from Notion / Word with smuggled U+2028 separators or zero-
// width joiners doesn't bypass the 64-char limit. Built with the RegExp
// constructor + \u escapes so this source file stays free of literal
// control bytes (which corrupt diff tools and CR/LF detection).

// Same character class as LABEL_CONTROL_RE in blockMeta.ts. Duplicated
// here (not imported) because blockMeta.ts is server-only-friendly via
// transient deps and this module is shared with the client.
const SAVED_BLOCK_NAME_CONTROL_RE = new RegExp(
  '[\\u0000-\\u001F\\u007F\\u2028\\u2029\\u200B-\\u200D\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
)

export function sanitizeSavedBlockName(input: string): string {
  return input
    .replace(SAVED_BLOCK_NAME_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Sanitise FIRST then cap at 64 (post-sanitise length) so a 70-char
// raw input that sanitises to ≤64 still passes. Matches LabelSchema.
export const SavedBlockNameSchema = z
  .string()
  .transform(sanitizeSavedBlockName)
  .pipe(z.string().min(1, 'required').max(64))

// Create request body. blockType is bounded against blockSchemas at
// the route layer (not in the Zod gate) so the rejection code can be
// the specific `unknown_block_type` rather than a generic zod failure.
export const SavedBlockCreateBody = z
  .object({
    name: z.string(), // narrowed via SavedBlockNameSchema in the handler
    blockType: z.string().min(1).max(50),
    data: z.unknown(),
    meta: z.unknown().optional(),
  })
  .strict()

// Instantiate request body. parentId nullable matches POST
// /api/cms/blocks's contract (NULL = top-level, numeric = under a
// column). afterBlockId / beforeBlockId are mutually exclusive and
// the route layer rejects both-set with 400.
export const SavedBlockInstantiateBody = z
  .object({
    pageId: z.number().int().positive(),
    parentId: z.number().int().positive().nullable().optional(),
    afterBlockId: z.number().int().positive().optional(),
    beforeBlockId: z.number().int().positive().optional(),
  })
  .strict()

// Client-side type for the list endpoint response. The server returns
// each row's id + name + blockType + timestamps — NOT the data/meta
// payload (those land via GET /[id] when the operator clicks the
// card). Keeps the list response small and avoids leaking widget
// payloads through the panel's initial fetch.
export interface SavedBlockListItem {
  id: number
  name: string
  blockType: string
  createdAt: string
  updatedAt: string
}

// Client-side type for the single-fetch endpoint response (panel
// click → fetch payload → insert).
export interface SavedBlockDetail {
  id: number
  name: string
  blockType: string
  data: unknown
  meta: unknown
  createdAt: string
}

// Hard cap on rows returned from the list endpoint. Defends the
// operator's browser against runaway list-rendering if a user racks up
// thousands of saved blocks (DOM blow-up + slow filter). When a user
// hits the cap the panel surfaces a banner telling them to delete old
// items.
export const SAVED_BLOCKS_LIST_LIMIT = 200
