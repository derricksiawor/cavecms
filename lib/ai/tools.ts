import 'server-only'
import { z } from 'zod'

// Gemini function-declaration surface for the Page Assistant chatbot
// (PR 4). SIX tools total — every one a PROPOSER, none of them write
// to the database. Each tool's payload is validated at propose time
// AND re-validated at apply time (defense in depth, plus saveBlock
// runs parseAndSanitize again at the write boundary — three passes).
//
// Tool surface scope is STRUCTURAL, not prompted. The AI literally has
// no other functions: nothing for settings, users, security, themes,
// integrations, code, env, audit log, media synthesis, or any block
// on any page other than the current one. The route + runTool enforce
// scope at every call boundary.
//
// SDK shape: @google/genai accepts a `functionDeclarations` array on
// the `tools` config. Each declaration is { name, description,
// parameters } where parameters follows their Schema subset (JSON
// Schema-ish; supports type/properties/required/items/minItems/
// maxItems but not oneOf/anyOf — see the inline route's
// buildIntent schema notes for the same constraint).

export const TOOL_NAMES = [
  'inspect_page',
  'inspect_block',
  'propose_block_edit',
  'propose_block_insert',
  'propose_block_delete',
  'propose_block_reorder',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(s: string): s is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(s)
}

// Gemini-flavoured JSON Schema. Keep this minimal — the underlying SDK
// is forgiving on extra fields, but a tighter shape catches typos at
// build time.
export interface GeminiToolSchema {
  type: 'object' | 'string' | 'array' | 'integer' | 'number' | 'boolean'
  description?: string
  properties?: Record<string, GeminiToolSchema>
  required?: string[]
  items?: GeminiToolSchema
  minimum?: number
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
}

export interface GeminiFunctionDeclaration {
  name: ToolName
  description: string
  parameters: GeminiToolSchema
}

/** The six tool declarations handed to Gemini at chat-session creation.
 *  Order matters only for human readability — the model can call any
 *  of them in any sequence (and most turns start with `inspect_page`).
 */
export const TOOL_DECLARATIONS: ReadonlyArray<GeminiFunctionDeclaration> = [
  {
    name: 'inspect_page',
    description:
      'Read the current page outline. Returns every block on this page as ' +
      '{id, blockType, kind, parentId, position, label, summary, hasEditableText} ' +
      'where summary is a short text excerpt for widgets. Use this once at the ' +
      'start of every turn to ground your understanding. No side effects.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'inspect_block',
    description:
      'Read one block on this page in full. Returns the block data exactly as ' +
      'stored. Use when inspect_page summary is not enough and you need the ' +
      'precise field values before proposing an edit. No side effects.',
    parameters: {
      type: 'object',
      properties: {
        blockId: { type: 'integer', minimum: 1 },
      },
      required: ['blockId'],
    },
  },
  {
    name: 'propose_block_edit',
    description:
      "Propose an edit to a widget on this page. newData must be the COMPLETE " +
      "replacement for the block's data object — not a partial patch. Server " +
      'validates with the registered Zod schema + DOMPurify. On validation ' +
      'failure you receive a structured error so you can correct and retry. ' +
      'Only widgets are editable. The proposal is appended to the in-flight ' +
      "changeset; the database is NOT touched until the operator clicks Apply.",
    parameters: {
      type: 'object',
      properties: {
        blockId: { type: 'integer', minimum: 1 },
        newData: { type: 'object' },
      },
      required: ['blockId', 'newData'],
    },
  },
  {
    name: 'propose_block_insert',
    description:
      'Propose inserting a new widget into a column on this page. ' +
      'parentColumnId must be a column block on this page. Provide either ' +
      'afterBlockId (insert after this sibling) OR beforeBlockId (insert ' +
      'before this sibling) OR neither (append to the column tail). blockType ' +
      'must be a registered widget type. data is the new widget data, ' +
      'validated against the registered schema. The proposal is appended to ' +
      'the in-flight changeset; the database is NOT touched until the ' +
      'operator clicks Apply.',
    parameters: {
      type: 'object',
      properties: {
        parentColumnId: { type: 'integer', minimum: 1 },
        afterBlockId: { type: 'integer', minimum: 1 },
        beforeBlockId: { type: 'integer', minimum: 1 },
        blockType: { type: 'string', minLength: 1, maxLength: 50 },
        data: { type: 'object' },
      },
      required: ['parentColumnId', 'blockType', 'data'],
    },
  },
  {
    name: 'propose_block_delete',
    description:
      'Propose soft-deleting a widget on this page. Refuses fixed-slot ' +
      'blocks (e.g., the contact form on /contact). Refuses sections and ' +
      'columns — only widgets can be deleted via this tool. The proposal is ' +
      'appended to the in-flight changeset; the database is NOT touched until ' +
      'the operator clicks Apply.',
    parameters: {
      type: 'object',
      properties: {
        blockId: { type: 'integer', minimum: 1 },
      },
      required: ['blockId'],
    },
  },
  {
    name: 'propose_block_reorder',
    description:
      'Propose reordering widgets on this page. moves is an array of ' +
      '{blockId, parentColumnId, position}. Every blockId must be a widget ' +
      'on this page; every parentColumnId must be a column on this page. ' +
      'position is the target index within the destination column (0-based). ' +
      'Use this to move a widget to a different column or shift its order. ' +
      'The proposal is appended to the in-flight changeset; the database is ' +
      'NOT touched until the operator clicks Apply.',
    parameters: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              blockId: { type: 'integer', minimum: 1 },
              parentColumnId: { type: 'integer', minimum: 1 },
              position: { type: 'integer', minimum: 0 },
            },
            required: ['blockId', 'parentColumnId', 'position'],
          },
        },
      },
      required: ['moves'],
    },
  },
]

