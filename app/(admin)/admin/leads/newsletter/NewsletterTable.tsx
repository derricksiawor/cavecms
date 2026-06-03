'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mail, Ban, FolderOpen, Trash2, X } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { Drawer } from '@/components/ui/Drawer'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { RowActionsMenu } from '@/components/admin/RowActionsMenu'
import {
  AdminTable,
  type AdminTableColumn,
  type AdminTableBulkAction,
} from '@/components/admin/AdminTable'
import { useListMutations } from '@/lib/admin/useListMutations'
import { StatusBadge, type StatusTone } from '@/components/admin/StatusBadge'
import { CfSafeMailto } from '@/components/CfSafeMailto'
import type { Role } from '@/lib/auth/requireRole'

// Defence: validate the email shape before composing a mailto: URI.
// Server-side intake (the public newsletter form) Zod-validates the
// address and the unique constraint enforces well-formed strings, but
// a legacy / hand-edited row could ship a malformed value into this
// surface. Refuses to render the anchor rather than risk a crafted
// scheme injection. Mirrors EMAIL_RE in lib/leads/mask.ts.
const MAILTO_SAFE = /^[\w.+-]+@[\w-]+\.[\w.-]+$/

interface Subscriber {
  id: number
  email: string
  status: string
  source: string | null
  created_at: string
}

interface ListResponse {
  items: Subscriber[]
  nextCursor: string | null
}

const STATUSES = ['active', 'pending_confirmation', 'unsubscribed'] as const

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending_confirmation: 'Pending',
  unsubscribed: 'Unsubscribed',
}

const STATUS_TONES: Record<string, StatusTone> = {
  active: 'live',
  pending_confirmation: 'coming-soon',
  unsubscribed: 'trashed',
}

function humanStatus(s: string): string {
  return STATUS_LABELS[s] ?? s
}

function humanSource(s: string | null): string {
  if (!s) return '—'
  // 'public_form' → 'Public form'; 'mailchimp_import' → 'Mailchimp
  // import'. Title-cases every underscore-separated segment so the
  // first letter of each chunk is upper-case and the rest survive
  // intact (deliberate casing in 'API_v2' would otherwise be lost
  // by a charAt(0)-only approach).
  return s
    .split('_')
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ''))
    .join(' ')
}

