'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { csrfFetch } from '@/lib/client/csrf'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { EmptyState } from '@/components/inline-edit/EmptyState'
import { StatusBadge, projectStatusTone } from '@/components/admin/StatusBadge'
import { RowActionsMenu } from '@/components/admin/RowActionsMenu'
import { PillButton } from '@/components/admin/PillButton'
import {
  Building2,
  Archive,
  Trash2,
  Undo2,
  Eye,
  EyeOff,
  ArrowDownUp,
  Table as TableIcon,
} from 'lucide-react'
import { useToast } from '@/components/inline-edit/Toast'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'

interface Row {
  id: number
  slug: string
  name: string
  status: string
  published: number
  featured_order: number | null
  deleted_at: Date | null
  version: number
  updated_at: Date
}

interface ReorderResponse {
  items: Array<{ id: number; version: number }>
}

import { SLUG_RE } from '@/lib/cms/slug'

const toEpoch = (v: Date | string | null): number | null => {
  if (v === null) return null
  // Guard NaN so a corrupted timestamp ('0000-00-00') tail-sorts like
  // a null rather than landing in the string-fallback comparator.
  const ms = typeof v === 'string' ? Date.parse(v) : v.getTime()
  return Number.isFinite(ms) ? ms : null
}

// View modes:
//   - 'browse': AdminTable with sort/paginate/select/bulk
//   - 'reorder': pure dnd-kit list, no sort/paginate/select (drag
//     handles only). Click "Done" to return to browse mode.
// Trashed view is always 'browse'.
type Mode = 'browse' | 'reorder'

