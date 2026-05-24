// Shared types + pure helpers for the AdminTable family. Lives here so
// subcomponents and consumers can import the contract without pulling
// the full table render path.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export type SortDirection = 'asc' | 'desc'
export type AdminTableSort =
  | { column: string; direction: SortDirection }
  | null

export interface AdminTableColumn<Row> {
  key: string
  label: string
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  cell: (row: Row) => ReactNode
  /** Hide the column when the viewport is narrower than `md` (768px). */
  hideOnMobile?: boolean
  /** Hide the column when the viewport is narrower than `lg` (1024px). */
  hideBelowLg?: boolean
  /** Skip this column when rendering the mobile-card metadata list.
   *  Useful for interactive cells (role pickers, switches) that already
   *  surface elsewhere via `rowActions`. */
  mobileCardHide?: boolean
  width?: string
  sortAccessor?: (row: Row) => string | number | Date | null | undefined
}

export interface AdminTableBulkAction<Row> {
  id: string
  label: (count: number) => string
  icon?: LucideIcon
  destructive?: boolean
  confirm?: {
    title: string
    description: (count: number) => string
    confirmLabel?: string
  }
  run: (
    selected: Row[],
  ) => Promise<{ ok: number; failed: Array<{ row: Row; reason: string }> }>
}

// Page-slot list with ellipses for big sets — up to 7 visible slots.
export function computePageRange(
  current: number,
  total: number,
): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const slots: Array<number | '…'> = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) slots.push('…')
  for (let p = left; p <= right; p++) slots.push(p)
  if (right < total - 1) slots.push('…')
  slots.push(total)
  return slots
}

// Run a per-row mutation across a selection with a bounded concurrency
// (default 4). Returns counts of successes and per-row failure reasons.
// Chunked-batch via Promise.allSettled — predictable order, idiomatic.
//
// Companion helper for reauth-gated bulk ops lives below as
// `runPerRowMutationWithReauth` (concurrency=1, sequential,
// interruptible). The two helpers have fundamentally different control
// flow (chunked Promise.allSettled vs sequential with mid-burst pause
// hook); unifying them would gate the concurrent path on
// `concurrency===1 && onRow401` which is a worse architectural smell
// than the duplication. Spec §14 rationale.
export async function runPerRowMutation<Row>(
  rows: Row[],
  fn: (row: Row) => Promise<void>,
  options: {
    concurrency?: number
    reasonForError?: (e: unknown, row: Row) => string
  } = {},
): Promise<{ ok: number; failed: Array<{ row: Row; reason: string }> }> {
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const reasonFor =
    options.reasonForError ??
    ((e: unknown) => (e instanceof Error ? e.message : 'Unknown error'))
  let ok = 0
  const failed: Array<{ row: Row; reason: string }> = []
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency)
    const settled = await Promise.allSettled(batch.map((r) => fn(r)))
    settled.forEach((res, j) => {
      const row = batch[j]
      if (row === undefined) return
      if (res.status === 'fulfilled') ok++
      else failed.push({ row, reason: reasonFor(res.reason, row) })
    })
  }
  return { ok, failed }
}

// Reauth-gated bulk mutation (spec §4.0). Sequential — concurrency=1 —
// because mid-burst 401 must pause cleanly: at concurrency>1 sibling
// in-flight requests would race the reauth modal and either burn or
// 401-out one-by-one. Sequential wall-clock at 50 rows × ~80-120ms is
// ~4-6s, acceptable for a destructive operation already gated behind
// a step-up reauth modal.
//
// Companion helper `runPerRowMutation` above handles non-reauth bulk
// ops (concurrency=4, chunked Promise.allSettled, fire-and-forget).
// See spec §14 for the duplication rationale — unifying the two would
// gate the concurrent path on a `concurrency===1 && onRow401` branch
// that conditionally rewrites the loop, a worse architectural smell
// than the duplication.
//
// Contract (locked by spec):
//   - mutate(row, signal) returns the raw Response.
//   - The helper inspects response.status:
//       * 401 → invoke onRow401(failedIndex); on { abort: false } RETRY
//         the same row (NOT skip). Sequential concurrency=1 makes the
//         failed-index row unambiguous.
//       * other non-2xx → recorded under result.failed[]; no pause.
//       * 2xx → recorded under result.succeeded[].
//   - Thrown errors (network failure) count as per-row failures; same
//     as non-2xx, no pause.
//   - AbortError from a cancelled fetch halts the burst without
//     recording further results — used by `bulkReauthAbort()` to
//     short-circuit when the operator cancels the reauth modal.
//   - Multiple mid-burst reauths are supported: each onRow401 re-enters
//     ensureFreshReauthOrPrompt; resume index advances independently.
export interface RunPerRowReauthArgs<Row> {
  rows: Row[]
  signal: AbortSignal
  mutate: (row: Row, signal: AbortSignal) => Promise<Response>
  /** Called when a row returns 401. Returns either:
   *  - { abort: true, ... } to halt the burst (operator cancelled
   *    reauth modal); the helper records {abort:true, completed, total}
   *    and stops without retrying.
   *  - { abort: false } to resume from the failing index (retry the
   *    same row under the new reauth window). */
  onRow401: (
    failedIndex: number,
  ) => Promise<
    | { abort: true; completed: number; total: number }
    | { abort: false }
  >
  /** Defaults to err.message for Error, "Unknown error" otherwise. */
  reasonForError?: (e: unknown, row: Row) => string
}