// Defensive timestamp formatter. `new Date(s).toISOString()` throws
// RangeError on a malformed input (legacy data, manual SQL edits);
// returning '—' instead keeps the entire row from crashing the React
// reconciler over a single bad cell.
function fmtJoined(s: string): string {
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

const FETCH_BATCH_LIMIT = 100
const FETCH_TOTAL_CAP = 1000
const SEARCH_DEBOUNCE_MS = 300

export function NewsletterTable({
  role,
  initialFilters,
}: {
  role: Role
  initialFilters: { status?: string }
}) {
  const toast = useToast()
  const [filters, setFilters] = useState(initialFilters)
  // `search` is the live input value; `debouncedSearch` is what the
  // fetch keys on. The debounce lets the operator type "dariedee" in
  // one burst without firing a paginated drain on each keystroke.
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const {
    items,
    setItems,
    bulkRemove,
    bulkUpdate,
    removeRow,
    updateRow,
  } = useListMutations<Subscriber>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<Subscriber | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingUnsub, setPendingUnsub] = useState<Subscriber | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Subscriber | null>(null)
  const [reachedCap, setReachedCap] = useState(false)
  const inFlightRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      inFlightRef.current?.abort()
    }
  }, [])

  // Debounce the search box. Trimming here so trailing spaces don't
  // force a refetch with a payload-identical query string.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [search])

  const loadAll = useCallback(async () => {
    inFlightRef.current?.abort()
    const ctrl = new AbortController()
    inFlightRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const collected: Subscriber[] = []
      let cursor: string | null = null
      let capped = false
      while (collected.length < FETCH_TOTAL_CAP) {
        const params = new URLSearchParams({ limit: String(FETCH_BATCH_LIMIT) })
        if (filters.status) params.set('status', filters.status)
        if (debouncedSearch) params.set('search', debouncedSearch)
        if (cursor) params.set('cursor', cursor)
        const r = await fetch('/api/admin/newsletter?' + params.toString(), {
          credentials: 'include',
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (!r.ok) {
          setError("We couldn't load your subscribers. Try again in a moment.")
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
    // `setItems` is a useState dispatcher (referentially stable per
    // React's contract) so it's intentionally omitted from the deps;
    // including it adds no signal and a future refactor that wrapped
    // it could silently re-fire the entire drain loop on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, debouncedSearch])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Keep the drawer in sync with the list when a bulk action (or any
  // background refresh) mutates the row the operator currently has
  // open. Without this, opening the drawer for subscriber #42 and
  // then bulk-unsubscribing #42 via the table selection leaves the
  // drawer showing the stale 'active' status — the "Unsubscribe"
  // button inside the drawer would still render and trigger a confirm
  // modal for a no-op the server already short-circuits.
  useEffect(() => {
    if (!active) return
    const fresh = items.find((i) => i.id === active.id)
    if (!fresh) {
      // Row removed (hard delete from elsewhere) — close the drawer.
      setActive(null)
      return
    }
    if (fresh.status !== active.status) setActive(fresh)
  }, [items, active])

  async function unsubscribeOne(id: number): Promise<void> {
    const r = await csrfFetch(`/api/admin/newsletter/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'unsubscribed' }),
    })
    if (!r.ok) throw new Error("We couldn't unsubscribe that contact. Try again.")
  }

  async function deleteOne(id: number): Promise<void> {
    const r = await csrfFetch(`/api/admin/newsletter/${id}`, {
      method: 'DELETE',
    })
    if (!r.ok && r.status !== 204)
      throw new Error("We couldn't remove that contact. Try again.")
  }

  async function onConfirmUnsubscribe() {
    if (!pendingUnsub || busy) return
    setBusy(true)
    try {
      await unsubscribeOne(pendingUnsub.id)
      updateRow(pendingUnsub.id, (s) => ({ ...s, status: 'unsubscribed' }))
      toast.success('Subscriber unsubscribed.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unsubscribe failed.')
    } finally {
      setBusy(false)
      setPendingUnsub(null)
    }
  }

  async function onConfirmDelete() {
    if (!pendingDelete || busy) return
    setBusy(true)
    try {
      await deleteOne(pendingDelete.id)
      removeRow(pendingDelete.id)
      toast.success('Subscriber deleted.')
      setActive(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed.')
    } finally {
      setBusy(false)
      setPendingDelete(null)
    }
  }

  // ───────────────────────────────────────── columns
  const columns: AdminTableColumn<Subscriber>[] = useMemo(() => [
    {
      key: 'created_at',
      label: 'When',
      sortable: true,
      sortAccessor: (s) => {
        const ms = Date.parse(s.created_at)
        return Number.isFinite(ms) ? ms : null
      },
      cell: (s) => (
        <span className="text-xs text-warm-stone">
          {fmtJoined(s.created_at)}
        </span>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      sortable: true,
      sortAccessor: (s) => s.email.toLowerCase(),
      cell: (s) => (
        <span className="text-xs font-medium text-near-black">
          <CfSafeMailto email={s.email} linked={false} />
        </span>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      sortable: true,
      sortAccessor: (s) => s.source ?? '',
      cell: (s) => (
        <span className="text-xs text-warm-stone">{humanSource(s.source)}</span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortAccessor: (s) => s.status,
      cell: (s) => (
        <StatusBadge tone={STATUS_TONES[s.status] ?? 'neutral'}>
          {humanStatus(s.status)}
        </StatusBadge>
      ),
    },
  ], [])

  const bulkActions: AdminTableBulkAction<Subscriber>[] = useMemo(() => {
    const actions: AdminTableBulkAction<Subscriber>[] = []
    if (role !== 'admin' && role !== 'editor') return actions
    actions.push({
      id: 'unsubscribe',
      label: (n) => `Unsubscribe ${n}`,
      icon: Ban,
      destructive: true,
      confirm: {
        title: 'Unsubscribe these subscribers?',
        description: (n) =>
          `${n} ${n === 1 ? 'subscriber' : 'subscribers'} will be moved to Unsubscribed. They'll need to opt in again from the public form to receive future emails.`,
        confirmLabel: 'Unsubscribe',
      },
      run: async (selected) =>
        bulkUpdate(
          selected,
          async (s) => {
            // Skip the network call for rows already in the terminal
            // state — the server short-circuits anyway, but eliding
            // the request keeps the bulk-bar progress counter honest
            // when the operator selects "all" on a mixed list.
            if (s.status === 'unsubscribed') return
            await unsubscribeOne(s.id)
          },
          (s) => ({ ...s, status: 'unsubscribed' }),
        ),
    })
    if (role !== 'admin') return actions
    // Hard delete — admin-only. The schema has no soft-delete column;
    // this is the GDPR / data-subject-erasure path so the email is
    // genuinely gone after the request resolves.
    actions.push({
      id: 'delete',
      label: (n) => `Delete ${n} permanently`,
      icon: Trash2,
      destructive: true,
      confirm: {
        title: 'Delete these subscribers permanently?',
        description: (n) =>
          `${n} ${n === 1 ? 'subscriber' : 'subscribers'} will be deleted. This is not recoverable — use Unsubscribe instead if you only want to stop sending them email.`,
        confirmLabel: 'Delete permanently',
      },
      run: async (selected) =>
        bulkRemove(selected, async (s) => {
          await deleteOne(s.id)
        }),
    })
    return actions
  }, [role, bulkUpdate, bulkRemove])

  // Export URL carries the active status filter so a CSV pulled
  // while the list is scoped to "Active" doesn't surface
  // unsubscribed addresses the operator was intentionally hiding —
  // major compliance footgun for an admin about to push the CSV to
  // a mailing provider. The email search is NOT forwarded; CSV is
  // bulk-by-design and a partial substring would surprise the user.
  const exportHref = filters.status
    ? `/api/admin/newsletter/export?status=${encodeURIComponent(filters.status)}`
    : '/api/admin/newsletter/export'

  return (
    <section className="mt-10">
      <div role="search" className="flex flex-wrap items-center gap-3">
        <label htmlFor="newsletter-status-filter" className="sr-only">
          Subscriber status
        </label>
        <select
          id="newsletter-status-filter"
          value={filters.status ?? ''}
          onChange={(e) =>
            setFilters((f) => ({
              ...f,
              status: e.target.value || undefined,
            }))
          }
          className="rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanStatus(s)}
            </option>
          ))}
        </select>
        <label htmlFor="newsletter-search" className="sr-only">
          Search by email
        </label>
        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs sm:flex-none">
          <input
            id="newsletter-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email"
            className="w-full rounded-lg border border-warm-stone/30 bg-cream-50 px-3 py-2 pr-9 text-sm text-near-black placeholder:text-warm-stone focus:border-copper-400 focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-warm-stone transition-colors hover:text-near-black focus:outline-none focus:ring-1 focus:ring-copper-400"
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>
        {role !== 'viewer' && (
          <a
            href={exportHref}
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
          Showing the most recent {FETCH_TOTAL_CAP} subscribers. Use the status
          filter or email search above to narrow the list, or download the
          full spreadsheet for older entries.
        </p>
      )}

      <div className="mt-6">
        <AdminTable<Subscriber>
          rows={items}
          getId={(s) => s.id}
          columns={columns}
          bulkActions={bulkActions}
          rowActions={
            role === 'viewer'
              ? undefined
              : (s) => (
                  <RowActionsMenu
                    ariaLabel={`Actions for ${s.email}`}
                    items={[
                      {
                        id: 'open',
                        icon: FolderOpen,
                        label: 'Open subscriber',
                        description: 'View signup details',
                        onSelect: () => setActive(s),
                      },
                      {
                        id: 'unsubscribe',
                        icon: Ban,
                        label: 'Unsubscribe',
                        description:
                          s.status === 'unsubscribed'
                            ? 'Already unsubscribed'
                            : 'Move to Unsubscribed',
                        disabled: busy || s.status === 'unsubscribed',
                        destructive: true,
                        onSelect: () => setPendingUnsub(s),
                      },
                      ...(role === 'admin'
                        ? [
                            {
                              id: 'delete',
                              icon: Trash2,
                              label: 'Delete permanently',
                              description:
                                'Removes the row entirely — not recoverable',
                              disabled: busy,
                              destructive: true,
                              onSelect: () => setPendingDelete(s),
                            },
                          ]
                        : []),
                    ]}
                  />
                )
          }
          mobileRowHeader={(s) => (
            <span className="text-base font-semibold text-near-black">
              <CfSafeMailto email={s.email} linked={false} />
            </span>
          )}
          emptyState={
            <p className="text-sm text-warm-stone">
              No subscribers yet. The footer signup form delivers new
              subscribers here once they confirm their email.
            </p>
          }
          filteredEmptyState={
            <p className="text-sm text-warm-stone">
              No subscribers match these filters. Try clearing the status
              filter or email search above.
            </p>
          }
          hasActiveFilter={Boolean(filters.status || debouncedSearch)}
          defaultSort={{ column: 'created_at', direction: 'desc' }}
          loading={loading}
        />
      </div>

      <Drawer open={!!active} onClose={() => setActive(null)}>
        {active && (
          <div className="p-8">
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-copper-600">
              Subscriber #{active.id}
            </p>
            <h2 className="mt-3 font-serif text-2xl font-bold tracking-tight text-near-black break-all">
              {active.email}
            </h2>
            <dl className="mt-6 space-y-3 text-sm">
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Email
                </dt>
                <dd className="mt-1 inline-flex items-center gap-2 text-near-black">
                  <Mail size={13} strokeWidth={2} className="text-warm-stone" />
                  {MAILTO_SAFE.test(active.email) ? (
                    <CfSafeMailto
                      email={active.email}
                      className="underline break-all"
                    />
                  ) : (
                    <span className="break-all">{active.email}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Status
                </dt>
                <dd className="mt-1 text-near-black">
                  {humanStatus(active.status)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Source
                </dt>
                <dd className="mt-1 text-near-black">
                  {humanSource(active.source)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
                  Joined
                </dt>
                <dd className="mt-1 text-near-black">
                  {fmtJoined(active.created_at)}
                </dd>
              </div>
            </dl>
            {role !== 'viewer' && (
              <div className="mt-8 flex flex-wrap gap-3 border-t border-warm-stone/15 pt-5">
                {active.status !== 'unsubscribed' && (
                  <button
                    type="button"
                    onClick={() => setPendingUnsub(active)}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg border border-copper-300 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-copper-700 transition-colors hover:bg-copper-50 disabled:opacity-40"
                  >
                    <Ban size={13} strokeWidth={2} />
                    Unsubscribe
                  </button>
                )}
                {role === 'admin' && (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(active)}
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-red-700 transition-colors hover:bg-red-50 disabled:opacity-40"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    Delete permanently
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmModal
        open={pendingUnsub !== null}
        title="Unsubscribe this subscriber?"
        description={
          pendingUnsub
            ? `${pendingUnsub.email} will be moved to Unsubscribed and won't receive future emails. They'll need to opt in again from the public form to resubscribe.`
            : ''
        }
        confirmLabel="Unsubscribe"
        destructive
        busy={busy}
        onConfirm={onConfirmUnsubscribe}
        onCancel={() => {
          if (!busy) setPendingUnsub(null)
        }}
      />

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete this subscriber permanently?"
        description={
          pendingDelete
            ? `${pendingDelete.email} will be deleted entirely. This is not recoverable — use Unsubscribe instead if you only want to stop sending them email.`
            : ''
        }
        confirmLabel="Delete permanently"
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