// ── Server-side Zod gates ──────────────────────────────────────────
// Defense in depth: Gemini's parameter-schema validation is best-effort;
// we re-validate every tool call's arguments via Zod before any work.
// Cross-page scope check + parseAndSanitize live in runTool.ts.

export const InspectPageInputSchema = z.object({}).strict()

export const InspectBlockInputSchema = z
  .object({
    blockId: z.number().int().positive(),
  })
  .strict()

export const ProposeBlockEditInputSchema = z
  .object({
    blockId: z.number().int().positive(),
    newData: z.record(z.unknown()),
  })
  .strict()

export const ProposeBlockInsertInputSchema = z
  .object({
    parentColumnId: z.number().int().positive(),
    afterBlockId: z.number().int().positive().optional(),
    beforeBlockId: z.number().int().positive().optional(),
    blockType: z.string().min(1).max(50),
    data: z.record(z.unknown()),
  })
  .strict()
  .refine(
    (d) => !(d.afterBlockId !== undefined && d.beforeBlockId !== undefined),
    { message: 'after_and_before_mutually_exclusive' },
  )

export const ProposeBlockDeleteInputSchema = z
  .object({
    blockId: z.number().int().positive(),
  })
  .strict()

export const ProposeBlockReorderInputSchema = z
  .object({
    moves: z
      .array(
        z
          .object({
            blockId: z.number().int().positive(),
            parentColumnId: z.number().int().positive(),
            position: z.number().int().min(0).max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()

export type InspectPageInput = z.infer<typeof InspectPageInputSchema>
export type InspectBlockInput = z.infer<typeof InspectBlockInputSchema>
export type ProposeBlockEditInput = z.infer<typeof ProposeBlockEditInputSchema>
export type ProposeBlockInsertInput = z.infer<
  typeof ProposeBlockInsertInputSchema
>
export type ProposeBlockDeleteInput = z.infer<
  typeof ProposeBlockDeleteInputSchema
>
export type ProposeBlockReorderInput = z.infer<
  typeof ProposeBlockReorderInputSchema
>

// ── Chat changeset op types ────────────────────────────────────────
// The orchestrator accumulates these in memory. On the SSE `done`
// event they ride to the client (so the proposal-tray UI can render
// the diff) AND get persisted into ai_proposals.changeset (so apply
// can re-run them).

export type ChatChangesetOp =
  | {
      op: 'edit'
      blockId: number
      blockType: string
      data: unknown
      expectedBlockVersion: number
    }
  | {
      op: 'insert'
      parentColumnId: number
      afterBlockId?: number
      beforeBlockId?: number
      blockType: string
      data: unknown
    }
  | {
      op: 'delete'
      blockId: number
      blockType: string
      expectedBlockVersion: number
    }
  | {
      op: 'reorder'
      moves: Array<{
        blockId: number
        parentColumnId: number
        position: number
        /** Snapshot of the moved block's `version` at propose time.
         *  Apply-time `applyChatReorderOp` asserts each row's current
         *  version matches; mismatch → 409 stale_block_version so
         *  the operator's reorder doesn't silently overwrite a
         *  concurrent edit's position bump. */
        expectedBlockVersion: number
      }>
    }

/** Cap on the chat changeset size. Aligned with the apply route's
 *  AcceptIndices cap (32) so the per-op loop stays bounded even on
 *  the largest legitimate multi-step turn. The per-turn tool-call
 *  budget (MAX_TOOL_CALLS_PER_TURN in runChatProposal.ts) is lower
 *  (8) which means a single turn cannot fill the changeset — that is
 *  the INTENDED design: ops persist across turns inside the same
 *  conversation only via apply, never via accumulated proposals.
 *  A multi-turn conversation that produces ≥32 ops would split into
 *  separate proposals (one per turn), each capped at the tool-call
 *  budget. */
export const MAX_CHAT_CHANGESET_OPS = 32
