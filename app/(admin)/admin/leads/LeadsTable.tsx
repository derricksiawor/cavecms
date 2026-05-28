'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Trash2, Mail, Phone, ExternalLink, Undo2, FolderOpen } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Drawer } from '@/components/ui/Drawer'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { RowActionsMenu } from '@/components/admin/RowActionsMenu'
import { PillButton } from '@/components/admin/PillButton'
import { CfSafeMailto } from '@/components/CfSafeMailto'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'
import { StatusBadge, type StatusTone } from '@/components/admin/StatusBadge'
import type { Role } from '@/lib/auth/requireRole'

// Mirror of server-side state machine in app/api/admin/leads/[id]/route.ts.
// Used only for editor button gating — server re-validates every PATCH.
const EDITOR_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  new: ['contacted'],
  contacted: ['won', 'lost', 'new'],
  won: [],
  lost: [],
}

interface Lead {
  id: number
  source: string
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  status: string
  project_slug: string | null
  project_name: string | null
  created_at: string
}

interface ListResponse {
  items: Lead[]
  nextCursor: string | null
}

const STATUSES = ['new', 'contacted', 'won', 'lost'] as const

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  won: 'Won',
  lost: 'Lost',
}

const SOURCE_LABELS: Record<string, string> = {
  contact: 'Contact form',
  brochure: 'Brochure request',
  inquiry: 'Project inquiry',
}

const STATUS_TONES: Record<string, StatusTone> = {
  new: 'live',
  contacted: 'coming-soon',
  won: 'live',
  lost: 'trashed',
}

function humanStatus(s: string): string {
  return STATUS_LABELS[s] ?? s
}

function humanSource(s: string): string {
  return SOURCE_LABELS[s] ?? s
}

const FETCH_BATCH_LIMIT = 100
const FETCH_TOTAL_CAP = 1000

