'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  PenLine,
  Eye,
  EyeOff,
  ExternalLink,
  Trash2,
  Home,
  Search,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { RowActionsMenu, type RowActionItem } from '@/components/admin/RowActionsMenu'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'
import type { Role } from '@/lib/auth/requireRole'

// Row shape for the active pages list. is_home/system/published are
// raw TINYINT(1) from MariaDB (0/1) per the codebase's raw-SQL
// convention; the client treats them as truthy numbers, not booleans.
export interface PageListRow {
  id: number
  slug: string
  title: string
  is_home: number
  system: number
  published: number
  published_at: Date | string | null
  updated_at: Date | string
  url_path: string | null
  version: number
  updated_by_email: string | null
}

// PagesClient — active list. Wraps AdminTable with the full row-action
// kebab (Open editor / Publish toggle / Preview / Move to Trash) plus
// bulk Move-to-Trash that hoists a step-up reauth modal ONCE for the
// whole burst (spec §4.0 bulk-once reauth state machine).
//
// Role gating mirrors the API:
//   - admin: all actions visible.
//   - editor: Open editor + Preview only.
//   - viewer: never reaches this client (server-side 404).

const toEpoch = (v: Date | string | null): number | null => {
  if (v === null) return null
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isFinite(ms) ? ms : null
}

