import 'server-only'
import diff from 'microdiff'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, type Tx } from '@/db/client'
import { auditLog } from '@/db/schema'
import { HttpError } from '@/lib/auth/requireRole'
import {
  saveBlock,
  StaleBlockVersionError,
  StalePageVersionError,
  NotFoundError,
  AUDIT_DIFF_CAP,
  capAuditDiff,
  type DiffOp,
} from '@/lib/cms/saveBlock'
import { parseAndSanitize } from '@/lib/cms/parse'
import { blockSchemas, FIXED_BLOCK_KEYS_PER_PAGE } from '@/lib/cms/block-registry'
import { collectMediaPaths } from '@/lib/cms/mediaRefs'
import { assertMediaAvailable } from '@/lib/cms/mediaCheck'
import { AUDIT_KIND } from '@/lib/cms/auditKinds'
import { enqueueRevalidate, drainRevalidate } from '@/lib/cache/durableRevalidate'
import { tagsForBlockSave } from '@/lib/cache/tags'
import type { BlockKind } from '@/lib/cms/blockMeta'
import type { InlineChangesetOp } from './runProposal'
import type { ChatChangesetOp } from './tools'

// AI proposal applier.
//
// PR 3 replaces the PR 1 stub. The new contract:
//
//   - applyInlineProposalByToken({ token, userId, pageVersion, ... })
//       Looks up the pending proposal by token, runs the safety wall
//       again, dispatches saveBlock for the single op, returns
//       { ok: true, applied: [...] } OR a typed conflict shape on
//       409 / 410 / 422 (NEVER throws on conflict — the route maps
//       the shape to HTTP status).
//
//   - dismissProposalByToken({ token, userId })
//       Marks `pending` → `dismissed` + audit. No tree mutation.
//
//   - normaliseAcceptIndices — preserved from PR 1; the chat surface
//       (PR 4) will pass a subset of indices to apply. Inline always
//       applies all (single-op changeset).
//
// All paths are TX-wrapped with FOR UPDATE locks on the proposal row
// so two simultaneous /apply calls on the same token can't double-
// apply. saveBlock owns its own pages → content_blocks lock order,
// so the lock chain here is: ai_proposals (FOR UPDATE) → INSIDE the
// applyOp loop saveBlock locks pages → content_blocks. No deadlock
// risk (saveBlock's pages lock is a superset of the proposal row's
// page_id; nothing else in the system locks ai_proposals).

export interface ApplyOpResult {
  blockId: number
  blockVersion: number
}

export type ApplyConflictReason =
  | 'not_found'
  | 'not_pending'
  | 'expired'
  | 'wrong_user'
  | 'stale_block_version'
  | 'stale_page_version'
  | 'block_not_found'
  | 'validation_failed'

export interface ApplyResult {
  ok: true
  applied: ApplyOpResult[]
  pageVersion: number
}

export interface ApplyConflict {
  ok: false
  reason: ApplyConflictReason
  conflictingBlockIds?: number[]
  detail?: string
}

