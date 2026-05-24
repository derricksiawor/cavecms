'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { PillButton } from '@/components/admin/PillButton'
import { StatusBadge } from '@/components/admin/StatusBadge'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'

// Active-posts client. Wraps AdminTable so /admin/blog gets the full
// sort + paginate + select + bulk treatment alongside per-row
// Move-to-Trash with a ConfirmModal gate.
//
// Server passes the initial row set. After any mutation (per-row or
// bulk) we call router.refresh() via AdminTable's onRefresh path so
// the page re-fetches and the trashed-count link updates.

export interface PostRow {
  id: number
  slug: string
  title: string
  published: number
  published_at: Date | string | null
  updated_at: Date | string
}

export function PostsClient({
  initial,
  emptyState,
}: {
  initial: PostRow[]
  emptyState: React.ReactNode
}) {
  const toast = useToast()
  const router = useRouter()
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const {
    items: rows,
    bulkRemove,
    removeRow,
  } = useListMutations<PostRow>(initial)

  // mysql2 hands TIMESTAMP back as a Date | string. Guard NaN so a
  // corrupted timestamp ('0000-00-00 00:00:00' etc.) tail-sorts like
  // a real null instead of polluting the string-fallback branch.
  const toEpoch = (v: Date | string | null): number | null => {
    if (v === null) return null
    const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
    return Number.isFinite(ms) ? ms : null
  }

  // Sentinel error message so the bulk path can distinguish "row
  // was already gone (someone else trashed it)" from genuine failures
  // and dedupe the reason into a clean success-flavoured toast.
  const ALREADY_REMOVED = 'Already removed.'

  const deletePost = async (id: number): Promise<void> => {
    const r = await csrfFetch(`/api/cms/posts/${id}`, { method: 'DELETE' })
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(
        j.error === 'not_found' ? ALREADY_REMOVED : `Failed (${r.status})`,
      )
    }
  }

  const onConfirmDelete = async () => {
    if (pendingDeleteId === null) return
    setDeleting(true)
    try {
      await deletePost(pendingDeleteId)
      removeRow(pendingDeleteId)
      toast.success('Moved to Trash.')
    } catch (e) {
      // "Already removed" is a benign race (another tab trashed it).
      // Treat as success — local state is already correct.
      const msg = e instanceof Error ? e.message : 'Delete failed.'
      if (msg === ALREADY_REMOVED) {
        removeRow(pendingDeleteId)
        toast.success('Moved to Trash.')
      } else {
        toast.error(msg)
      }
    } finally {
      setDeleting(false)
      setPendingDeleteId(null)
    }
  }

  const columns: AdminTableColumn<PostRow>[] = useMemo(() => [
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      sortAccessor: (r) => r.title.toLowerCase(),
      cell: (r) => (
        <Link
          href={`/admin/blog/${r.id}`}
          className="font-medium text-near-black underline-offset-2 hover:underline"
        >
          {r.title}
        </Link>
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
      key: 'published',
      label: 'Status',
      sortable: true,
      sortAccessor: (r) => (r.published ? 1 : 0),
      cell: (r) =>
        r.published ? (
          <StatusBadge tone="live">Live</StatusBadge>
        ) : (
          <StatusBadge tone="draft">Draft</StatusBadge>
        ),
    },
    {
      key: 'updated_at',
      label: 'Last edited',
      sortable: true,
      sortAccessor: (r) => toEpoch(r.updated_at),
      cell: (r) => (
        <span className="text-xs text-warm-stone">
          {new Date(r.updated_at).toISOString().slice(0, 10)}
        </span>
      ),
    },
  ], [])

  const bulkActions: AdminTableBulkAction<PostRow>[] = useMemo(() => [
    {
      id: 'trash',
      label: (n) => `Move ${n} to Trash`,
      icon: Trash2,
      destructive: true,
      confirm: {
        title: 'Move to Trash?',
        description: (n) =>
          `${n} ${n === 1 ? 'post' : 'posts'} will be hidden from the public blog and held in Trash for 30 days. You can restore at any time.`,
        confirmLabel: 'Move to Trash',
      },
      run: async (selected) => {
        const result = await bulkRemove(selected, async (row) => {
          const r = await csrfFetch(`/api/cms/posts/${row.id}`, {
            method: 'DELETE',
          })
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string }
            throw new Error(j.error ?? `Failed (${r.status})`)
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
      <AdminTable<PostRow>
        rows={rows}
        getId={(r) => r.id}
        columns={columns}
        bulkActions={bulkActions}
        rowActions={(r) => (
          <PillButton
            onClick={() => setPendingDeleteId(r.id)}
            disabled={deleting}
            ariaLabel={`Move ${r.title} to Trash`}
            icon={Trash2}
            variant="subtle"
          >
            Trash
          </PillButton>
        )}
        mobileRowHeader={(r) => (
          <Link
            href={`/admin/blog/${r.id}`}
            className="text-base font-semibold text-near-black underline-offset-2 hover:underline"
          >
            {r.title}
          </Link>
        )}
        emptyState={emptyState}
        defaultSort={{ column: 'updated_at', direction: 'desc' }}
      />
      <ConfirmModal
        open={pendingDeleteId !== null}
        title="Move this post to Trash?"
        description="It will be hidden from the public blog and held in Trash for 30 days. You can restore it at any time."
        confirmLabel="Move to Trash"
        destructive
        busy={deleting}
        onConfirm={onConfirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDeleteId(null)
        }}
      />
    </>
  )
}