export function PagesClient({
  initial,
  role,
  emptyState,
}: {
  initial: PageListRow[]
  role: Role
  emptyState: React.ReactNode
}) {
  const toast = useToast()
  const router = useRouter()
  const isAdmin = role === 'admin'

  const {
    items: rows,
    bulkRemove,
    removeRow,
    updateRow,
  } = useListMutations<PageListRow>(initial)

  // Client-side filters. Lightweight by design — server-side filtering
  // is a separate paginated endpoint and would defeat the bulk-select
  // UX (only loaded rows are selectable). Below ~200 pages the client
  // filter is instant; above that, the operator scrolls into pagination
  // before hitting it. Status chips + free-text search compose:
  //   - "" + "all"     → all rows (default)
  //   - "process" + "draft" → live drafts whose title/slug match
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'live' | 'draft'>('all')

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter === 'live' && r.published !== 1) return false
      if (statusFilter === 'draft' && r.published === 1) return false
      if (q.length === 0) return true
      const t = r.title.toLowerCase()
      const s = (r.url_path ?? r.slug).toLowerCase()
      return t.includes(q) || s.includes(q)
    })
  }, [rows, search, statusFilter])

  const liveCount = useMemo(() => rows.filter((r) => r.published === 1).length, [rows])
  const draftCount = rows.length - liveCount

  const [pendingDeleteRow, setPendingDeleteRow] = useState<PageListRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [busyRowId, setBusyRowId] = useState<number | null>(null)

  // ──────────────────────────────────────────────────────────────────
  // Single-row delete (kebab → confirm → DELETE).
  // ──────────────────────────────────────────────────────────────────
  const onConfirmDelete = async () => {
    if (!pendingDeleteRow) return
    const row = pendingDeleteRow
    setDeleting(true)
    try {
      const r = await csrfFetch(`/api/cms/pages/${row.id}`, { method: 'DELETE' })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `Failed (${r.status})`)
      }
      removeRow(row.id)
      toast.success('Moved to Trash.')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed.')
    } finally {
      setDeleting(false)
      setPendingDeleteRow(null)
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Publish toggle (admin only).
  // ──────────────────────────────────────────────────────────────────
  const togglePublish = async (row: PageListRow): Promise<void> => {
    setBusyRowId(row.id)
    try {
      const target = row.published === 1 ? false : true
      const r = await csrfFetch(`/api/cms/pages/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: row.version, published: target }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `Failed (${r.status})`)
      }
      const j = (await r.json()) as { version: number }
      updateRow(row.id, (prev) => ({
        ...prev,
        published: target ? 1 : 0,
        version: j.version,
      }))
      toast.success(target ? 'Page is live.' : 'Page hidden from public site.')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That didn’t save.')
    } finally {
      setBusyRowId(null)
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Open public or mint preview token + open. Lazy-mints on click.
  // ──────────────────────────────────────────────────────────────────
  const openPublic = async (row: PageListRow) => {
    const publicUrl = row.url_path ?? `/${row.slug}`
    if (row.published === 1) {
      window.open(publicUrl, '_blank', 'noopener')
      return
    }
    setBusyRowId(row.id)
    try {
      const r = await csrfFetch(`/api/cms/pages/${row.id}/preview-token`, {
        method: 'POST',
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? 'Couldn’t mint preview link.')
      }
      const j = (await r.json()) as { token: string }
      window.open(
        `${publicUrl}?preview=${encodeURIComponent(j.token)}`,
        '_blank',
        'noopener',
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview link unavailable.')
    } finally {
      setBusyRowId(null)
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Columns.
  // ──────────────────────────────────────────────────────────────────
  const columns: AdminTableColumn<PageListRow>[] = useMemo(
    () => [
      {
        key: 'title',
        label: 'Title',
        sortable: true,
        sortAccessor: (r) => r.title.toLowerCase(),
        cell: (r) => (
          <span className="flex items-center gap-2">
            {r.is_home === 1 && (
              <Home
                size={13}
                strokeWidth={2}
                className="text-copper-600"
                aria-label="Home page"
              />
            )}
            <Link
              href={`/admin/pages/${r.id}`}
              className="font-medium text-near-black underline-offset-2 hover:underline"
            >
              {r.title}
            </Link>
          </span>
        ),
        // The mobile card already surfaces the title as its header link
        // (via PagesClient's `mobileRowHeader` prop below); rendering
        // the title a second time inside the property list reads as a
        // redundant "TITLE — Process" row. Hide from the mobile <dl>.
        hideOnMobile: true,
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
        key: 'status',
        label: 'Status',
        sortable: true,
        sortAccessor: (r) => (r.published === 1 ? 1 : 0),
        cell: (r) =>
          r.published === 1 ? (
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

  // Bulk actions: admin only (editor + viewer return empty toolbar).
  const bulkActions: AdminTableBulkAction<PageListRow>[] = useMemo(() => {
    if (!isAdmin) return []
    return [
      {
        id: 'trash',
        label: (n) => `Move ${n} to Trash`,
        icon: Trash2,
        destructive: true,
        confirm: {
          title: 'Move to Trash?',
          description: (n) =>
            `${n} ${n === 1 ? 'page' : 'pages'} will be hidden from the public site and held in Trash for 30 days. You can restore at any time.`,
          confirmLabel: 'Move to Trash',
        },
        run: async (selected) => {
          const result = await bulkRemove(selected, async (row) => {
            const r = await csrfFetch(`/api/cms/pages/${row.id}`, {
              method: 'DELETE',
            })
            if (!r.ok) {
              const j = (await r.json().catch(() => ({}))) as { error?: string }
              throw new Error(j.error ?? `Failed (${r.status})`)
            }
          })
          if (result.ok > 0) {
            toast.success(
              `${result.ok} ${result.ok === 1 ? 'page' : 'pages'} moved to Trash.`,
            )
          }
          router.refresh()
          return result
        },
      },
    ]
    // toast/router/bulkRemove are stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, bulkRemove])

  // ──────────────────────────────────────────────────────────────────
  // Per-row kebab actions per spec §3.2.
  // ──────────────────────────────────────────────────────────────────
  const rowActions = (r: PageListRow): React.ReactNode => {
    const items: RowActionItem[] = []
    items.push({
      id: 'open-editor',
      label: 'Open editor',
      icon: PenLine,
      onSelect: () => router.push(`/admin/pages/${r.id}`),
    })
    if (isAdmin) {
      items.push(
        r.published === 1
          ? {
              id: 'unpublish',
              label: 'Hide from public site',
              icon: EyeOff,
              disabled: busyRowId === r.id,
              onSelect: () => void togglePublish(r),
            }
          : {
              id: 'publish',
              label: 'Make live',
              icon: Eye,
              disabled: busyRowId === r.id,
              onSelect: () => void togglePublish(r),
            },
      )
    }
    items.push({
      id: 'open-public',
      label: r.published === 1 ? 'Open public page' : 'Preview draft',
      icon: ExternalLink,
      disabled: busyRowId === r.id,
      onSelect: () => void openPublic(r),
    })
    if (isAdmin) {
      items.push({
        id: 'trash',
        label: 'Move to Trash',
        icon: Trash2,
        destructive: true,
        disabled: busyRowId === r.id,
        onSelect: () => setPendingDeleteRow(r),
      })
    }
    return (
      // Inline action group revealed on row hover (or keyboard focus),
      // demoting the kebab to "overflow only" — Notion / Linear pattern.
      // The kebab still carries every action for discovery + keyboard
      // navigation; inline icons surface the THREE most common ones
      // (Edit / View / Trash) ahead of click so admins don't pay a
      // double-click cost on every common operation.
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Open editor for ${r.title}`}
          title="Open editor"
          onClick={() => router.push(`/admin/pages/${r.id}`)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-warm-stone opacity-0 transition-all hover:bg-warm-stone/10 hover:text-near-black focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/40 group-hover/admin-row:opacity-100 motion-reduce:transition-none"
        >
          <PenLine size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label={r.published === 1 ? `Open public page for ${r.title}` : `Preview draft of ${r.title}`}
          title={r.published === 1 ? 'Open public page' : 'Preview draft'}
          disabled={busyRowId === r.id}
          onClick={() => void openPublic(r)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-warm-stone opacity-0 transition-all hover:bg-warm-stone/10 hover:text-near-black focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/40 group-hover/admin-row:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
        >
          <ExternalLink size={14} strokeWidth={2} />
        </button>
        {isAdmin && (
          <button
            type="button"
            aria-label={`Move ${r.title} to Trash`}
            title="Move to Trash"
            disabled={busyRowId === r.id}
            onClick={() => setPendingDeleteRow(r)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-warm-stone opacity-0 transition-all hover:bg-red-50 hover:text-red-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 group-hover/admin-row:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
          >
            <Trash2 size={14} strokeWidth={2} />
          </button>
        )}
        <RowActionsMenu items={items} ariaLabel={`More actions for ${r.title}`} />
      </div>
    )
  }

  return (
    <>
      {/* Filter strip — search input on the left, status chips on the
          right. Premium spacing matching the rest of the admin chrome.
          Hidden when there are zero rows so an empty Pages list shows
          only the empty-state card (no useless chrome above nothing). */}
      {rows.length > 0 && (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 sm:max-w-md">
            <Search
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-warm-stone"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or web address"
              aria-label="Filter pages by title or web address"
              className="w-full rounded-full border border-warm-stone/25 bg-cream-50 py-2 pl-10 pr-9 text-sm text-near-black placeholder:text-warm-stone/60 transition-colors focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-400/30"
            />
            {search.length > 0 && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-warm-stone/15 text-warm-stone transition-colors hover:bg-warm-stone/25 hover:text-near-black"
              >
                <X size={11} strokeWidth={2.4} />
              </button>
            )}
          </div>
          <div
            role="group"
            aria-label="Filter by status"
            className="inline-flex items-center gap-1.5 self-start rounded-full bg-warm-stone/10 p-1 sm:self-auto"
          >
            {(
              [
                { id: 'all' as const, label: 'All', count: rows.length },
                { id: 'live' as const, label: 'Live', count: liveCount },
                { id: 'draft' as const, label: 'Draft', count: draftCount },
              ]
            ).map((c) => {
              const active = statusFilter === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setStatusFilter(c.id)}
                  aria-pressed={active}
                  className={clsx(
                    'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors motion-reduce:transition-none',
                    active
                      ? 'bg-near-black text-cream-50 shadow-[0_4px_14px_-4px_rgba(5,5,5,0.35)]'
                      : 'text-warm-stone hover:bg-warm-stone/10 hover:text-near-black',
                  )}
                >
                  {c.label}
                  <span
                    className={clsx(
                      'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px]',
                      active
                        ? 'bg-cream-50/15 text-cream-50'
                        : 'bg-warm-stone/15 text-warm-stone',
                    )}
                  >
                    {c.count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      <AdminTable<PageListRow>
        rows={filteredRows}
        getId={(r) => r.id}
        columns={columns}
        bulkActions={bulkActions}
        rowActions={rowActions}
        mobileRowHeader={(r) => (
          <Link
            href={`/admin/pages/${r.id}`}
            className="inline-flex items-center gap-2 text-base font-semibold text-near-black underline-offset-2 hover:underline"
          >
            {r.is_home === 1 && (
              <Home
                size={13}
                strokeWidth={2}
                className="text-copper-600"
                aria-label="Home page"
              />
            )}
            {r.title}
          </Link>
        )}
        emptyState={emptyState}
        defaultSort={{ column: 'updated_at', direction: 'desc' }}
      />
      <ConfirmModal
        open={pendingDeleteRow !== null}
        title="Move this page to Trash?"
        description={
          pendingDeleteRow?.is_home === 1
            ? 'This is your homepage. Visitors will see a placeholder until you restore it or set another page as Home.'
            : 'It will be hidden from the public site and held in Trash for 30 days. You can restore it at any time.'
        }
        confirmLabel="Move to Trash"
        destructive
        busy={deleting}
        onConfirm={onConfirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDeleteRow(null)
        }}
      />
    </>
  )
}