export function LeadsTable({
  role,
  initialFilters,
  showTrashed = false,
}: {
  role: Role
  initialFilters: { source?: string; status?: string }
  showTrashed?: boolean
}) {
  const toast = useToast()
  const [filters, setFilters] = useState(initialFilters)
  const {
    items,
    setItems,
    bulkRemove,
    bulkUpdate,
    removeRow,
    updateRow,
  } = useListMutations<Lead>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<Lead | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Lead | null>(null)
  // Flips true when loadAll fills to FETCH_TOTAL_CAP and the server
  // still has more rows. Surfaces a banner so the operator knows
  // older leads aren't in the view and the bulk-action count is
  // bounded.
  const [reachedCap, setReachedCap] = useState(false)
  const inFlightRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      inFlightRef.current?.abort()
    }
  }, [])

  // Drain cursor pagination up to FETCH_TOTAL_CAP. At >1000 leads
  // we'd switch back to server-side pagination, but CaveCMS at v1 is
  // well under that ceiling.
  const loadAll = useCallback(async () => {
    inFlightRef.current?.abort()
    const ctrl = new AbortController()
    inFlightRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const collected: Lead[] = []
      let cursor: string | null = null
      let capped = false
      while (collected.length < FETCH_TOTAL_CAP) {
        const params = new URLSearchParams({ limit: String(FETCH_BATCH_LIMIT) })
        if (showTrashed) params.set('trashed', '1')
        if (filters.source) params.set('source', filters.source)
        if (filters.status) params.set('status', filters.status)
        if (cursor) params.set('cursor', cursor)
        const r = await fetch('/api/admin/leads?' + params.toString(), {
          credentials: 'include',
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (!r.ok) {
          setError("We couldn't load your leads. Try again in a moment.")
          return
        }
        const j = (await r.json()) as ListResponse
        if (ctrl.signal.aborted) return
        for (const item of j.items) {
          if (collected.length >= FETCH_TOTAL_CAP) break
          collected.push(item)
        }
        if (j.nextCursor === null) break
        if (collected.length >= FETCH_TOTAL_CAP) {
          capped = true
          break
        }
        cursor = j.nextCursor
      }
      setItems(collected)
      setReachedCap(capped)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError(
        "We can't reach the server right now. Check your connection and try again.",
      )
    } finally {
      if (inFlightRef.current === ctrl) {
        setLoading(false)
        inFlightRef.current = null
      }
    }
  }, [filters.source, filters.status, showTrashed, setItems])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  async function changeStatusOne(id: number, status: string): Promise<void> {
    const r = await csrfFetch(`/api/admin/leads/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (r.status === 409) {
      throw new Error("You can't move this lead to that status.")
    }
    if (!r.ok) throw new Error(`Save failed (${r.status})`)
  }

  async function deleteOne(id: number): Promise<void> {
    const r = await csrfFetch(`/api/admin/leads/${id}`, { method: 'DELETE' })
    if (!r.ok && r.status !== 204) throw new Error(`Failed (${r.status})`)
  }

  async function restoreOne(id: number): Promise<void> {
    const r = await csrfFetch(`/api/admin/leads/${id}/restore`, {
      method: 'POST',
    })
    if (!r.ok) throw new Error(`Restore failed (${r.status})`)
  }

  async function restoreFromRow(id: number) {
    if (busy) return
    setBusy(true)
    try {
      await restoreOne(id)
      removeRow(id)
      toast.success('Lead restored.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed.')
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(id: number, status: string) {
    if (busy) return
    setBusy(true)
    try {
      await changeStatusOne(id, status)
      updateRow(id, (l) => ({ ...l, status }))
      setActive((cur) => (cur && cur.id === id ? { ...cur, status } : cur))
      toast.success(`Lead moved to ${humanStatus(status)}.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setBusy(false)
    }
  }

  async function onConfirmDelete() {
    if (!pendingDelete || busy) return
    setBusy(true)
    try {
      await deleteOne(pendingDelete.id)
      removeRow(pendingDelete.id)
      toast.success('Lead moved to Trash.')
      setActive(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed.')
    } finally {
      setBusy(false)
      setPendingDelete(null)
    }
  }

  function allowedTransitions(currentStatus: string): readonly string[] {
    if (role === 'admin') return STATUSES.filter((s) => s !== currentStatus)
    return EDITOR_TRANSITIONS[currentStatus] ?? []
  }

  // ───────────────────────────────────────── columns
  const columns: AdminTableColumn<Lead>[] = useMemo(() => [
    {
      key: 'created_at',
      label: 'When',
      sortable: true,
      sortAccessor: (l) => {
        const ms = Date.parse(l.created_at)
        return Number.isFinite(ms) ? ms : null
      },
      cell: (l) => (
        <span className="text-xs text-warm-stone">
          {new Date(l.created_at)
            .toISOString()
            .slice(0, 16)
            .replace('T', ' ')}
        </span>
      ),
    },
    {
      key: 'source',
      label: 'From',
      sortable: true,
      sortAccessor: (l) => l.source,
      cell: (l) => (
        <span className="text-xs">{humanSource(l.source)}</span>
      ),
    },
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      sortAccessor: (l) => (l.name ?? '').toLowerCase(),
      cell: (l) => (
        <span className="text-xs font-medium text-near-black">
          {l.name ?? '—'}
        </span>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      sortAccessor: (l) => (l.email ?? '').toLowerCase(),
      cell: (l) => <span className="text-xs">{l.email ?? '—'}</span>,
      hideOnMobile: true,
    },
    {
      key: 'project_slug',
      label: 'Project',
      sortable: true,
      sortAccessor: (l) => l.project_slug ?? '',
      cell: (l) => (
        <span className="text-xs text-warm-stone">
          {l.project_slug ?? '—'}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortAccessor: (l) => l.status,
      cell: (l) => (
        <StatusBadge tone={STATUS_TONES[l.status] ?? 'neutral'}>
          {humanStatus(l.status)}
        </StatusBadge>
      ),
    },
  ], [])

  const bulkActions: AdminTableBulkAction<Lead>[] = useMemo(() => {
    const actions: AdminTableBulkAction<Lead>[] = []
    // Trash view: only Restore. Active view: status changes + delete.
    if (showTrashed) {
      if (role !== 'admin') return actions
      actions.push({
        id: 'restore',
        label: (n) => `Restore ${n}`,
        icon: Undo2,
        run: async (selected) =>
          bulkRemove(selected, async (l) => {
            await restoreOne(l.id)
          }),
      })
      return actions
    }
    if (role !== 'admin' && role !== 'editor') return actions
    const markStatus = (
      status: 'contacted' | 'won' | 'lost',
    ): AdminTableBulkAction<Lead>['run'] => async (selected) =>
      bulkUpdate(
        selected,
        async (l) => {
          await changeStatusOne(l.id, status)
        },
        (l) => ({ ...l, status }),
      )
    actions.push(
      {
        id: 'mark_contacted',
        label: (n) => `Mark ${n} contacted`,
        confirm: {
          title: 'Mark these leads contacted?',
          description: (n) =>
            `${n} ${n === 1 ? 'lead' : 'leads'} will move to the Contacted column.`,
          confirmLabel: 'Mark contacted',
        },
        run: markStatus('contacted'),
      },
      {
        id: 'mark_won',
        label: (n) => `Mark ${n} won`,
        confirm: {
          title: 'Mark these leads won?',
          description: (n) =>
            `${n} ${n === 1 ? 'lead' : 'leads'} will move to Won. This is a terminal state — only an admin can reopen it.`,
          confirmLabel: 'Mark won',
        },
        run: markStatus('won'),
      },
      {
        id: 'mark_lost',
        label: (n) => `Mark ${n} lost`,
        confirm: {
          title: 'Mark these leads lost?',
          description: (n) =>
            `${n} ${n === 1 ? 'lead' : 'leads'} will move to Lost. This is a terminal state — only an admin can reopen it.`,
          confirmLabel: 'Mark lost',
        },
        run: markStatus('lost'),
      },
    )
    if (role !== 'admin') return actions
    actions.push({
      id: 'trash',
      label: (n) => `Move ${n} to Trash`,
      icon: Trash2,
      destructive: true,
      confirm: {
        title: 'Move these leads to Trash?',
        description: (n) =>
          `${n} ${n === 1 ? 'lead' : 'leads'} will be moved to Trash. You have 30 days to restore from there.`,
        confirmLabel: 'Move to Trash',
      },
      run: async (selected) =>
        bulkRemove(selected, async (l) => {
          await deleteOne(l.id)
        }),
    })
    return actions
  }, [role, showTrashed, bulkRemove, bulkUpdate])

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filters.source ?? ''}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              source: e.target.value || undefined,
            }))
          }
          className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
          aria-label="Where the lead came from"
        >
          <option value="">All sources</option>
          <option value="contact">Contact form</option>
          <option value="brochure">Brochure request</option>
          <option value="inquiry">Project inquiry</option>
        </select>
        <select
          value={filters.status ?? ''}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              status: e.target.value || undefined,
            }))
          }
          className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
          aria-label="Lead status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanStatus(s)}
            </option>
          ))}
        </select>
        <Link
          href={showTrashed ? '/admin/leads' : '/admin/leads?trashed=1'}
          className="rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-warm-stone transition-colors hover:border-copper-400 hover:text-near-black"
        >
          {showTrashed ? '← Back to inbox' : 'Show leads in Trash'}
        </Link>
        {role !== 'viewer' && !showTrashed && (
          <a
            href="/api/admin/leads/export"
            download
            className="ml-auto rounded-lg border border-warm-stone/30 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400"
          >
            Download as spreadsheet
          </a>
        )}
      </div>

      {error && (
        <p className="mt-4 text-sm font-medium text-copper-700">{error}</p>
      )}

      {reachedCap && (
        <p className="mt-4 rounded-xl border border-copper-300/40 bg-copper-50/40 px-4 py-2 text-xs text-near-black">
          Showing the most recent {FETCH_TOTAL_CAP} leads. Use the source or
          status filter above to narrow the list, or download the full
          spreadsheet for older entries.
        </p>
      )}

      <div className="mt-6">
        <AdminTable<Lead>
          rows={items}
          getId={(l) => l.id}
          columns={columns}
          bulkActions={bulkActions}
          rowActions={
            role === 'viewer'
              ? undefined
              : showTrashed
                ? (l) =>
                    role === 'admin' ? (
                      <PillButton
                        onClick={() => restoreFromRow(l.id)}
                        disabled={busy}
                        ariaLabel={`Restore lead from ${l.name ?? l.email ?? l.id}`}
                        icon={Undo2}
                        variant="subtle"
                      >
                        Restore
                      </PillButton>
                    ) : null
                : (l) => (
                    <RowActionsMenu
                      ariaLabel={`Actions for ${l.name ?? l.email ?? `lead ${l.id}`}`}
                      items={[
                        {
                          id: 'open',
                          icon: FolderOpen,
                          label: 'Open lead',
                          description: 'View contact details and message',
                          onSelect: () => setActive(l),
                        },
                        ...(role === 'admin'
                          ? [
                              {
                                id: 'trash',
                                icon: Trash2,
                                label: 'Move to Trash',
                                description:
                                  'Recoverable for 30 days',
                                disabled: busy,
                                destructive: true,
                                onSelect: () => setPendingDelete(l),
                              },
                            ]
                          : []),
                      ]}
                    />
                  )
          }
          mobileRowHeader={(l) => (
            <span className="text-base font-semibold text-near-black">
              {l.name ?? l.email ?? `Lead #${l.id}`}
            </span>
          )}
          emptyState={
            <p className="text-sm text-warm-stone">
              No leads yet. New inquiries from the contact form, project pages,
              and brochure downloads show up here.
            </p>
          }
          filteredEmptyState={
            <p className="text-sm text-warm-stone">
              No leads match these filters. Try clearing the source or status
              filter above.
            </p>
          }
          hasActiveFilter={Boolean(filters.source || filters.status)}
          defaultSort={{ column: 'created_at', direction: 'desc' }}
          loading={loading}
        />
      </div>

      <Drawer open={!!active} onClose={() => setActive(null)}>
        {active && (
          <div className="p-8">
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
              Lead #{active.id}
            </p>
            <h2 className="mt-3 font-serif text-2xl font-bold tracking-tight text-near-black">
              {active.name ?? 'Anonymous'}
            </h2>
            <dl className="mt-6 space-y-3 text-sm">
              {active.email && (
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                    Email
                  </dt>
                  <dd className="mt-1 inline-flex items-center gap-2 text-near-black">
                    <Mail size={13} strokeWidth={2} className="text-warm-stone" />
                    <CfSafeMailto email={active.email} className="underline" />
                  </dd>
                </div>
              )}
              {active.phone && (
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                    Phone
                  </dt>
                  <dd className="mt-1 inline-flex items-center gap-2 text-near-black">
                    <Phone size={13} strokeWidth={2} className="text-warm-stone" />
                    <a className="underline" href={`tel:${active.phone}`}>
                      {active.phone}
                    </a>
                  </dd>
                </div>
              )}
              {active.project_slug && (
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                    Project
                  </dt>
                  <dd className="mt-1 inline-flex items-center gap-2 text-near-black">
                    <ExternalLink
                      size={13}
                      strokeWidth={2}
                      className="text-warm-stone"
                    />
                    <a
                      className="underline"
                      href={`/projects/${active.project_slug}`}
                    >
                      {active.project_name ?? active.project_slug}
                    </a>
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  From · Status
                </dt>
                <dd className="mt-1 text-near-black">
                  {humanSource(active.source)} · {humanStatus(active.status)}
                </dd>
              </div>
            </dl>
            {active.message && (
              <div className="mt-6">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Message
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-near-black">
                  {active.message}
                </p>
              </div>
            )}
            {role !== 'viewer' && (
              <div className="mt-8">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Move to
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {allowedTransitions(active.status).length === 0 ? (
                    <p className="text-xs text-warm-stone">
                      {role === 'admin'
                        ? 'This lead is already where you want it.'
                        : "There's nothing to change from this status."}
                    </p>
                  ) : (
                    allowedTransitions(active.status).map((s) => (
                      <button
                        type="button"
                        key={s}
                        disabled={busy}
                        onClick={() => changeStatus(active.id, s)}
                        className="rounded-lg border border-warm-stone/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 disabled:opacity-40"
                      >
                        {humanStatus(s)}
                      </button>
                    ))
                  )}
                </div>
                {role === 'admin' && (
                  <div className="mt-6 border-t border-warm-stone/15 pt-5">
                    <PillButton
                      onClick={() => setPendingDelete(active)}
                      disabled={busy}
                      icon={Trash2}
                      variant="destructive"
                      size="md"
                    >
                      Move to Trash
                    </PillButton>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmModal
        open={pendingDelete !== null}
        title="Move this lead to Trash?"
        description={
          pendingDelete
            ? `The lead from ${pendingDelete.name ?? pendingDelete.email ?? 'this contact'} will be moved to Trash. You can restore it within 30 days.`
            : ''
        }
        confirmLabel="Move to Trash"
        destructive
        busy={busy}
        onConfirm={onConfirmDelete}
        onCancel={() => {
          if (!busy) setPendingDelete(null)
        }}
      />
    </section>
  )
}