export interface RunPerRowReauthResult<Row> {
  succeeded: Row[]
  failed: Array<{ row: Row; reason: string }>
  /** True iff onRow401 returned { abort: true }. When true, `completed`
   *  and `total` carry the abort frame; the FE's bulk-bar uses them
   *  for the partial-completion toast ("N of M completed, M-N cancelled"). */
  abort: boolean
  completed: number
  total: number
}

export async function runPerRowMutationWithReauth<Row>(
  args: RunPerRowReauthArgs<Row>,
): Promise<RunPerRowReauthResult<Row>> {
  const { rows, signal, mutate, onRow401 } = args
  const reasonFor =
    args.reasonForError ??
    ((e: unknown) => (e instanceof Error ? e.message : 'Unknown error'))
  const succeeded: Row[] = []
  const failed: Array<{ row: Row; reason: string }> = []
  const total = rows.length

  let i = 0
  // Per-row retry counter for 401 hot-loop protection. If onRow401
  // returns 'fresh' but the server keeps 401ing the same row (e.g.
  // because tokens_valid_after was bumped by another admin DURING
  // this burst, invalidating every fresh reauth), we'd otherwise
  // loop indefinitely. Cap retries per index so the burst fails
  // forward with a clear `reauth_loop` reason.
  let retriesAtIndex = 0
  const MAX_RETRIES_PER_ROW = 2

  while (i < total) {
    const row = rows[i]!

    // External abort (e.g. bulkReauthAbort()) halts the burst before
    // we even fire this row.
    if (signal.aborted) {
      return {
        succeeded,
        failed,
        abort: true,
        completed: i,
        total,
      }
    }

    let res: Response
    try {
      res = await mutate(row, signal)
    } catch (e) {
      // AbortError is the cooperative cancel path — halt without
      // recording. Some runtimes emit AbortError as a plain Error
      // (Node 18 native fetch historically did this, plus test
      // runners that shim the abort behavior); check by NAME as
      // well as DOMException-instance to cover both. Belt+braces:
      // `signal.aborted` post-throw is the source of truth either way.
      const isAbort =
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError') ||
        signal.aborted
      if (isAbort) {
        return {
          succeeded,
          failed,
          abort: true,
          completed: i,
          total,
        }
      }
      failed.push({ row, reason: reasonFor(e, row) })
      i++
      retriesAtIndex = 0
      continue
    }

    // Re-check abort AFTER mutate resolves — controller.abort() may
    // have fired while the fetch was in flight. Without this, a row's
    // response is processed AFTER the operator cancelled the modal,
    // polluting the abort frame with one extra recorded result.
    if (signal.aborted) {
      return {
        succeeded,
        failed,
        abort: true,
        completed: i,
        total,
      }
    }

    if (res.status === 401) {
      if (retriesAtIndex >= MAX_RETRIES_PER_ROW) {
        // Server keeps 401ing this row despite successful reauths —
        // record as a per-row failure and advance so the rest of the
        // burst proceeds. Operator gets a distinct `reauth_loop`
        // reason in the bulk-bar's per-row failure list.
        failed.push({ row, reason: 'reauth_loop' })
        i++
        retriesAtIndex = 0
        continue
      }
      const decision = await onRow401(i)
      if (decision.abort) {
        return {
          succeeded,
          failed,
          abort: true,
          completed: decision.completed,
          total: decision.total,
        }
      }
      // Resume — retry the same row under the new reauth window.
      retriesAtIndex++
      continue
    }

    if (res.ok) {
      succeeded.push(row)
      i++
      retriesAtIndex = 0
      continue
    }

    // Non-2xx, non-401: record reason if available, no pause.
    let reason = `HTTP ${res.status}`
    try {
      const body = (await res.clone().json()) as { error?: unknown }
      if (typeof body?.error === 'string') reason = body.error
    } catch {
      // Non-JSON body — fall through to the HTTP-status reason.
    }
    failed.push({ row, reason })
    i++
    retriesAtIndex = 0
  }

  return {
    succeeded,
    failed,
    abort: false,
    completed: total,
    total,
  }
}

// Convenience helper: given the result of a bulk mutation, return a
// new rows array with the successful rows removed. Used by callers
// that want to manage their own state outside `useListMutations`.
export function applyBulkRemoval<Row>(
  rows: Row[],
  selected: Row[],
  failed: Array<{ row: Row; reason: string }>,
  getId: (row: Row) => string | number,
): Row[] {
  const failedIds = new Set(failed.map((f) => getId(f.row)))
  const removedIds = new Set(
    selected.filter((s) => !failedIds.has(getId(s))).map((s) => getId(s)),
  )
  return rows.filter((r) => !removedIds.has(getId(r)))
}