export interface ApplyInlineByTokenArgs {
  token: string
  userId: number
  // Page-version cursor the editor's optimistic state holds. The first
  // op's saveBlock call uses this; subsequent ops would chain off the
  // previous op's response (inline always has ONE op so the chain is
  // trivial).
  pageVersion: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

interface ProposalRow {
  id: number
  user_id: number | null
  page_id: number
  surface: 'inline' | 'chat'
  status: 'pending' | 'accepted' | 'dismissed' | 'expired'
  changeset: string | InlineChangesetOp[]
  model: string
  tokens_usage: string | object | null
  expires_at: Date | string
}

function parseChangeset(raw: ProposalRow['changeset']): InlineChangesetOp[] {
  if (Array.isArray(raw)) return raw as InlineChangesetOp[]
  try {
    const parsed = JSON.parse(raw as string) as unknown
    if (Array.isArray(parsed)) return parsed as InlineChangesetOp[]
  } catch {
    /* fall through */
  }
  return []
}

function isExpired(expires: ProposalRow['expires_at']): boolean {
  const t = expires instanceof Date ? expires.getTime() : new Date(expires).getTime()
  return Number.isFinite(t) && t < Date.now()
}

export async function applyInlineProposalByToken(
  args: ApplyInlineByTokenArgs,
): Promise<ApplyResult | ApplyConflict> {
  // Phase 1 — lookup + status checks. The FOR UPDATE lock is released
  // when this TX commits at the end of the callback, which limits it
  // to short-window serialisation (two simultaneous SELECTs will
  // serialise; the second sees no change in status because we don't
  // flip it here). True double-apply prevention sits one layer
  // deeper: phase 2's saveBlock runs the dual-axis optimistic-lock
  // check on expectedBlockVersion, so the second apply gets back
  // 409 stale_block_version after the first apply bumped the block.
  //
  // We deliberately do NOT call saveBlock inside the phase-1 TX
  // because saveBlock owns its own TX with the pages/content_blocks
  // lock order — nesting transactions would deadlock against a
  // sibling block save that took pages → content_blocks in the
  // canonical order.
  //
  // If phase 2 throws stale-version, we leave the proposal `pending`
  // (rather than auto-dismiss) so the operator can refresh + retry
  // with the updated cursor.
  let proposal: { id: number; pageId: number; changeset: InlineChangesetOp[] }
  try {
    proposal = await db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT id, user_id, page_id, surface, status, changeset, model,
               tokens_usage, expires_at
        FROM ai_proposals
        WHERE token = ${args.token}
        FOR UPDATE
      `)) as unknown as [ProposalRow[]]
      const row = rows[0]
      if (!row) throw new ConflictMarker({ ok: false, reason: 'not_found' })
      // PR 4 audit fix (MEDIUM M3): surface guard symmetric with the
      // chat applier. An inline applier handling a chat-surface row
      // would dispatch the wrong shape into saveBlock — fail closed
      // and surface as not_found to avoid leaking the token's surface
      // type.
      if (row.surface !== 'inline') {
        throw new ConflictMarker({ ok: false, reason: 'not_found' })
      }
      if (row.user_id !== args.userId) {
        // Even an admin shouldn't apply another operator's proposal —
        // accept-link forwarding / session theft would otherwise let
        // someone trigger a peer's pending change. Surface as not_found
        // to avoid confirming the token exists to a probing attacker;
        // log forensic detail for audit triage.
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'ai_proposal_apply_wrong_user',
            proposal_id: row.id,
            owner: row.user_id,
            attempted_by: args.userId,
          }),
        )
        throw new ConflictMarker({ ok: false, reason: 'not_found' })
      }
      if (row.status !== 'pending') {
        // Already accepted / dismissed / expired. Don't reverse.
        throw new ConflictMarker({
          ok: false,
          reason: row.status === 'expired' ? 'expired' : 'not_pending',
        })
      }
      if (isExpired(row.expires_at)) {
        // Sweep on-read — flips the row to expired so the next call
        // sees it as terminal. Best-effort: a failure here doesn't
        // block the conflict response.
        await tx
          .execute(sql`
            UPDATE ai_proposals
            SET status = 'expired'
            WHERE id = ${row.id} AND status = 'pending'
          `)
          .catch(() => {
            /* swallow — caller still gets the right conflict */
          })
        throw new ConflictMarker({ ok: false, reason: 'expired' })
      }
      const changeset = parseChangeset(row.changeset)
      if (changeset.length === 0) {
        throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
      }
      return { id: row.id, pageId: row.page_id, changeset }
    })
  } catch (err) {
    if (err instanceof ConflictMarker) return err.payload
    throw err
  }

  // Phase 2 — dispatch saveBlock for each op. Inline always has ONE
  // op; the loop shape is retained for forward compatibility with the
  // chat surface that may emit multi-op changesets.
  //
  // We do NOT pre-validate via parseAndSanitize again before calling
  // saveBlock — saveBlock itself runs parseAndSanitize as its write
  // boundary. Letting saveBlock be the single validation site keeps
  // a tampered ai_proposals.changeset row from passing twice while
  // mutating only once.
  const applied: ApplyOpResult[] = []
  let pageVersionCursor = args.pageVersion
  const conflictingBlockIds: number[] = []
  let earlyConflict: ApplyConflict | null = null
  for (const op of proposal.changeset) {
    if (op.op !== 'edit') {
      // Inline never emits non-edit ops. A non-edit op on an inline
      // proposal is a server bug; reject the whole apply rather than
      // silently skipping.
      earlyConflict = { ok: false, reason: 'validation_failed' }
      break
    }
    try {
      // Defence in depth: re-validate the candidate data BEFORE
      // saveBlock so we don't churn an UPDATE on guaranteed-invalid
      // input. saveBlock would also catch it via parseAndSanitize,
      // but throwing here avoids the lock acquisition.
      try {
        parseAndSanitize(op.blockType, op.data)
      } catch {
        earlyConflict = { ok: false, reason: 'validation_failed' }
        break
      }
      const result = await saveBlock({
        blockId: op.blockId,
        userId: args.userId,
        // Session-only path (/api/ai/* is not token-reachable), so no token
        // attribution — the human operator applied this proposal.
        tokenId: null,
        ip: args.ip,
        userAgent: args.userAgent,
        requestId: args.requestId,
        pageId: proposal.pageId,
        expectedBlockVersion: op.expectedBlockVersion,
        expectedPageVersion: pageVersionCursor,
        data: op.data,
      })
      applied.push({
        blockId: op.blockId,
        blockVersion: result.blockVersion,
      })
      pageVersionCursor = result.pageVersion
    } catch (err) {
      if (err instanceof StaleBlockVersionError) {
        conflictingBlockIds.push(op.blockId)
        earlyConflict = {
          ok: false,
          reason: 'stale_block_version',
          conflictingBlockIds,
        }
        break
      }
      if (err instanceof StalePageVersionError) {
        earlyConflict = { ok: false, reason: 'stale_page_version' }
        break
      }
      if (err instanceof NotFoundError) {
        earlyConflict = {
          ok: false,
          reason: 'block_not_found',
          conflictingBlockIds: [op.blockId],
        }
        break
      }
      throw err
    }
  }

  if (earlyConflict) {
    // saveBlock already rolled back its own TX; the proposal row is
    // still `pending` (we never flipped it). The operator can retry
    // after refreshing.
    return earlyConflict
  }

  // Phase 3 — mark accepted + audit, inside a fresh TX. If this
  // fails (DB outage between phase 2 and phase 3), the block
  // mutation is already durable. We log fatal so the operator's
  // alert pipeline catches the audit gap, but we return SUCCESS to
  // the client — the block IS edited. The alternative (return 5xx
  // when the audit fails) would leave the operator's UI showing
  // "Apply failed" even though the block changed, which is more
  // confusing than the missing audit row.
  //
  // Retry once with a short backoff before giving up — most
  // transient lock-wait timeouts clear inside ~500ms.
  let phase3Retries = 1
  while (true) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE ai_proposals
          SET status = 'accepted',
              applied_at = NOW(3)
          WHERE id = ${proposal.id} AND status = 'pending'
        `)
        await tx.insert(auditLog).values({
          userId: args.userId,
          action: 'ai_proposal_accepted',
          resourceType: 'ai_proposal',
          resourceId: String(proposal.id),
          diff: {
            token: args.token,
            surface: 'inline',
            appliedBlocks: applied,
          } as unknown as object,
          ip: args.ip,
          userAgent: args.userAgent,
          requestId: args.requestId,
        })
      })
      break
    } catch (err) {
      if (phase3Retries > 0) {
        phase3Retries -= 1
        await new Promise((r) => setTimeout(r, 250))
        continue
      }
      // Final failure — log fatal and exit the loop. We deliberately
      // do NOT throw so the operator's apply still resolves as
      // success (the block has the AI's content; failing the apply
      // would leave the editor's UI stuck on "Apply failed" while
      // the page is actually updated).
      console.error(
        JSON.stringify({
          level: 'fatal',
          msg: 'ai_proposal_accept_audit_failed',
          proposal_id: proposal.id,
          token: args.token,
          err_name: err instanceof Error ? err.name : 'unknown',
        }),
      )
      break
    }
  }

  return {
    ok: true,
    applied,
    pageVersion: pageVersionCursor,
  }
}