export function ProjectsTable({
  role,
  initial,
  showArchived,
}: {
  role: 'admin' | 'editor'
  initial: Row[]
  showArchived: boolean
}) {
  const toast = useToast()
  const {
    items,
    setItems,
    bulkRemove,
    removeRow,
    updateRow,
  } = useListMutations<Row>(initial)
  const [newName, setNewName] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [pendingArchive, setPendingArchive] = useState<Row | null>(null)
  const [mode, setMode] = useState<Mode>('browse')

  async function createProject() {
    if (role !== 'admin') return
    if (busy) return
    setCreateError(null)
    if (newName.trim().length === 0) {
      setCreateError('Please give the project a name.')
      return
    }
    if (!SLUG_RE.test(newSlug)) {
      setCreateError(
        'The web address can only use lowercase letters, numbers, and single hyphens — no spaces.',
      )
      return
    }
    setBusy(true)
    try {
      const res = await csrfFetch('/api/cms/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          slug: newSlug,
          status: 'coming_soon',
        }),
      })
      if (res.status === 409) {
        setCreateError(
          'That web address is already in use by another project. Try a different one.',
        )
        return
      }
      if (!res.ok) {
        setCreateError(
          "We couldn't create that project. Try again, and if it keeps happening let an admin know.",
        )
        return
      }
      window.location.reload()
    } finally {
      setBusy(false)
    }
  }

  async function togglePublished(row: Row) {
    if (role !== 'admin' || busy) return
    setBusy(true)
    try {
      const res = await csrfFetch(`/api/cms/projects/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          published: !row.published,
          version: row.version,
        }),
      })
      if (res.status === 409) {
        toast.error(
          'Someone else just updated this project — refresh the page and try again.',
        )
        return
      }
      if (!res.ok) {
        toast.error("That didn't save. Try again in a moment.")
        return
      }
      updateRow(row.id, (r) => ({
        ...r,
        published: row.published ? 0 : 1,
        version: row.version + 1,
      }))
      toast.success(
        row.published
          ? 'Project hidden from the public site.'
          : 'Project is now live.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function archiveOne(row: Row): Promise<void> {
    const res = await csrfFetch(`/api/cms/projects/${row.id}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 204) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(j.error ?? `Failed (${res.status})`)
    }
  }

  async function confirmArchive() {
    const row = pendingArchive
    if (!row || busy) return
    setBusy(true)
    try {
      await archiveOne(row)
      removeRow(row.id)
      toast.success(`${row.name} moved to Trash.`)
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "We couldn't move that to Trash.",
      )
    } finally {
      setBusy(false)
      setPendingArchive(null)
    }
  }

  async function restoreOne(row: Row): Promise<void> {
    const res = await csrfFetch(`/api/cms/projects/${row.id}/restore`, {
      method: 'POST',
    })
    if (res.status === 409) {
      throw new Error(
        `Web address is now used by another live project. Rename one of them and try again.`,
      )
    }
    if (!res.ok) throw new Error(`Restore failed (${res.status})`)
  }

  async function restoreFromRow(row: Row) {
    if (role !== 'admin' || busy) return
    setBusy(true)
    try {
      await restoreOne(row)
      removeRow(row.id)
      toast.success(`${row.name} restored.`)
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "We couldn't restore that.",
      )
    } finally {
      setBusy(false)
    }
  }

  // ───────────────────────────────────────── AdminTable columns
   
  const columns: AdminTableColumn<Row>[] = useMemo(() => [
    {
      key: 'name',
      label: 'Project',
      sortable: true,
      sortAccessor: (r) => r.name.toLowerCase(),
      cell: (r) => (
        <Link
          href={`/admin/projects/${r.id}`}
          className="font-medium text-near-black underline-offset-2 hover:underline"
        >
          {r.name}
        </Link>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortAccessor: (r) => r.status,
      cell: (r) => {
        const { tone, label } = projectStatusTone(r.status)
        return <StatusBadge tone={tone}>{label}</StatusBadge>
      },
    },
    {
      key: 'featured_order',
      label: 'Featured order',
      sortable: true,
      sortAccessor: (r) => r.featured_order,
      cell: (r) => (
        <span className="text-xs text-warm-stone">
          {r.featured_order ?? '—'}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'published',
      label: 'Visibility',
      sortable: true,
      sortAccessor: (r) =>
        r.deleted_at ? -1 : r.published ? 1 : 0,
      cell: (r) =>
        r.deleted_at ? (
          <StatusBadge tone="trashed">In Trash</StatusBadge>
        ) : r.published ? (
          <StatusBadge tone="live">Live</StatusBadge>
        ) : (
          <StatusBadge tone="draft">Draft</StatusBadge>
        ),
    },
    {
      key: 'updated_at',
      label: 'Updated',
      sortable: true,
      sortAccessor: (r) => toEpoch(r.updated_at),
      cell: (r) => (
        <span className="text-xs text-warm-stone">
          {new Date(r.updated_at).toISOString().slice(0, 10)}
        </span>
      ),
      hideOnMobile: true,
    },
  ], [])

   
  const activeBulkActions: AdminTableBulkAction<Row>[] = useMemo(() => [
    {
      id: 'trash',
      label: (n) => `Move ${n} to Trash`,
      icon: Trash2,
      destructive: true,
      confirm: {
        title: 'Move to Trash?',
        description: (n) =>
          `${n} ${n === 1 ? 'project' : 'projects'} will be hidden from the public site and held in Trash for 30 days. You can restore at any time.`,
        confirmLabel: 'Move to Trash',
      },
      run: async (selected) => {
        const result = await bulkRemove(selected, async (row) => {
          const r = await csrfFetch(`/api/cms/projects/${row.id}`, {
            method: 'DELETE',
          })
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string }
            throw new Error(j.error ?? `Failed (${r.status})`)
          }
        })
        return result
      },
    },
  ], [bulkRemove])

  const trashedBulkActions: AdminTableBulkAction<Row>[] = useMemo(() => [
    {
      id: 'restore',
      label: (n) => `Restore ${n}`,
      icon: Undo2,
      run: async (selected) => {
        const result = await bulkRemove(selected, async (row) => {
          const r = await csrfFetch(`/api/cms/projects/${row.id}/restore`, {
            method: 'POST',
          })
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string }
            throw new Error(j.error ?? `Restore failed (${r.status})`)
          }
        })
        return result
      },
    },
  ], [bulkRemove])

  const rowActionsActive = (row: Row) =>
    role === 'admin' ? (
      <RowActionsMenu
        ariaLabel={`Actions for ${row.name}`}
        items={[
          {
            id: 'publish',
            icon: row.published ? EyeOff : Eye,
            label: row.published
              ? 'Hide from public site'
              : 'Make live',
            description: row.published
              ? 'Move back to Draft'
              : 'Publish to the homepage',
            disabled: busy,
            onSelect: () => togglePublished(row),
          },
          {
            id: 'trash',
            icon: Trash2,
            label: 'Move to Trash',
            description: 'Recoverable for 30 days',
            disabled: busy,
            destructive: true,
            onSelect: () => setPendingArchive(row),
          },
        ]}
      />
    ) : null

  const rowActionsTrash = (row: Row) =>
    role === 'admin' ? (
      <PillButton
        onClick={() => restoreFromRow(row)}
        disabled={busy}
        icon={Undo2}
        variant="subtle"
      >
        Restore
      </PillButton>
    ) : null

  // ─────────────────────────────────────────── render
  return (
    <section className="mt-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={showArchived ? '/admin/projects' : '/admin/projects?archived=1'}
          className="text-[11px] font-semibold uppercase tracking-[0.24em] text-warm-stone transition-colors hover:text-near-black"
        >
          {showArchived ? '← Back to live projects' : 'Show projects in Trash'}
        </Link>
        {!showArchived && role === 'admin' && items.length > 1 && (
          <PillButton
            onClick={() =>
              setMode((m) => (m === 'browse' ? 'reorder' : 'browse'))
            }
            icon={mode === 'browse' ? ArrowDownUp : TableIcon}
            variant="subtle"
            size="md"
          >
            {mode === 'browse' ? 'Reorder' : 'Done reordering'}
          </PillButton>
        )}
      </header>

      {role === 'admin' && !showArchived && mode === 'browse' && (
        <div className="mt-6 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-5 backdrop-blur-sm">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
            New project
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_1fr_auto] md:items-end">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                Project name
              </span>
              <Input
                className="mt-1.5"
                placeholder="e.g. Cedar Heights"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                Web address
              </span>
              <Input
                className="mt-1.5"
                placeholder="cedar-heights"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                disabled={busy}
              />
            </label>
            <Button onClick={createProject} disabled={busy}>
              Add project
            </Button>
          </div>
          {createError && (
            <p className="mt-3 text-sm font-medium text-copper-700">
              {createError}
            </p>
          )}
        </div>
      )}

      <div className="mt-6">
        {mode === 'reorder' && !showArchived ? (
          <ReorderList
            items={items}
            setItems={setItems}
            busy={busy}
            setBusy={setBusy}
          />
        ) : items.length === 0 ? (
          showArchived ? (
            <EmptyState
              icon={Archive}
              title="Trash is empty"
              description="Projects you move to Trash will show up here so you can restore them later."
              size="sm"
            />
          ) : (
            <EmptyState
              icon={Building2}
              title="Add your first development"
              description={
                role === 'admin'
                  ? 'Type a project name and a web address above to create your first project.'
                  : 'Projects are the heart of the site. An admin will need to create the first one.'
              }
              example="e.g. “Manual Residences · 12 units · Selling now”"
            />
          )
        ) : (
          <AdminTable<Row>
            rows={items}
            getId={(r) => r.id}
            columns={columns}
            bulkActions={
              role === 'admin'
                ? showArchived
                  ? trashedBulkActions
                  : activeBulkActions
                : []
            }
            rowActions={
              role === 'admin'
                ? showArchived
                  ? rowActionsTrash
                  : rowActionsActive
                : undefined
            }
            mobileRowHeader={(r) => (
              <Link
                href={`/admin/projects/${r.id}`}
                className="text-base font-semibold text-near-black underline-offset-2 hover:underline"
              >
                {r.name}
              </Link>
            )}
            emptyState={null}
            defaultSort={
              showArchived
                ? { column: 'updated_at', direction: 'desc' }
                : { column: 'featured_order', direction: 'asc' }
            }
            urlKey={showArchived ? 'trash' : undefined}
            selectionResetKey={mode}
          />
        )}
      </div>

      <ConfirmModal
        open={pendingArchive !== null}
        title="Move this project to Trash?"
        description={
          pendingArchive
            ? `${pendingArchive.name} will be moved to Trash and hidden from the public site. You have 30 days to restore it.`
            : ''
        }
        confirmLabel="Move to Trash"
        destructive
        busy={busy}
        onConfirm={confirmArchive}
        onCancel={() => {
          if (!busy) setPendingArchive(null)
        }}
      />
    </section>
  )
}

