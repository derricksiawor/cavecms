'use client'

import { useCallback, useRef, useState } from 'react'
import {
  runPerRowMutation,
  runPerRowMutationWithReauth,
  type RunPerRowReauthResult,
} from '@/components/admin/AdminTable'

// Hook that encapsulates the repeated "list-of-rows + bulk-mutation"
// dance every admin list client did manually:
//
//   * State for the current row set
//   * Bulk action: run a per-row mutation, then either remove the
//     successful rows from local state OR patch them via an update fn
//   * Per-row mutation: optimistic remove / patch
//
// Each list previously had ~30 lines of `selected.filter(... result
// .failed.some ...).map(s => s.id)` boilerplate; the hook hides it
// behind `bulkRemove` / `bulkUpdate` while leaving the per-list
// mutation logic (which endpoint, what error messages) in the caller
// where it belongs.

interface BulkResult<Row> {
  ok: number
  failed: Array<{ row: Row; reason: string }>
}

export function useListMutations<Row extends { id: number }>(
  initial: Row[],
) {
  const [items, setItems] = useState<Row[]>(initial)

  // Run `fn` across every row in `selected` (concurrency-bounded by
  // runPerRowMutation) and REMOVE the rows whose mutation succeeded
  // from local state. Failed rows remain visible so the operator can
  // retry. Returns the raw result so AdminTable's bulk-bar can surface
  // a per-id failure toast.
  const bulkRemove = useCallback(
    async (
      selected: Row[],
      fn: (row: Row) => Promise<void>,
    ): Promise<BulkResult<Row>> => {
      const result = await runPerRowMutation(selected, fn)
      const failedIds = new Set(result.failed.map((f) => f.row.id))
      const removedIds = new Set(
        selected.filter((s) => !failedIds.has(s.id)).map((s) => s.id),
      )
      setItems((prev) => prev.filter((r) => !removedIds.has(r.id)))
      return result
    },
    [],
  )

  // Run `fn` across every row in `selected` and PATCH the rows whose
  // mutation succeeded by replacing them with `update(row)`. Used by
  // bulk-disable / bulk-allow on the users list where the row stays
  // visible but its `active` flag flips.
  const bulkUpdate = useCallback(
    async (
      selected: Row[],
      fn: (row: Row) => Promise<void>,
      update: (row: Row) => Row,
    ): Promise<BulkResult<Row>> => {
      const result = await runPerRowMutation(selected, fn)
      const failedIds = new Set(result.failed.map((f) => f.row.id))
      const changedIds = new Set(
        selected.filter((s) => !failedIds.has(s.id)).map((s) => s.id),
      )
      setItems((prev) =>
        prev.map((r) => (changedIds.has(r.id) ? update(r) : r)),
      )
      return result
    },
    [],
  )

  // Optimistically remove a single row by id. Caller is responsible
  // for awaiting the server mutation first.
  const removeRow = useCallback((id: number) => {
    setItems((prev) => prev.filter((r) => r.id !== id))
  }, [])

  // Optimistically patch a single row by id.
  const updateRow = useCallback(
    (id: number, update: (row: Row) => Row) => {
      setItems((prev) => prev.map((r) => (r.id === id ? update(r) : r)))
    },
    [],
  )

  // Bulk-once reauth state machine (spec §4.0). The AbortController is
  // held in a ref so `bulkReauthAbort` can cancel the in-flight burst
  // from outside the bulk call site (e.g. when the operator clicks
  // "Cancel" on the reauth modal that pops mid-burst). The ref is
  // reassigned on each call to bulkRemoveWithReauth so a stale
  // controller from a prior burst doesn't leak.
  const reauthControllerRef = useRef<AbortController | null>(null)

  const bulkReauthAbort = useCallback(() => {
    reauthControllerRef.current?.abort()
  }, [])

  // Bulk remove with mid-burst reauth pause. `mutate` returns the raw
  // Response; the helper inspects status to differentiate reauth-
  // required (401) from other errors. `onReauth` is the FE's promise
  // that resolves once the operator has either re-entered their
  // password OR cancelled the modal — typically wired to a step-up
  // reauth modal that calls `/api/auth/reauth` then returns 'fresh'
  // or 'aborted'.
  const bulkRemoveWithReauth = useCallback(
    async (
      selected: Row[],
      mutate: (row: Row, signal: AbortSignal) => Promise<Response>,
      onReauth: () => Promise<'fresh' | 'aborted'>,
    ): Promise<RunPerRowReauthResult<Row>> => {
      const controller = new AbortController()
      reauthControllerRef.current = controller

      try {
        // PRE-BURST freshness check (spec §4.0 bulk-once contract).
        // The helper handles this rather than each consumer so a future
        // consumer that forgets to call ensureReauth before the bulk
        // can't mass-401 N rows before the modal pops. Mid-burst 401
        // path below re-invokes the same callback.
        const preBurst = await onReauth()
        if (preBurst === 'aborted') {
          return {
            succeeded: [],
            failed: [],
            abort: true,
            completed: 0,
            total: selected.length,
          }
        }
        const result = await runPerRowMutationWithReauth({
          rows: selected,
          signal: controller.signal,
          mutate,
          onRow401: async (failedIndex) => {
            const outcome = await onReauth()
            if (outcome === 'aborted') {
              controller.abort()
              return {
                abort: true,
                completed: failedIndex,
                total: selected.length,
              }
            }
            return { abort: false }
          },
        })

        // Optimistic remove for the rows that succeeded. Matches the
        // bulkRemove pattern — failed rows stay visible for retry,
        // aborted burst leaves the remaining rows in place too.
        const succeededIds = new Set(result.succeeded.map((r) => r.id))
        setItems((prev) => prev.filter((r) => !succeededIds.has(r.id)))
        return result
      } finally {
        // Always clear so a stale controller from a prior burst can't
        // be aborted accidentally on a later call.
        if (reauthControllerRef.current === controller) {
          reauthControllerRef.current = null
        }
      }
    },
    [],
  )

  return {
    items,
    setItems,
    bulkRemove,
    bulkUpdate,
    bulkRemoveWithReauth,
    bulkReauthAbort,
    removeRow,
    updateRow,
  }
}
