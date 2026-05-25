import 'server-only'

import { parseAndSanitize } from '@/lib/cms/parse'
import { blockSchemas } from '@/lib/cms/block-registry'
import { isChatEditableBlockType, summariseBlockText } from './chatEligibility'
import {
  InspectBlockInputSchema,
  InspectPageInputSchema,
  MAX_CHAT_CHANGESET_OPS,
  ProposeBlockDeleteInputSchema,
  ProposeBlockEditInputSchema,
  ProposeBlockInsertInputSchema,
  ProposeBlockReorderInputSchema,
  type ChatChangesetOp,
  type ToolName,
} from './tools'

// Server-side tool runner for the Page Assistant chatbot (PR 4).
//
// Every Gemini function-call comes through here. The runner:
//   1. Validates argument shape via the tool's Zod schema.
//   2. Enforces page-scope: every referenced block / parent / move
//      target MUST belong to the in-flight session's pageId.
//   3. For mutating tools, runs parseAndSanitize on the candidate
//      data — the same write boundary the manual editor uses.
//   4. Appends the validated op to the session's in-memory changeset.
//   5. Returns a small structured payload to Gemini so the model can
//      chain the next decision (`{ ok: true, opIndex, summary }`) or
//      correct on a validation error (`{ ok: false, error, ... }`).
//
// Tools are PROPOSERS, never writers. The DB write happens at apply
// time inside applyChatProposalByToken, which re-runs every gate
// defense-in-depth.

// ── Session shape ──────────────────────────────────────────────────
// The orchestrator builds one of these at the start of each turn and
// hands it (plus the raw tool call) to executeToolCall. The session
// holds:
//   - the pageId (scope key)
//   - the read-only outline of the page's blocks (id + metadata) —
//     consulted on every scope check
//   - the in-flight changeset (mutating — runTool pushes here)
//   - the count of tool calls in this turn (orchestrator caps the loop)
//
// The session object is GC'd when runChatProposal returns; it never
// crosses turn boundaries.

export type BlockKind = 'section' | 'column' | 'widget'

export interface ChatBlockOutlineEntry {
  id: number
  blockType: string
  kind: BlockKind
  parentId: number | null
  position: number
  blockKey: string | null
  version: number
  /** Parsed data. Section/column rows hold {} placeholder per the
   *  content_blocks contract. */
  data: unknown
}

export interface ChatSessionContext {
  pageId: number
  blocks: ReadonlyArray<ChatBlockOutlineEntry>
  // Mutable: runTool pushes new ops here.
  changeset: ChatChangesetOp[]
}

// ── Tool-call result envelope ──────────────────────────────────────
// What we hand back to Gemini as a functionResponse. The shape is
// deliberately small + JSON-clean so the SDK forwards it intact.

export interface ToolSuccessResult {
  ok: true
  /** Index of the newly-appended op in session.changeset. Helpful for
   *  Gemini to refer back ("I'll undo op 2") without keeping its own
   *  cursor. Undefined for read-only tools. */
  opIndex?: number
  summary?: string
  /** Read-only tools attach their payload here. */
  data?: unknown
}

export interface ToolErrorResult {
  ok: false
  error: string
  /** Optional structured detail — keyed by problem field where useful. */
  detail?: Record<string, unknown>
}

export type ToolCallResult = ToolSuccessResult | ToolErrorResult

// ── Public entry point ─────────────────────────────────────────────

export async function executeToolCall(
  toolName: string,
  rawInput: unknown,
  session: ChatSessionContext,
): Promise<ToolCallResult> {
  switch (toolName) {
    case 'inspect_page':
      return runInspectPage(rawInput, session)
    case 'inspect_block':
      return runInspectBlock(rawInput, session)
    case 'propose_block_edit':
      return runProposeBlockEdit(rawInput, session)
    case 'propose_block_insert':
      return runProposeBlockInsert(rawInput, session)
    case 'propose_block_delete':
      return runProposeBlockDelete(rawInput, session)
    case 'propose_block_reorder':
      return runProposeBlockReorder(rawInput, session)
    default:
      return {
        ok: false,
        error: 'unknown_tool',
        detail: { toolName },
      }
  }
}

// ── Tool name -> handler dispatch table for tests + introspection. ──
export const TOOL_HANDLERS: ReadonlyArray<ToolName> = [
  'inspect_page',
  'inspect_block',
  'propose_block_edit',
  'propose_block_insert',
  'propose_block_delete',
  'propose_block_reorder',
]

// ── inspect_page ───────────────────────────────────────────────────

interface InspectPageBlockEntry {
  id: number
  blockType: string
  kind: BlockKind
  parentId: number | null
  position: number
  label: string
  summary: string
  hasEditableText: boolean
  isFixedSlot: boolean
}

