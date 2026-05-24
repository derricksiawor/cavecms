'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2, Undo2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import { EmptyState } from '@/components/inline-edit/EmptyState'
import { PillButton } from '@/components/admin/PillButton'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'

interface Row {
  id: number
  block_type: string
  deleted_at: Date | string
  page_slug: string
  page_title: string | null
}

const toEpoch = (v: Date | string): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isFinite(ms) ? ms : 0
}

// Soft-deleted content blocks within the 30-day recovery window.
// Per-row + bulk Restore. After 30 days a future cron purge takes
// over and the row stops being recoverable.

export function TrashClient({ initial }: { initial: Row[] }) {
  const toast = useToast()
  const router = useRouter()
  const { items, bulkRemove, removeRow } = useListMutations<Row>(initial)
  const [busy, setBusy] = useState<number | null>(null)

  async function restoreOne(row: Row): Promise<void> {
    const res = await csrfFetch(`/api/cms/blocks/${row.id}/restore`, {
      method: 'POST',
    })
    if (res.status === 409) {
      throw new Error(
        "Setup changed since it was deleted — an admin will need to help.",
      )
    }
    if (!res.ok) throw new Error(`Restore failed (${res.status})`)
  }

  async function restoreFromRow(row: Row) {
    if (busy !== null) return
    setBusy(row.id)
    try {
      await restoreOne(row)
      removeRow(row.id)
      toast.success('Restored.')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed.')
    } finally {
      setBusy(null)
    }
  }

  const columns: AdminTableColumn<Row>[] = useMemo(() => [
    {
      key: 'block_type',
      label: 'Section',
      sortable: true,
      sortAccessor: (r) => r.block_type,
      cell: (r) => (
        <span className="text-xs font-medium text-near-black">
          {r.block_type.replace(/_/g, ' ')}
        </span>
      ),
    },
    {
      key: 'page',
      label: 'From page',
      sortable: true,
      sortAccessor: (r) => (r.page_title ?? r.page_slug).toLowerCase(),
      cell: (r) => (
        <span className="text-xs text-warm-stone">
          {r.page_title ?? r.page_slug}
        </span>
      ),
    },
    {
      key: 'deleted_at',
      label: 'Moved to Trash',
      sortable: true,
      sortAccessor: (r) => toEpoch(r.deleted_at),
      cell: (r) => (
        <span className="text-xs text-warm-stone">
          {new Date(r.deleted_at).toISOString().slice(0, 10)}
        </span>
      ),
    },
  ], [])

   
  const bulkActions: AdminTableBulkAction<Row>[] = useMemo(() => [
    {
      id: 'restore',
      label: (n) => `Restore ${n}`,
      icon: Undo2,
      run: async (selected) =>
        bulkRemove(selected, async (row) => {
          await restoreOne(row)
        }),
    },
  ], [bulkRemove])

  return (
    <section className="mt-10">
      <AdminTable<Row>
        rows={items}
        getId={(r) => r.id}
        columns={columns}
        bulkActions={bulkActions}
        rowActions={(r) => (
          <PillButton
            onClick={() => restoreFromRow(r)}
            disabled={busy === r.id}
            icon={Undo2}
            variant="subtle"
          >
            {busy === r.id ? 'Restoring…' : 'Restore'}
          </PillButton>
        )}
        mobileRowHeader={(r) => (
          <span className="text-base font-semibold text-near-black">
            {r.block_type.replace(/_/g, ' ')}
          </span>
        )}
        emptyState={
          <EmptyState
            icon={Trash2}
            title="Trash is empty"
            description="Anything you delete from a page lives here for 30 days. Restore it any time within that window, or let it clean up on its own."
          />
        }
        defaultSort={{ column: 'deleted_at', direction: 'desc' }}
      />
    </section>
  )
}