export interface DismissByTokenArgs {
  token: string
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export interface DismissResult {
  ok: true
}
export interface DismissConflict {
  ok: false
  reason: 'not_found' | 'not_pending' | 'expired'
}

export async function dismissProposalByToken(
  args: DismissByTokenArgs,
): Promise<DismissResult | DismissConflict> {
  try {
    return await db.transaction(async (tx) => {
      // PR 4 audit fix (HIGH H6): read the row's surface so the audit
      // row records the correct surface. Pre-fix the audit always
      // stamped surface:'inline' even for chat-surface dismissals,
      // breaking forensic queries.
      const [rows] = (await tx.execute(sql`
        SELECT id, user_id, surface, status, expires_at
        FROM ai_proposals
        WHERE token = ${args.token}
        FOR UPDATE
      `)) as unknown as [
        Array<{
          id: number
          user_id: number | null
          surface: 'inline' | 'chat'
          status: ProposalRow['status']
          expires_at: Date | string
        }>,
      ]
      const row = rows[0]
      if (!row) return { ok: false, reason: 'not_found' as const }
      if (row.user_id !== args.userId) {
        // Same defensive disclosure pattern as the apply path.
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'ai_proposal_dismiss_wrong_user',
            proposal_id: row.id,
            owner: row.user_id,
            attempted_by: args.userId,
          }),
        )
        return { ok: false, reason: 'not_found' as const }
      }
      if (row.status !== 'pending') {
        return {
          ok: false,
          reason: row.status === 'expired' ? 'expired' : 'not_pending',
        }
      }
      if (isExpired(row.expires_at)) {
        await tx
          .execute(sql`
            UPDATE ai_proposals SET status='expired'
            WHERE id = ${row.id} AND status='pending'
          `)
          .catch(() => {
            /* best-effort */
          })
        return { ok: false, reason: 'expired' as const }
      }
      await tx.execute(sql`
        UPDATE ai_proposals SET status='dismissed'
        WHERE id = ${row.id} AND status='pending'
      `)
      await tx.insert(auditLog).values({
        userId: args.userId,
        action: 'ai_proposal_dismissed',
        resourceType: 'ai_proposal',
        resourceId: String(row.id),
        diff: { token: args.token, surface: row.surface } as unknown as object,
        ip: args.ip,
        userAgent: args.userAgent,
        requestId: args.requestId,
      })
      return { ok: true as const }
    })
  } catch (err) {
    throw err
  }
}

// ── PR 1 carry-over: normaliseAcceptIndices is still useful for the
// upcoming chat surface (PR 4) which lets operators apply a subset
// of a multi-op changeset. Inline always passes null. ───────────────

export const AcceptIndices = (() => {
  // Avoid importing zod just for the array shape — manual validation
  // is fine for a length + nonneg-int check.
  function parse(value: unknown): number[] | null {
    if (value === null || value === undefined) return null
    if (!Array.isArray(value)) {
      throw new HttpError(400, 'invalid_accept_indices')
    }
    if (value.length > 32) {
      throw new HttpError(400, 'too_many_accept_indices')
    }
    const out: number[] = []
    for (const v of value) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new HttpError(400, 'invalid_accept_indices')
      }
      out.push(v)
    }
    return out
  }
  return { parse }
})()

export function normaliseAcceptIndices(
  indices: number[] | null,
  changesetLength: number,
): number[] | null {
  if (indices === null) return null
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0) {
      throw new HttpError(400, 'invalid_accept_indices')
    }
    if (i >= changesetLength) {
      throw new HttpError(400, 'accept_index_out_of_range')
    }
  }
  return Array.from(new Set(indices)).sort((a, b) => a - b)
}

// Internal exception type — phase-1 conflict carrier. Lets the inner
// TX callback signal a typed conflict back to the outer applier
// without a string-sniff against the error message.
class ConflictMarker extends Error {
  constructor(public readonly payload: ApplyConflict) {
    super(`apply_conflict:${payload.reason}`)
    this.name = 'ConflictMarker'
  }
}

// PR 4 audit fix (CRITICAL C1): typed error so a Drizzle/mysql2
// edge case in applyChatInsertOp where INSERT succeeds but the
// driver hasn't surfaced an insertId surfaces cleanly through the
// outer catch as block_not_found instead of an untyped 500.
class ChatInsertFailedError extends Error {
  constructor() {
    super('chat_insert_failed')
    this.name = 'ChatInsertFailedError'
  }
}

// ════════════════════════════════════════════════════════════════════
//  PR 4 — Page Assistant chat applier.
//
//  Multi-op all-or-nothing apply. Loads the proposal row, filters the
//  changeset through acceptIndices (subset accept), then opens ONE
//  outer TX. The TX locks the pages row first (canonical lock order
//  shared with saveBlock — pages → content_blocks → media), then
//  dispatches each op inline. ANY op failure rolls back the WHOLE TX;
//  the proposal row stays `pending` so the operator can refresh +
//  retry.
//
//  Why inline SQL per op instead of calling saveBlock / the route
//  helpers: the existing routes each open their own db.transaction.
//  Nesting transactions on mysql2/drizzle works via SAVEPOINT but
//  breaks the lock-order discipline (every saveBlock locks pages
//  again on its own). The chat-allowed ops are STRICTER than the
//  full route surface (widget-only — sections/columns out of scope
//  for PR 4) so we lift only the SQL we need.
//
//  Op kinds the chat applier handles:
//    - 'edit'     UPDATE content_blocks + media-ref diff + audit
//    - 'insert'   INSERT content_blocks under a column + media-ref
//                 INSERT + audit
//    - 'delete'   Soft-delete one widget (no cascade — widgets only)
//                 + drop media_references + audit
//    - 'reorder'  Batched UPDATE of position + parent_id across many
//                 widgets, all on this page
//
//  After every successful op we audit `content_block.*` and pump the
//  block version. After the last op we bump pages.version once, audit
//  `ai_proposal_accepted`, flip the proposal to accepted, then
//  enqueueRevalidate inside the same TX.
// ════════════════════════════════════════════════════════════════════