function runInspectPage(
  rawInput: unknown,
  session: ChatSessionContext,
): ToolCallResult {
  const parsed = InspectPageInputSchema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_arguments',
      detail: { issues: zodIssues(parsed.error) },
    }
  }
  const blocks: InspectPageBlockEntry[] = session.blocks.map((b) => ({
    id: b.id,
    blockType: b.blockType,
    kind: b.kind,
    parentId: b.parentId,
    position: b.position,
    label: labelForBlock(b),
    summary: b.kind === 'widget' ? summariseBlockText(b.blockType, b.data) : '',
    hasEditableText:
      b.kind === 'widget' && isChatEditableBlockType(b.blockType),
    isFixedSlot: b.blockKey !== null,
  }))
  return {
    ok: true,
    data: { pageId: session.pageId, blocks },
    summary: `Inspected page ${session.pageId}: ${blocks.length} block(s).`,
  }
}

function labelForBlock(b: ChatBlockOutlineEntry): string {
  if (b.kind === 'section') return 'Section'
  if (b.kind === 'column') return 'Column'
  return b.blockType
}

// ── inspect_block ──────────────────────────────────────────────────

function runInspectBlock(
  rawInput: unknown,
  session: ChatSessionContext,
): ToolCallResult {
  const parsed = InspectBlockInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_arguments',
      detail: { issues: zodIssues(parsed.error) },
    }
  }
  const { blockId } = parsed.data
  const block = session.blocks.find((b) => b.id === blockId)
  if (!block) {
    return { ok: false, error: 'block_not_on_page' }
  }
  return {
    ok: true,
    data: {
      id: block.id,
      blockType: block.blockType,
      kind: block.kind,
      parentId: block.parentId,
      position: block.position,
      isFixedSlot: block.blockKey !== null,
      data: block.data,
    },
    summary: `Read ${block.kind} ${block.blockType} (block ${block.id}).`,
  }
}

// ── propose_block_edit ─────────────────────────────────────────────

function runProposeBlockEdit(
  rawInput: unknown,
  session: ChatSessionContext,
): ToolCallResult {
  const parsed = ProposeBlockEditInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_arguments',
      detail: { issues: zodIssues(parsed.error) },
    }
  }
  const { blockId, newData } = parsed.data
  const block = session.blocks.find((b) => b.id === blockId)
  if (!block) {
    return { ok: false, error: 'block_not_on_page' }
  }
  if (block.kind !== 'widget') {
    return { ok: false, error: 'cannot_edit_container' }
  }
  if (!(block.blockType in blockSchemas)) {
    return { ok: false, error: 'unknown_block_type' }
  }
  let validated: unknown
  try {
    validated = parseAndSanitize(block.blockType, newData)
  } catch (err) {
    return {
      ok: false,
      error: 'validation_failed',
      detail: validationErrorDetail(err),
    }
  }
  // PR 4 audit (CRITICAL): multiple ops on the same blockId in one
  // changeset would both carry the SAME `expectedBlockVersion` (the
  // hydrate-time snapshot value). On apply, the first op bumps the
  // version; the second hits 409 stale_block_version even though
  // nothing concurrent happened. To prevent this we treat a second
  // edit on the same block as REPLACING the prior op (Gemini is
  // refining its proposal, not stacking versions). A prior delete
  // on the same block is contradictory — refuse.
  const priorIdx = session.changeset.findIndex(
    (o) =>
      (o.op === 'edit' || o.op === 'delete') && o.blockId === blockId,
  )
  if (priorIdx >= 0) {
    const prior = session.changeset[priorIdx]!
    if (prior.op === 'delete') {
      return { ok: false, error: 'conflicts_with_pending_delete' }
    }
    if (prior.op !== 'edit') {
      // Defensive — the discriminant guarantees this is unreachable.
      return { ok: false, error: 'invalid_state' }
    }
    // Replace the prior edit op in-place (preserve original
    // expectedBlockVersion from the hydrate snapshot).
    const op: ChatChangesetOp = {
      op: 'edit',
      blockId,
      blockType: block.blockType,
      data: validated,
      expectedBlockVersion: prior.expectedBlockVersion,
    }
    session.changeset[priorIdx] = op
    return {
      ok: true,
      opIndex: priorIdx,
      summary: `Edit ${block.blockType} (block ${block.id}, replaces prior edit).`,
    }
  }
  if (session.changeset.length >= MAX_CHAT_CHANGESET_OPS) {
    return { ok: false, error: 'changeset_full' }
  }
  const op: ChatChangesetOp = {
    op: 'edit',
    blockId,
    blockType: block.blockType,
    data: validated,
    expectedBlockVersion: block.version,
  }
  session.changeset.push(op)
  return {
    ok: true,
    opIndex: session.changeset.length - 1,
    summary: `Edit ${block.blockType} (block ${block.id}).`,
  }
}

