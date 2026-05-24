'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Undo2, Trash2 } from 'lucide-react'
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

// Trashed-pages client. Restore is admin-only per spec §4.5; the
// password step-up was removed (it was the wrong gate for routine
// content ops). 409 slug_taken surfaces a rename modal with a
// pre-filled asSlug suggestion per spec §3.3 + §11 step 24
// stolen-slug recovery flow.

export interface TrashedPageRow {
  id: number
  slug: string
  title: string
  deleted_at: Date | string
  url_path: string | null
  is_home: number
  system: number
  updated_by_email: string | null
}

const toEpoch = (v: Date | string): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isFinite(ms) ? ms : 0
}

function shortHash(): string {
  // 8 hex chars from Math.random — good enough for a stolen-slug
  // suggestion that the operator can edit before confirming. Not
  // security-bearing; collisions are tolerated (operator picks a new
  // suggestion if the first one collides).
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(0, 8)
}

export function TrashedPagesClient({
  initial,
  canRestore,
}: {
  initial: TrashedPageRow[]
  canRestore: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const {
    items: rows,
    bulkRemove,
    removeRow,
  } = useListMutations<TrashedPageRow>(initial)

  const [busyRowId, setBusyRowId] = useState<number | null>(null)
  // Stolen-slug rename modal state. When a single-row restore comes
  // back with 409 slug_taken, we surface this lightweight inline
  // modal to let the operator pick an override slug.
  const [renameFor, setRenameFor] = useState<TrashedPageRow | null>(null)
  const [renameSlug, setRenameSlug] = useState('')

  const restoreOne = async (
    row: TrashedPageRow,
    asSlug?: string,
  ): Promise<'ok' | 'stolen'> => {
    const body = asSlug ? { asSlug } : {}
    const r = await csrfFetch(`/api/cms/pages/${row.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.status === 409) {
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      if (j.error === 'slug_taken' && !asSlug) return 'stolen'
      throw new Error(
        j.error === 'slug_taken'
          ? `That web address is already in use. Pick a different one.`
          : j.error ?? `Restore failed (${r.status})`,
      )
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(j.error ?? `Restore failed (${r.status})`)
    }
    return 'ok'
  }

  const restoreFromRow = async (row: TrashedPageRow, asSlug?: string) => {
    if (busyRowId !== null) return
    setBusyRowId(row.id)
    try {
      const outcome = await restoreOne(row, asSlug)
      if (outcome === 'stolen') {
        // First attempt without asSlug surfaced 409 slug_taken; open
        // the rename modal with a pre-filled suggestion.
        setRenameSlug(`${row.slug}-restored-${shortHash()}`)
        setRenameFor(row)
        return
      }
      removeRow(row.id)
      toast.success(
        asSlug
          ? `Restored at /${asSlug} as a draft.`
          : 'Restored as a draft.',
      )
      setRenameFor(null)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed.')
    } finally {
      setBusyRowId(null)
    }
  }

  const columns: AdminTableColumn<TrashedPageRow>[] = useMemo(
    () => [
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
        key: 'url_path',
        label: 'Web address',
        sortable: true,
        sortAccessor: (r) => r.url_path ?? `/${r.slug}`,
        cell: (r) => (
          <code className="text-xs text-warm-stone font-mono">
            {r.url_path ?? `/${r.slug}`}
          </code>
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
      {
        key: 'updated_by_email',
        label: 'Updated by',
        sortable: false,
        cell: (r) => (
          <span className="text-xs text-warm-stone">
            {r.updated_by_email ?? '—'}
          </span>
        ),
        hideOnMobile: true,
      },
    ],
    [],
  )

  const bulkActions: AdminTableBulkAction<TrashedPageRow>[] = useMemo(() => {
    if (!canRestore) return []
    return [
      {
        id: 'restore',
        label: (n) => `Restore ${n}`,
        icon: Undo2,
        run: async (selected) => {
          const result = await bulkRemove(selected, async (row) => {
            const r = await csrfFetch(`/api/cms/pages/${row.id}/restore`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
            if (!r.ok) {
              const j = (await r.json().catch(() => ({}))) as { error?: string }
              throw new Error(j.error ?? `Restore failed (${r.status})`)
            }
          })
          if (result.ok > 0) {
            toast.success(
              `${result.ok} ${result.ok === 1 ? 'page' : 'pages'} restored as drafts.`,
            )
          }
          router.refresh()
          return result
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRestore, bulkRemove])

  return (
    <>
      <AdminTable<TrashedPageRow>
        rows={rows}
        getId={(r) => r.id}
        columns={columns}
        bulkActions={bulkActions}
        rowActions={(r) =>
          canRestore ? (
            <PillButton
              onClick={() => void restoreFromRow(r)}
              disabled={busyRowId === r.id}
              icon={Undo2}
              variant="subtle"
            >
              {busyRowId === r.id ? 'Restoring…' : 'Restore'}
            </PillButton>
          ) : null
        }
        mobileRowHeader={(r) => (
          <span className="text-base font-semibold text-near-black">
            {r.title}
          </span>
        )}
        emptyState={
          <EmptyState
            icon={Trash2}
            title="Trash is empty"
            description="Pages you delete will show up here for 30 days so you can restore them."
          />
        }
        defaultSort={{ column: 'deleted_at', direction: 'desc' }}
        urlKey="trash"
      />
      {/* Stolen-slug rename modal. Lightweight; uses the existing
          ConfirmModal pattern's visual language without pulling in
          the actual ConfirmModal (which doesn't expose a form input). */}
      {renameFor !== null && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setRenameFor(null)}
            className="fixed inset-0 z-40 cursor-default bg-black/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-warm-stone/20 bg-cream-50 p-8 shadow-2xl"
          >
            <p className="font-serif text-xl font-bold tracking-tight text-near-black">
              That web address is taken
            </p>
            <p className="mt-2 text-sm text-warm-stone">
              Another live page is using /{renameFor.slug}. Restore this
              page under a different web address — you can rename it
              again later from the editor.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!renameSlug) return
                void restoreFromRow(renameFor, renameSlug)
              }}
              className="mt-6"
            >
              <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                New web address
                <input
                  type="text"
                  value={renameSlug}
                  onChange={(e) => setRenameSlug(e.target.value)}
                  className="mt-2 block w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black focus:border-copper-400 focus:outline-none font-mono"
                />
              </label>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setRenameFor(null)}
                  className="rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!renameSlug || busyRowId === renameFor.id}
                  className="rounded-lg bg-near-black px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 transition-colors hover:bg-copper-700 disabled:opacity-50"
                >
                  {busyRowId === renameFor.id ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </>
  )
}