export interface ApplyChatByTokenArgs {
  token: string
  userId: number
  pageVersion: number
  /** When null, every op in the persisted changeset applies. When a
   *  number[], only the listed indices apply (the per-card "Accept"
   *  flow in the proposal tray). Normalised + bounds-checked by
   *  `normaliseAcceptIndices` before reaching the loop. */
  acceptIndices: number[] | null
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export interface ChatApplyOpResult {
  op: 'edit' | 'insert' | 'delete' | 'reorder'
  /** For edit/delete: the bumped block version. For insert: the new
   *  block's id + initial version 0. For reorder: a list of affected
   *  block ids with their bumped versions. */
  blockId?: number
  blockVersion?: number
  /** Insert-only — the freshly-minted row's id. */
  insertedBlockId?: number
  /** Reorder-only — per-move {id, version, parentId, position}. */
  moves?: Array<{
    blockId: number
    blockVersion: number
    parentColumnId: number
    position: number
  }>
}

export interface ChatApplyResult {
  ok: true
  applied: ChatApplyOpResult[]
  pageVersion: number
}

export async function applyChatProposalByToken(
  args: ApplyChatByTokenArgs,
): Promise<ChatApplyResult | ApplyConflict> {
  // ── Phase 1 — lookup + status checks. ─────────────────────────
  let proposal: {
    id: number
    pageId: number
    changeset: ChatChangesetOp[]
  }
  try {
    proposal = await db.transaction(async (tx) => {
      const [rows] = (await tx.execute(sql`
        SELECT id, user_id, page_id, surface, status, changeset, model,
               tokens_usage, expires_at
        FROM ai_proposals
        WHERE token = ${args.token}
        FOR UPDATE
      `)) as unknown as [
        Array<{
          id: number
          user_id: number | null
          page_id: number
          surface: 'inline' | 'chat'
          status: 'pending' | 'accepted' | 'dismissed' | 'expired'
          changeset: string | ChatChangesetOp[]
          expires_at: Date | string
        }>,
      ]
      const row = rows[0]
      if (!row) throw new ConflictMarker({ ok: false, reason: 'not_found' })
      if (row.surface !== 'chat') {
        // Wrong surface — operator hit the chat apply path for an
        // inline proposal. Surface as not_found (no info leak).
        throw new ConflictMarker({ ok: false, reason: 'not_found' })
      }
      if (row.user_id !== args.userId) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'ai_proposal_chat_apply_wrong_user',
            proposal_id: row.id,
            owner: row.user_id,
            attempted_by: args.userId,
          }),
        )
        throw new ConflictMarker({ ok: false, reason: 'not_found' })
      }
      if (row.status !== 'pending') {
        throw new ConflictMarker({
          ok: false,
          reason: row.status === 'expired' ? 'expired' : 'not_pending',
        })
      }
      if (isExpired(row.expires_at)) {
        await tx
          .execute(sql`
            UPDATE ai_proposals SET status='expired'
            WHERE id = ${row.id} AND status='pending'
          `)
          .catch(() => {
            /* best-effort */
          })
        throw new ConflictMarker({ ok: false, reason: 'expired' })
      }
      const changeset = parseChatChangeset(row.changeset)
      if (changeset.length === 0) {
        throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
      }
      return { id: row.id, pageId: row.page_id, changeset }
    })
  } catch (err) {
    if (err instanceof ConflictMarker) return err.payload
    throw err
  }

  // ── Filter changeset by acceptIndices. The normaliser already
  //    bounded the indices to [0, changeset.length); here we just
  //    pick. ─────────────────────────────────────────────────────
  let ops: ChatChangesetOp[]
  if (args.acceptIndices === null) {
    ops = proposal.changeset
  } else if (args.acceptIndices.length === 0) {
    return { ok: false, reason: 'validation_failed' }
  } else {
    ops = args.acceptIndices.map((i) => proposal.changeset[i]!).filter(Boolean)
    if (ops.length !== args.acceptIndices.length) {
      return { ok: false, reason: 'validation_failed' }
    }
  }

  // ── Phase 2 — one outer TX for the entire op set. ────────────
  let txOutcome: {
    applied: ChatApplyOpResult[]
    pageVersion: number
    slug: string
    revalidateTags: string[]
    queueRowId: number | null
  }
  try {
    txOutcome = await db.transaction(async (tx) => {
      // Step 1: lock the pages row.
      const [pageLockRows] = (await tx.execute(sql`
        SELECT id, slug, version FROM pages
        WHERE id = ${proposal.pageId} AND deleted_at IS NULL
        FOR UPDATE
      `)) as unknown as [Array<{ id: number; slug: string; version: number }>]
      const pageLock = pageLockRows[0]
      if (!pageLock) {
        throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
      }
      if (pageLock.version !== args.pageVersion) {
        throw new ConflictMarker({ ok: false, reason: 'stale_page_version' })
      }

      // Step 2: dispatch per op. We accumulate per-op results AND
      // collect revalidate tags AND per-block-type signals.
      const applied: ChatApplyOpResult[] = []
      const touchedBlockTypes = new Set<string>()
      for (let i = 0; i < ops.length; i += 1) {
        const op = ops[i]!
        if (op.op === 'edit') {
          const result = await applyChatEditOp(tx, {
            pageId: proposal.pageId,
            op,
            userId: args.userId,
            ip: args.ip,
            userAgent: args.userAgent,
            requestId: args.requestId,
          })
          applied.push({
            op: 'edit',
            blockId: op.blockId,
            blockVersion: result.blockVersion,
          })
          touchedBlockTypes.add(op.blockType)
        } else if (op.op === 'insert') {
          const result = await applyChatInsertOp(tx, {
            pageId: proposal.pageId,
            pageSlug: pageLock.slug,
            op,
            userId: args.userId,
            ip: args.ip,
            userAgent: args.userAgent,
            requestId: args.requestId,
          })
          applied.push({
            op: 'insert',
            insertedBlockId: result.blockId,
            blockVersion: 0,
          })
          touchedBlockTypes.add(op.blockType)
        } else if (op.op === 'delete') {
          const result = await applyChatDeleteOp(tx, {
            pageId: proposal.pageId,
            op,
            userId: args.userId,
            ip: args.ip,
            userAgent: args.userAgent,
            requestId: args.requestId,
          })
          applied.push({
            op: 'delete',
            blockId: op.blockId,
            blockVersion: result.blockVersion,
          })
          touchedBlockTypes.add(op.blockType)
        } else if (op.op === 'reorder') {
          const result = await applyChatReorderOp(tx, {
            pageId: proposal.pageId,
            op,
            userId: args.userId,
            ip: args.ip,
            userAgent: args.userAgent,
            requestId: args.requestId,
          })
          applied.push({ op: 'reorder', moves: result.moves })
        }
      }

      // Step 3: bump pages.version ONCE for the whole apply gesture.
      await tx.execute(sql`
        UPDATE pages
        SET version = version + 1,
            updated_at = NOW(3),
            updated_by = ${args.userId}
        WHERE id = ${proposal.pageId}
      `)
      const newPageVersion = pageLock.version + 1

      // Step 4: flip the proposal row + audit the chat-level accept.
      // PR 4 audit fix (MEDIUM M2): verify the status transition with
      // an affected-rows check. The FOR UPDATE in phase 1 should make
      // this redundant, but a clean fail-closed on the state machine
      // guarantees we never silently double-apply if the row was
      // already flipped between phase-1 and phase-2.
      const statusFlipRaw = (await tx.execute(sql`
        UPDATE ai_proposals
        SET status = 'accepted',
            applied_at = NOW(3)
        WHERE id = ${proposal.id} AND status = 'pending'
      `)) as unknown as { affectedRows: number } | [unknown, { affectedRows: number }]
      const statusAffected = Array.isArray(statusFlipRaw)
        ? statusFlipRaw[0] && typeof statusFlipRaw[0] === 'object' && 'affectedRows' in statusFlipRaw[0]
          ? (statusFlipRaw[0] as { affectedRows: number }).affectedRows
          : (statusFlipRaw as unknown as { affectedRows: number }).affectedRows
        : statusFlipRaw.affectedRows
      if (statusAffected === 0) {
        throw new ConflictMarker({ ok: false, reason: 'not_pending' })
      }
      await tx.insert(auditLog).values({
        userId: args.userId,
        action: 'ai_proposal_accepted',
        resourceType: 'ai_proposal',
        resourceId: String(proposal.id),
        diff: {
          token: args.token,
          surface: 'chat',
          acceptedIndices: args.acceptIndices,
          opCount: ops.length,
          opKinds: ops.reduce<Record<string, number>>((m, o) => {
            m[o.op] = (m[o.op] ?? 0) + 1
            return m
          }, {}),
          appliedBlocks: applied.map((a) => ({
            op: a.op,
            blockId: a.blockId ?? a.insertedBlockId ?? null,
            blockVersion: a.blockVersion ?? null,
          })),
        } as unknown as object,
        ip: args.ip,
        userAgent: args.userAgent,
        requestId: args.requestId,
      })

      // Step 5: revalidate tags for the page. PR 4 audit fix (MEDIUM
      // M7): union per touched block_type so any block type with a
      // cross-cutting tag set (today only featured_projects, but the
      // contract is per-type) gets its tag included symmetrically —
      // no hardcoded list.
      const tagSet = new Set<string>(tagsForBlockSave(pageLock.slug).tags)
      for (const blockType of touchedBlockTypes) {
        for (const t of tagsForBlockSave(pageLock.slug, blockType).tags) {
          tagSet.add(t)
        }
      }
      const tags = [...tagSet]
      const queueRowId = tags.length
        ? await enqueueRevalidate(tx, tags)
        : null

      return {
        applied,
        pageVersion: newPageVersion,
        slug: pageLock.slug,
        revalidateTags: tags,
        queueRowId,
      }
    })
  } catch (err) {
    if (err instanceof ConflictMarker) return err.payload
    if (err instanceof StaleBlockVersionError) {
      return { ok: false, reason: 'stale_block_version' }
    }
    if (err instanceof StalePageVersionError) {
      return { ok: false, reason: 'stale_page_version' }
    }
    if (err instanceof NotFoundError) {
      return { ok: false, reason: 'block_not_found' }
    }
    // PR 4 audit fix (MEDIUM M4): assertMediaAvailable throws
    // HttpError(404, 'media_missing') when a referenced media id
    // doesn't exist or got soft-deleted between propose and apply.
    // Without this branch the error bubbles up as a generic 500 the
    // chat client doesn't know how to surface.
    if (err instanceof HttpError && err.code === 'media_missing') {
      return { ok: false, reason: 'validation_failed' }
    }
    // PR 4 audit fix (CRITICAL C1): a typed insert failure
    // (ChatInsertFailedError) surfaces as block_not_found so the
    // apply route maps it to a clean 409 the client can render.
    if (err instanceof ChatInsertFailedError) {
      return { ok: false, reason: 'block_not_found' }
    }
    throw err
  }

  // After commit: drain the revalidate queue row best-effort.
  if (txOutcome.queueRowId !== null) {
    queueMicrotask(() => {
      void drainRevalidate(txOutcome.queueRowId!, txOutcome.revalidateTags)
    })
  }

  return {
    ok: true,
    applied: txOutcome.applied,
    pageVersion: txOutcome.pageVersion,
  }
}

