import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { HttpError } from '@/lib/auth/requireRole'
import {
  saveBlock,
  StaleBlockVersionError,
  StalePageVersionError,
  NotFoundError,
} from '@/lib/cms/saveBlock'
import { parseAndSanitize } from '@/lib/cms/parse'
import type { InlineChangesetOp } from './runProposal'

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
      const [rows] = (await tx.execute(sql`
        SELECT id, user_id, status, expires_at
        FROM ai_proposals
        WHERE token = ${args.token}
        FOR UPDATE
      `)) as unknown as [
        Array<{
          id: number
          user_id: number | null
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
        diff: { token: args.token, surface: 'inline' } as unknown as object,
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