// ────────────────────────────────────────── reorder mode
// Pure dnd-kit list. Only renders in active view + admin role. Each
// drop persists immediately via the /reorder endpoint. Optimistic
// reorder with rollback on 409 conflict.

function ReorderList({
  items,
  setItems,
  busy,
  setBusy,
}: {
  items: Row[]
  setItems: (next: Row[]) => void
  busy: boolean
  setBusy: (b: boolean) => void
}) {
  const toast = useToast()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  async function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return
    const oldIdx = items.findIndex((r) => r.id === e.active.id)
    const newIdx = items.findIndex((r) => r.id === e.over!.id)
    if (oldIdx < 0 || newIdx < 0) return
    const next = arrayMove(items, oldIdx, newIdx)
    const prev = items
    setItems(next)
    setBusy(true)
    try {
      const res = await csrfFetch('/api/cms/projects/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projects: next.map((r) => ({ id: r.id, version: r.version })),
        }),
      })
      if (res.status === 409) {
        toast.error(
          'Someone else just changed the order — refresh and try again.',
        )
        setItems(prev)
        return
      }
      if (!res.ok) {
        toast.error("We couldn't save the new order.")
        setItems(prev)
        return
      }
      const j = (await res.json()) as ReorderResponse
      const versionMap = new Map(j.items.map((p) => [p.id, p.version]))
      setItems(
        next.map((r) => ({ ...r, version: versionMap.get(r.id) ?? r.version })),
      )
      toast.success('Order saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-warm-stone/20 bg-cream-50/60 backdrop-blur-sm">
      <p className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-warm-stone border-b border-warm-stone/15">
        Drag a project up or down to set the order that appears on the homepage.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={items.map((r) => r.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((r) => (
            <ReorderRow key={r.id} row={r} busy={busy} />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  )
}

function ReorderRow({ row, busy }: { row: Row; busy: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: row.id })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`grid grid-cols-[2rem_2fr_1fr_1fr] items-center gap-4 border-b border-warm-stone/10 px-5 py-4 last:border-b-0 ${busy ? 'opacity-60' : ''}`}
    >
      <span
        aria-label="Drag to reorder"
        className="cursor-grab text-warm-stone select-none text-lg leading-none"
        {...attributes}
        {...listeners}
      >
        ≡
      </span>
      <span className="truncate text-sm font-medium text-near-black">
        {row.name}
      </span>
      <span>
        {(() => {
          const { tone, label } = projectStatusTone(row.status)
          return <StatusBadge tone={tone}>{label}</StatusBadge>
        })()}
      </span>
      <span>
        {row.published ? (
          <StatusBadge tone="live">Live</StatusBadge>
        ) : (
          <StatusBadge tone="draft">Draft</StatusBadge>
        )}
      </span>
    </div>
  )
}