// ── propose_block_insert ───────────────────────────────────────────

function runProposeBlockInsert(
  rawInput: unknown,
  session: ChatSessionContext,
): ToolCallResult {
  if (session.changeset.length >= MAX_CHAT_CHANGESET_OPS) {
    return { ok: false, error: 'changeset_full' }
  }
  const parsed = ProposeBlockInsertInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_arguments',
      detail: { issues: zodIssues(parsed.error) },
    }
  }
  const { parentColumnId, afterBlockId, beforeBlockId, blockType, data } =
    parsed.data
  const parent = session.blocks.find((b) => b.id === parentColumnId)
  if (!parent) {
    return { ok: false, error: 'parent_not_on_page' }
  }
  if (parent.kind !== 'column') {
    return { ok: false, error: 'parent_must_be_column' }
  }
  if (!(blockType in blockSchemas)) {
    return { ok: false, error: 'unknown_block_type' }
  }
  // Validate the anchor sibling lives under the same column.
  // Also reject anchors that are slated for deletion in this same
  // changeset — at apply time the delete soft-deletes the anchor
  // BEFORE the insert resolves its position, and the insert's
  // position-bisect would silently fall through to append-to-tail
  // (PR 4 audit finding M12).
  if (afterBlockId !== undefined) {
    const sib = session.blocks.find((b) => b.id === afterBlockId)
    if (!sib || sib.parentId !== parentColumnId) {
      return { ok: false, error: 'anchor_not_sibling' }
    }
    if (
      session.changeset.some(
        (o) => o.op === 'delete' && o.blockId === afterBlockId,
      )
    ) {
      return { ok: false, error: 'anchor_pending_delete' }
    }
  }
  if (beforeBlockId !== undefined) {
    const sib = session.blocks.find((b) => b.id === beforeBlockId)
    if (!sib || sib.parentId !== parentColumnId) {
      return { ok: false, error: 'anchor_not_sibling' }
    }
    if (
      session.changeset.some(
        (o) => o.op === 'delete' && o.blockId === beforeBlockId,
      )
    ) {
      return { ok: false, error: 'anchor_pending_delete' }
    }
  }
  let validated: unknown
  try {
    validated = parseAndSanitize(blockType, data)
  } catch (err) {
    return {
      ok: false,
      error: 'validation_failed',
      detail: validationErrorDetail(err),
    }
  }
  const op: ChatChangesetOp = {
    op: 'insert',
    parentColumnId,
    blockType,
    data: validated,
    ...(afterBlockId !== undefined ? { afterBlockId } : {}),
    ...(beforeBlockId !== undefined ? { beforeBlockId } : {}),
  }
  session.changeset.push(op)
  return {
    ok: true,
    opIndex: session.changeset.length - 1,
    summary: `Insert ${blockType} into column ${parentColumnId}.`,
  }
}

// ── propose_block_delete ───────────────────────────────────────────

function runProposeBlockDelete(
  rawInput: unknown,
  session: ChatSessionContext,
): ToolCallResult {
  const parsed = ProposeBlockDeleteInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_arguments',
      detail: { issues: zodIssues(parsed.error) },
    }
  }
  const { blockId } = parsed.data
  const block = session.blocks.find((b) => b.id === blockId)
  if (!block) {
    return { ok: false, error: 'block_not_on_page' }
  }
  if (block.kind !== 'widget') {
    return { ok: false, error: 'cannot_delete_container' }
  }
  if (block.blockKey !== null) {
    return { ok: false, error: 'cannot_delete_fixed_block' }
  }
  // PR 4 audit fix (CRITICAL/M12): single op per blockId across the
  // changeset. A pending edit on this block becomes moot — replace
  // with the delete. An existing reorder move that includes this
  // block also has to drop the now-deleted reference.
  const priorEditIdx = session.changeset.findIndex(
    (o) => o.op === 'edit' && o.blockId === blockId,
  )
  if (priorEditIdx >= 0) {
    // Replace the prior edit op with the delete (delete supersedes).
    const op: ChatChangesetOp = {
      op: 'delete',
      blockId,
      blockType: block.blockType,
      expectedBlockVersion: block.version,
    }
    session.changeset[priorEditIdx] = op
    return {
      ok: true,
      opIndex: priorEditIdx,
      summary: `Delete ${block.blockType} (block ${block.id}, supersedes prior edit).`,
    }
  }
  const priorDeleteIdx = session.changeset.findIndex(
    (o) => o.op === 'delete' && o.blockId === blockId,
  )
  if (priorDeleteIdx >= 0) {
    // Idempotent — second delete on the same block is a no-op.
    return {
      ok: true,
      opIndex: priorDeleteIdx,
      summary: `Delete ${block.blockType} (block ${block.id}, already proposed).`,
    }
  }
  // Reorder ops that move this block become incompatible — refuse so
  // Gemini can either drop the reorder or stop trying to delete.
  if (
    session.changeset.some(
      (o) =>
        o.op === 'reorder' && o.moves.some((m) => m.blockId === blockId),
    )
  ) {
    return { ok: false, error: 'conflicts_with_pending_reorder' }
  }
  if (session.changeset.length >= MAX_CHAT_CHANGESET_OPS) {
    return { ok: false, error: 'changeset_full' }
  }
  const op: ChatChangesetOp = {
    op: 'delete',
    blockId,
    blockType: block.blockType,
    expectedBlockVersion: block.version,
  }
  session.changeset.push(op)
  return {
    ok: true,
    opIndex: session.changeset.length - 1,
    summary: `Delete ${block.blockType} (block ${block.id}).`,
  }
}