function parseChatChangeset(
  raw: string | ChatChangesetOp[],
): ChatChangesetOp[] {
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw as string) as unknown
    if (Array.isArray(parsed)) return parsed as ChatChangesetOp[]
  } catch {
    /* fall through */
  }
  return []
}

// ── Per-op SQL helpers ────────────────────────────────────────────
// Each takes the outer tx + the op + ambient args. Each is responsible
// for locking the blocks it touches (saveBlock-equivalent dual-axis
// optimistic-lock contract), validating the candidate data through the
// safety wall, writing the row(s), updating media_references, and
// inserting the per-block audit row. None of these helpers touch
// pages.version — the outer applyChatProposalByToken bumps it once
// after the loop. None opens a transaction; they all run inside the
// outer TX so a failure on op #N rolls back ops 1..N-1.

interface ChatEditArgs {
  pageId: number
  op: Extract<ChatChangesetOp, { op: 'edit' }>
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

async function applyChatEditOp(
  tx: Tx,
  args: ChatEditArgs,
): Promise<{ blockVersion: number }> {
  // Lock + read the target block.
  const [rows] = (await tx.execute(sql`
    SELECT id, page_id, block_type, kind, block_key, data, version
    FROM content_blocks
    WHERE id = ${args.op.blockId}
      AND page_id = ${args.pageId}
      AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [
    Array<{
      id: number
      page_id: number
      block_type: string
      kind: BlockKind
      block_key: string | null
      data: string
      version: number
    }>,
  ]
  const row = rows[0]
  if (!row) throw new NotFoundError()
  if (row.kind !== 'widget') {
    // Server-side enforcement of the chat tool surface; should never
    // get here because the propose-time gate rejects it, but defence-
    // in-depth against a tampered ai_proposals.changeset row.
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  // PR 4 audit fix (HIGH H2): refuse edits on fixed-slot widgets at
  // apply time. The propose-time gate currently allows editing fixed
  // slots (only delete refuses), but a tampered changeset row carrying
  // an op against a fixed-slot block would otherwise mutate the
  // contact form's data. The manual edit route's saveBlock path runs
  // through parseAndSanitize but does NOT check blockKey — chat
  // applier adds the gate here for symmetry with delete.
  if (row.block_key !== null) {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  if (row.version !== args.op.expectedBlockVersion) {
    throw new StaleBlockVersionError()
  }

  // Defence in depth: re-run parseAndSanitize on the persisted data.
  // The propose path already validated, but a tampered DB cell or a
  // schema change between propose + apply could have bent the shape.
  let parsed: unknown
  try {
    parsed = parseAndSanitize(row.block_type, args.op.data)
  } catch {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  const parsedJson = JSON.stringify(parsed)
  const newBlockVersion = row.version + 1

  await tx.execute(sql`
    UPDATE content_blocks
    SET data = ${parsedJson}, version = ${newBlockVersion}, updated_by = ${args.userId}
    WHERE id = ${args.op.blockId}
  `)

  // Media reference diff.
  let oldData: unknown
  try {
    oldData = JSON.parse(row.data)
  } catch {
    oldData = {}
  }
  const oldRefs = collectMediaPaths(oldData)
  const newRefs = collectMediaPaths(parsed)
  const oldSet = new Set(oldRefs.map((r) => `${r.mediaId}::${r.field}`))
  const newSet = new Set(newRefs.map((r) => `${r.mediaId}::${r.field}`))
  const newMediaIds = [
    ...new Set(
      newRefs
        .filter((r) => !oldSet.has(`${r.mediaId}::${r.field}`))
        .map((r) => r.mediaId),
    ),
  ]
  await assertMediaAvailable(tx, newMediaIds)
  for (const r of oldRefs) {
    if (!newSet.has(`${r.mediaId}::${r.field}`)) {
      await tx.execute(sql`
        DELETE FROM media_references
        WHERE media_id = ${r.mediaId}
          AND referent_type = 'content_block'
          AND referent_id = ${args.op.blockId}
          AND field = ${r.field}
      `)
    }
  }
  for (const r of newRefs) {
    if (!oldSet.has(`${r.mediaId}::${r.field}`)) {
      await tx.execute(sql`
        INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
        VALUES (${r.mediaId}, 'content_block', ${args.op.blockId}, ${r.field})
      `)
    }
  }

  // Audit (microdiff between old + parsed).
  const patch = diff(
    (oldData as object) ?? {},
    (parsed as object) ?? {},
  ) as DiffOp[]
  const cappedDiff = capAuditDiff(patch)
  const auditDiff = Array.isArray(cappedDiff)
    ? { kind: AUDIT_KIND.patch, ops: cappedDiff }
    : { ...(cappedDiff as object), kind: AUDIT_KIND.patchTruncated }
  await tx.insert(auditLog).values({
    userId: args.userId,
    action: 'update',
    resourceType: 'content_block',
    resourceId: String(args.op.blockId),
    diff: auditDiff,
    ip: args.ip,
    userAgent: args.userAgent,
    requestId: args.requestId,
  })

  return { blockVersion: newBlockVersion }
}

interface ChatInsertArgs {
  pageId: number
  pageSlug: string
  op: Extract<ChatChangesetOp, { op: 'insert' }>
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

async function applyChatInsertOp(
  tx: Tx,
  args: ChatInsertArgs,
): Promise<{ blockId: number }> {
  // Validate blockType registered + parse the data through the safety
  // wall. This is the third validation pass (propose-time + persistence-
  // time were the prior two).
  if (!(args.op.blockType in blockSchemas)) {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  // Refuse fixed-slot block types for THIS page (matches POST route
  // behaviour — fixed slots are seeded at template install).
  const fixedTypesForPage = FIXED_BLOCK_KEYS_PER_PAGE[args.pageSlug] ?? []
  if ((fixedTypesForPage as readonly string[]).includes(args.op.blockType)) {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }

  let parsed: unknown
  try {
    parsed = parseAndSanitize(args.op.blockType, args.op.data)
  } catch {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }

  // Lock the parent column. We require it to be a kind='column' row on
  // this page; the propose-time gate already enforces this but the row
  // could have been deleted between propose + apply.
  const [parentRows] = (await tx.execute(sql`
    SELECT id, kind, page_id
    FROM content_blocks
    WHERE id = ${args.op.parentColumnId} AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [
    Array<{ id: number; kind: BlockKind; page_id: number }>,
  ]
  const parent = parentRows[0]
  if (!parent) {
    throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
  }
  if (parent.page_id !== args.pageId) {
    throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
  }
  if (parent.kind !== 'column') {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }

  // Position calc with respace-and-retry. PR 4 audit fix (HIGH H4 +
  // MEDIUM M11): bisect against the sibling list; on null (gap
  // exhausted), respace the parent's children 1000-spaced and retry.
  // The retry is guaranteed to land because every gap is now ≥1000.
  //
  // If the anchor isn't a sibling under this parent at apply time
  // (the propose-time gate already rejected this case, but a
  // tampered ai_proposals.changeset row could carry it), the op is
  // refused as validation_failed — the AI shouldn't ghost-insert
  // somewhere the operator didn't approve.
  const readSiblings = async (): Promise<Array<{ id: number; position: number }>> => {
    const [r] = (await tx.execute(sql`
      SELECT id, position
      FROM content_blocks
      WHERE page_id = ${args.pageId}
        AND deleted_at IS NULL
        AND parent_id = ${args.op.parentColumnId}
      ORDER BY position
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; position: number }>]
    return r
  }
  const bisect = (siblings: Array<{ id: number; position: number }>): number | null => {
    if (args.op.beforeBlockId !== undefined) {
      const idx = siblings.findIndex((r) => r.id === args.op.beforeBlockId)
      if (idx === -1) return null
      if (idx === 0) {
        const p = Math.floor(siblings[0]!.position / 2)
        return p >= 1 && p < siblings[0]!.position ? p : null
      }
      const p = Math.floor(
        (siblings[idx - 1]!.position + siblings[idx]!.position) / 2,
      )
      return p > siblings[idx - 1]!.position && p < siblings[idx]!.position
        ? p
        : null
    }
    if (args.op.afterBlockId !== undefined) {
      const idx = siblings.findIndex((r) => r.id === args.op.afterBlockId)
      if (idx === -1) return null
      if (idx < siblings.length - 1) {
        const p = Math.floor(
          (siblings[idx]!.position + siblings[idx + 1]!.position) / 2,
        )
        return p > siblings[idx]!.position && p < siblings[idx + 1]!.position
          ? p
          : null
      }
      return siblings[idx]!.position + 1000
    }
    // No anchor — append-to-tail.
    const maxPos =
      siblings.length > 0
        ? siblings[siblings.length - 1]!.position
        : 0
    return maxPos + 1000
  }

  let siblings = await readSiblings()
  // If an anchor was provided but isn't a sibling under this parent
  // at apply time, refuse the op rather than silently appending —
  // mirrors the operator-approved intent.
  if (
    (args.op.beforeBlockId !== undefined &&
      !siblings.some((s) => s.id === args.op.beforeBlockId)) ||
    (args.op.afterBlockId !== undefined &&
      !siblings.some((s) => s.id === args.op.afterBlockId))
  ) {
    throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
  }
  let nextPos: number | null = bisect(siblings)
  if (nextPos === null) {
    // Respace the parent's children 1000-spaced and retry the bisect
    // ONCE. After respace every gap is ≥1000 so the retry is
    // guaranteed to fit.
    if (siblings.length > 0) {
      const positionCases = siblings.map(
        (s, i) => sql`WHEN ${s.id} THEN ${(i + 1) * 1000}`,
      )
      const idList = siblings.map((s) => s.id)
      await tx.execute(sql`
        UPDATE content_blocks
        SET position = CASE id ${sql.join(positionCases, sql.raw(' '))} END,
            version = version + 1,
            updated_by = ${args.userId}
        WHERE id IN (${sql.join(idList, sql.raw(','))})
          AND page_id = ${args.pageId}
          AND deleted_at IS NULL
      `)
      siblings = await readSiblings()
    }
    nextPos = bisect(siblings)
    if (nextPos === null) {
      throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
    }
  }

  // INSERT the widget row.
  const insertResult = (await tx.execute(sql`
    INSERT INTO content_blocks
      (page_id, parent_id, kind, block_type, position, data, meta, version, updated_by)
    VALUES (
      ${args.pageId},
      ${args.op.parentColumnId},
      'widget',
      ${args.op.blockType},
      ${nextPos},
      ${JSON.stringify(parsed)},
      NULL,
      0,
      ${args.userId}
    )
  `)) as unknown as { insertId?: number } | [{ insertId: number }, unknown]
  const insertId = Array.isArray(insertResult)
    ? insertResult[0]?.insertId
    : insertResult?.insertId
  if (!insertId) {
    throw new ChatInsertFailedError()
  }
  const blockId = Number(insertId)

  // Media references.
  const refs = collectMediaPaths(parsed)
  const mediaIds = [...new Set(refs.map((r) => r.mediaId))]
  await assertMediaAvailable(tx, mediaIds)
  for (const r of refs) {
    await tx.execute(sql`
      INSERT IGNORE INTO media_references (media_id, referent_type, referent_id, field)
      VALUES (${r.mediaId}, 'content_block', ${blockId}, ${r.field})
    `)
  }

  // Audit.
  const createPayload = { kind: AUDIT_KIND.create, data: parsed }
  const serializedLen = JSON.stringify(createPayload).length
  const createDiff =
    serializedLen > AUDIT_DIFF_CAP
      ? { kind: AUDIT_KIND.createTruncated, byteSize: serializedLen }
      : createPayload
  await tx.insert(auditLog).values({
    userId: args.userId,
    action: 'create',
    resourceType: 'content_block',
    resourceId: String(blockId),
    diff: createDiff as unknown as object,
    ip: args.ip,
    userAgent: args.userAgent,
    requestId: args.requestId,
  })

  return { blockId }
}

interface ChatDeleteArgs {
  pageId: number
  op: Extract<ChatChangesetOp, { op: 'delete' }>
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

async function applyChatDeleteOp(
  tx: Tx,
  args: ChatDeleteArgs,
): Promise<{ blockVersion: number }> {
  const [rows] = (await tx.execute(sql`
    SELECT id, page_id, kind, block_type, block_key, data, version
    FROM content_blocks
    WHERE id = ${args.op.blockId}
      AND page_id = ${args.pageId}
      AND deleted_at IS NULL
    FOR UPDATE
  `)) as unknown as [
    Array<{
      id: number
      page_id: number
      kind: BlockKind
      block_type: string
      block_key: string | null
      data: string
      version: number
    }>,
  ]
  const row = rows[0]
  if (!row) throw new NotFoundError()
  if (row.kind !== 'widget') {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  if (row.block_key !== null) {
    // Defence in depth — propose-time gate refuses fixed slots, but
    // a tampered changeset row could have slipped one through.
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  if (row.version !== args.op.expectedBlockVersion) {
    throw new StaleBlockVersionError()
  }
  const newBlockVersion = row.version + 1

  await tx.execute(sql`
    UPDATE content_blocks
    SET deleted_at = NOW(3),
        version = ${newBlockVersion},
        updated_by = ${args.userId}
    WHERE id = ${args.op.blockId}
  `)

  // Drop media references for the soft-deleted widget.
  await tx.execute(sql`
    DELETE FROM media_references
    WHERE referent_type = 'content_block' AND referent_id = ${args.op.blockId}
  `)

  // Audit — same shape as the manual DELETE route's widget branch.
  const auditDiff = {
    kind: AUDIT_KIND.delete,
    block_type: row.block_type,
    version: row.version,
    data_hash: createHash('sha256').update(row.data).digest('hex'),
    byte_size: row.data.length,
  }
  await tx.insert(auditLog).values({
    userId: args.userId,
    action: 'delete',
    resourceType: 'content_block',
    resourceId: String(args.op.blockId),
    diff: auditDiff as unknown as object,
    ip: args.ip,
    userAgent: args.userAgent,
    requestId: args.requestId,
  })

  return { blockVersion: newBlockVersion }
}

interface ChatReorderArgs {
  pageId: number
  op: Extract<ChatChangesetOp, { op: 'reorder' }>
  userId: number
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

async function applyChatReorderOp(
  tx: Tx,
  args: ChatReorderArgs,
): Promise<{
  moves: Array<{
    blockId: number
    blockVersion: number
    parentColumnId: number
    position: number
  }>
}> {
  const moves = args.op.moves
  if (moves.length === 0) {
    throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
  }
  const moveIds = moves.map((m) => m.blockId).sort((a, b) => a - b)
  // Lock all moved rows in PK order. Each must be a kind='widget'
  // row on this page; the parentColumnIds must also be kind='column'
  // rows on this page.
  const [movedRows] = (await tx.execute(sql`
    SELECT id, page_id, parent_id, kind, block_key, block_type, version
    FROM content_blocks
    WHERE id IN (${sql.join(moveIds, sql.raw(','))})
      AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `)) as unknown as [
    Array<{
      id: number
      page_id: number
      parent_id: number | null
      kind: BlockKind
      block_key: string | null
      block_type: string
      version: number
    }>,
  ]
  if (movedRows.length !== moveIds.length) {
    throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
  }
  const movedById = new Map(movedRows.map((r) => [r.id, r]))
  for (const r of movedRows) {
    if (r.page_id !== args.pageId) {
      throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
    }
    if (r.kind !== 'widget') {
      throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
    }
    // PR 4 audit fix (HIGH H1): refuse to move fixed-slot widgets
    // at apply time. The propose-time tool guard also rejects this;
    // defence-in-depth against a tampered ai_proposals.changeset row.
    if (r.block_key !== null) {
      throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
    }
  }
  // PR 4 audit fix (HIGH): assert each move's expectedBlockVersion
  // matches the row's current version. Pre-fix the chat reorder
  // would silently overwrite a concurrent peer edit's version bump
  // with the reorder's own bump+1; no conflict was ever surfaced
  // because reorder doesn't touch the `data` column. Now a concurrent
  // edit forces a 409 stale_block_version the same way `edit` /
  // `delete` ops do.
  for (const m of moves) {
    const row = movedById.get(m.blockId)!
    if (row.version !== m.expectedBlockVersion) {
      throw new StaleBlockVersionError()
    }
  }

  // Lock the destination parent columns (de-duplicated).
  const parentIds = [...new Set(moves.map((m) => m.parentColumnId))].sort(
    (a, b) => a - b,
  )
  if (parentIds.length > 0) {
    const [parentRows] = (await tx.execute(sql`
      SELECT id, kind, page_id
      FROM content_blocks
      WHERE id IN (${sql.join(parentIds, sql.raw(','))})
        AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE
    `)) as unknown as [
      Array<{ id: number; kind: BlockKind; page_id: number }>,
    ]
    if (parentRows.length !== parentIds.length) {
      throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
    }
    for (const p of parentRows) {
      if (p.page_id !== args.pageId) {
        throw new ConflictMarker({ ok: false, reason: 'block_not_found' })
      }
      if (p.kind !== 'column') {
        throw new ConflictMarker({ ok: false, reason: 'validation_failed' })
      }
    }
  }

  // PR 4 audit fix (HIGH H3 + L4): respace the destination columns
  // by interleaving moved widgets with the column's existing
  // siblings. Position collisions are eliminated by re-staging each
  // column's full child order to clean 1000-spaced positions —
  // mirrors the canonical reorder route's batched-UPDATE shape.
  //
  // For each destination parent: read all NON-moved children
  // (FOR UPDATE), splice in the moved widgets at the proposed
  // ordinal, renumber 1000-spaced, write back via CASE-batched
  // UPDATE. Moves that target the SAME destination column with the
  // same ordinal are resolved by submission order (move 0 lands
  // first; move 1 displaces it by one).
  const movesByDest = new Map<number, Array<{ blockId: number; position: number }>>()
  for (const m of moves) {
    const list = movesByDest.get(m.parentColumnId) ?? []
    list.push({ blockId: m.blockId, position: m.position })
    movesByDest.set(m.parentColumnId, list)
  }

  // PR 4 audit fix (MEDIUM): derive source parents from `movedRows`
  // directly — we now SELECT `parent_id` in the initial lock query
  // above, so no second round-trip is needed. The prior approach
  // (separate unlocked SELECT) was a perf regression AND a defensive-
  // logic hole (no page_id filter).
  const sourceParents = new Set<number>()
  for (const r of movedRows) {
    if (r.parent_id !== null) sourceParents.add(r.parent_id)
  }
  // PR 4 audit fix (MEDIUM): iterate affected parents in PK-sorted
  // order so concurrent reorder TXs against overlapping parents
  // acquire FOR UPDATE locks in the SAME order — preserves the
  // canonical pages → movedRows → parent-cols → children PK-asc
  // lock chain and prevents deadlock with sibling reorder calls.
  const affectedParentIds = Array.from(
    new Set<number>([...parentIds, ...sourceParents]),
  ).sort((a, b) => a - b)

  const moveResults: Array<{
    blockId: number
    blockVersion: number
    parentColumnId: number
    position: number
  }> = []

  for (const parentId of affectedParentIds) {
    // All current children of this parent.
    const [children] = (await tx.execute(sql`
      SELECT id, position FROM content_blocks
      WHERE parent_id = ${parentId}
        AND page_id = ${args.pageId}
        AND deleted_at IS NULL
      ORDER BY position, id
      FOR UPDATE
    `)) as unknown as [Array<{ id: number; position: number }>]

    // Filter out blocks that are MOVING AWAY from this parent (they
    // were children here but a move sends them elsewhere).
    const leaving = new Set<number>()
    for (const m of moves) {
      const sourceRow = movedById.get(m.blockId)
      if (
        sourceRow?.parent_id === parentId &&
        m.parentColumnId !== parentId
      ) {
        leaving.add(m.blockId)
      }
    }
    let remaining = children.filter((c) => !leaving.has(c.id))

    // Splice in blocks moving INTO this parent at their proposed
    // ordinal. Blocks already under this parent that are reordering
    // within the column are also re-positioned via this path.
    const incoming = movesByDest.get(parentId) ?? []
    // Drop blocks that are part of `incoming` from `remaining` to
    // avoid duplicating them when we splice.
    const incomingIds = new Set(incoming.map((m) => m.blockId))
    remaining = remaining.filter((c) => !incomingIds.has(c.id))
    const finalOrder: number[] = remaining.map((r) => r.id)
    // Sort incoming by proposed position to make the splice
    // deterministic across multiple moves into the same parent.
    const incomingSorted = [...incoming].sort(
      (a, b) => a.position - b.position,
    )
    for (const m of incomingSorted) {
      const clampedIdx = Math.max(0, Math.min(finalOrder.length, m.position))
      finalOrder.splice(clampedIdx, 0, m.blockId)
    }

    if (finalOrder.length === 0) continue

    // Renumber 1000-spaced via a single batched UPDATE.
    const positionCases = finalOrder.map(
      (id, i) => sql`WHEN ${id} THEN ${(i + 1) * 1000}`,
    )
    const parentCases = finalOrder.map(
      (id) => sql`WHEN ${id} THEN ${parentId}`,
    )
    await tx.execute(sql`
      UPDATE content_blocks
      SET position = CASE id ${sql.join(positionCases, sql.raw(' '))} END,
          parent_id = CASE id ${sql.join(parentCases, sql.raw(' '))} END,
          version = version + 1,
          updated_by = ${args.userId}
      WHERE id IN (${sql.join(finalOrder, sql.raw(','))})
        AND page_id = ${args.pageId}
        AND deleted_at IS NULL
    `)

    // Record results for the moved blocks (existing children that
    // just shifted positions don't surface in the result — the
    // client only needs to know about the AI's proposed moves).
    for (const m of incomingSorted) {
      const idx = finalOrder.indexOf(m.blockId)
      const row = movedById.get(m.blockId)!
      moveResults.push({
        blockId: m.blockId,
        blockVersion: row.version + 1,
        parentColumnId: parentId,
        position: (idx + 1) * 1000,
      })
    }
  }

  // ONE audit row capturing the whole gesture. Group by destination
  // parent so the audit shape matches the canonical reorder route.
  const groups: Array<{ parent_id: number; order: number[] }> = []
  for (const [parent, list] of movesByDest.entries()) {
    groups.push({
      parent_id: parent,
      order: list
        .sort((a, b) => a.position - b.position)
        .map((m) => m.blockId),
    })
  }
  await tx.insert(auditLog).values({
    userId: args.userId,
    action: 'reorder',
    resourceType: 'page',
    resourceId: String(args.pageId),
    diff: {
      kind: AUDIT_KIND.reorder,
      cross_parent: true,
      groups,
    } as unknown as object,
    ip: args.ip,
    userAgent: args.userAgent,
    requestId: args.requestId,
  })

  return { moves: moveResults }
}
