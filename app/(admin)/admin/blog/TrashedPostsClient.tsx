'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Undo2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import { PillButton } from '@/components/admin/PillButton'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'
import { EmptyState } from '@/components/inline-edit/EmptyState'
import { Trash2 } from 'lucide-react'

// Trashed-posts client. Restore button calls POST
// /api/cms/posts/[id]/restore — on success removes the row from local
// state + toasts. 409 slug_taken means another post claimed the slug
// while this one sat in trash; surface that in plain English so the
// operator knows to rename one of them.

interface Row {
  id: number
  slug: string
  title: string
  deleted_at: Date | string
}

const toEpoch = (v: Date | string): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isFinite(ms) ? ms : 0
}

export function TrashedPostsClient({ initial }: { initial: Row[] }) {
  const toast = useToast()
  const router = useRouter()
  const {
    items: rows,
    bulkRemove,
    removeRow,
  } = useListMutations<Row>(initial)
  const [busy, setBusy] = useState<number | null>(null)

  const restoreOne = async (row: Row): Promise<void> => {
    const r = await csrfFetch(`/api/cms/posts/${row.id}/restore`, {
      method: 'POST',
    })
    if (r.status === 409) {
      throw new Error(
        `Another post is using /blog/${row.slug}. Rename one of them first.`,
      )
    }
    if (!r.ok) {
      throw new Error(`Restore failed (${r.status})`)
    }
  }

  const restoreFromRow = async (row: Row) => {
    if (busy !== null) return
    setBusy(row.id)
    try {
      await restoreOne(row)
      removeRow(row.id)
      toast.success('Post restored as a draft.')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed.')
    } finally {
      setBusy(null)
    }
  }

  const columns: AdminTableColumn<Row>[] = useMemo(() => [
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      sortAccessor: (r) => r.title.toLowerCase(),
      cell: (r) => (
        <span className="font-medium text-near-black">{r.title}</span>
      ),
    },
    {
      key: 'slug',
      label: 'Web address',
      sortable: true,
      sortAccessor: (r) => r.slug,
      cell: (r) => (
        <span className="text-xs text-warm-stone font-mono">/blog/{r.slug}</span>
      ),
      hideOnMobile: true,
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
      run: async (selected) => {
        const result = await bulkRemove(selected, async (row) => {
          const r = await csrfFetch(`/api/cms/posts/${row.id}/restore`, {
            method: 'POST',
          })
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string }
            throw new Error(j.error ?? `Restore failed (${r.status})`)
          }
        })
        router.refresh()
        return result
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [bulkRemove])

  return (
    <>
    <AdminTable<Row>
      rows={rows}
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
          {r.title}
        </span>
      )}
      emptyState={
        <EmptyState
          icon={Trash2}
          title="Trash is empty"
          description="Posts you delete will show up here for 30 days so you can restore them."
        />
      }
      defaultSort={{ column: 'deleted_at', direction: 'desc' }}
      urlKey="trash"
    />
    </>
  )
}