// ── propose_block_reorder ──────────────────────────────────────────

function runProposeBlockReorder(
  rawInput: unknown,
  session: ChatSessionContext,
): ToolCallResult {
  if (session.changeset.length >= MAX_CHAT_CHANGESET_OPS) {
    return { ok: false, error: 'changeset_full' }
  }
  const parsed = ProposeBlockReorderInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'invalid_arguments',
      detail: { issues: zodIssues(parsed.error) },
    }
  }
  const { moves } = parsed.data
  // Defence-in-depth: no duplicate blockIds in moves[].
  const seen = new Set<number>()
  for (const m of moves) {
    if (seen.has(m.blockId)) {
      return { ok: false, error: 'duplicate_block_in_moves' }
    }
    seen.add(m.blockId)
  }
  for (const m of moves) {
    const block = session.blocks.find((b) => b.id === m.blockId)
    if (!block) {
      return { ok: false, error: 'block_not_on_page' }
    }
    if (block.kind !== 'widget') {
      return { ok: false, error: 'cannot_reorder_container' }
    }
    // PR 4 audit fix (HIGH H1): reject moves of fixed-slot widgets
    // (block_key non-null — e.g., contact_form on /contact). Fixed
    // slots are template-guaranteed at a specific column; moving them
    // breaks the page-template contract.
    if (block.blockKey !== null) {
      return { ok: false, error: 'cannot_reorder_fixed_block' }
    }
    const parent = session.blocks.find((b) => b.id === m.parentColumnId)
    if (!parent) {
      return { ok: false, error: 'parent_not_on_page' }
    }
    if (parent.kind !== 'column') {
      return { ok: false, error: 'parent_must_be_column' }
    }
    // PR 4 audit fix (M12): reject moves that reference blocks
    // already marked for deletion elsewhere in this changeset.
    if (
      session.changeset.some(
        (o) => o.op === 'delete' && o.blockId === m.blockId,
      )
    ) {
      return { ok: false, error: 'conflicts_with_pending_delete' }
    }
  }
  const op: ChatChangesetOp = {
    op: 'reorder',
    moves: moves.map((m) => {
      const block = session.blocks.find((b) => b.id === m.blockId)!
      return {
        blockId: m.blockId,
        parentColumnId: m.parentColumnId,
        position: m.position,
        // Snapshot the propose-time version so apply-time can detect
        // a concurrent edit and 409 stale_block_version (PR 4 audit
        // fix — HIGH).
        expectedBlockVersion: block.version,
      }
    }),
  }
  session.changeset.push(op)
  return {
    ok: true,
    opIndex: session.changeset.length - 1,
    summary: `Reorder ${moves.length} block(s).`,
  }
}

// ── helpers ────────────────────────────────────────────────────────

function zodIssues(err: { issues: Array<{ path: (string | number)[]; message: string }> }): Array<{
  path: string
  message: string
}> {
  return err.issues.slice(0, 8).map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }))
}

interface MaybeZodError {
  name?: string
  message?: string
  issues?: Array<{ path: (string | number)[]; message: string }>
}

function validationErrorDetail(err: unknown): Record<string, unknown> {
  const e = err as MaybeZodError
  if (e && Array.isArray(e.issues)) {
    return {
      issues: e.issues.slice(0, 8).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    }
  }
  return { message: e?.message ? String(e.message).slice(0, 200) : 'invalid' }
}
