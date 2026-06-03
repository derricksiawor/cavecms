'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  Trash2,
  Eye,
  EyeOff,
  FolderPlus,
  TagIcon,
  Search,
  X,
} from 'lucide-react'
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
import {
  derivePostStatus,
  POST_STATUS_FILTERS,
  type PostStatusFilter,
} from '@/lib/cms/postStatus'
import type {
  PostSortColumn,
  SortDir,
  PostStatusCounts,
  TaxonomyFilterTerm,
} from '@/lib/cms/listPosts'
import { TaxonomyChips, type TermOption } from './[id]/TaxonomyChips'

// Phase 8 (blog-system worktree): the SERVER-MODE admin posts list. AdminTable
// runs in `server` mode — sort + page + page-size changes call back into here
// and push to the URL, which re-runs the server page's listPosts() query. The
// status tabs, debounced search, and taxonomy filter chips are sibling controls
// that also push URL params. Bulk actions (publish / unpublish / trash /
// assign-category / add-tag) POST to /api/cms/posts/bulk; the two taxonomy ones
// open a custom chip-picker modal first (#0.59 — visual chips, never a select).

export interface PostRow {
  id: number
  slug: string
  title: string
  published: number
  published_at: Date | string | null
  deleted_at: Date | string | null
  updated_at: Date | string
}

interface BulkResult {
  ok: number
  failed: Array<{ id: number; reason: string }>
}

const STATUS_TAB_LABEL: Record<PostStatusFilter, string> = {
  all: 'All',
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  trash: 'Trash',
}

export function PostsClient({
  rows,
  total,
  counts,
  status,
  search,
  sort,
  dir,
  page,
  perPage,
  categorySlug,
  tagSlug,
  categories,
  tags,
  emptyState,
}: {
  rows: PostRow[]
  total: number
  counts: PostStatusCounts
  status: PostStatusFilter
  search: string
  sort: PostSortColumn
  dir: SortDir
  page: number
  perPage: number
  categorySlug: string | null
  tagSlug: string | null
  categories: TaxonomyFilterTerm[]
  tags: TaxonomyFilterTerm[]
  emptyState: React.ReactNode
}) {
  const toast = useToast()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // ── URL helper. Mutates the named params, resets page to 1 on any
  //    filter/search change, and pushes. Null value deletes the param. ───────
  const pushParams = useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') params.delete(k)
        else params.set(k, v)
      }
      if (resetPage) params.delete('page')
      const qs = params.toString()
      router.push(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  // ── Debounced search box (server-side LIKE) ───────────────────────────────
  const [searchInput, setSearchInput] = useState(search)
  // Keep the box in sync if the URL changes from elsewhere (back/forward).
  useEffect(() => {
    setSearchInput(search)
  }, [search])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onSearchChange = (value: string) => {
    setSearchInput(value)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      pushParams({ q: value.trim() === '' ? null : value.trim() })
    }, 350)
  }
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [])

  // ── Server-mode AdminTable callbacks ──────────────────────────────────────
  const onSortChange = useCallback(
    (next: { column: string; direction: SortDir } | null) => {
      // Reset to page 1 in this SAME push (resetPage=true) — re-sorting changes
      // which rows land on page 1, and it makes AdminTable's trailing
      // onPageChange(1) a no-op (identical URL), avoiding a redundant push.
      if (next === null) {
        // Cleared sort → fall back to the default (updated desc) by dropping the
        // params, so the table never renders "unsorted".
        pushParams({ sort: null, dir: null })
      } else {
        pushParams({ sort: next.column, dir: next.direction })
      }
    },
    [pushParams],
  )
  const onPageChange = useCallback(
    (next: number) => {
      pushParams({ page: next <= 1 ? null : String(next) }, false)
    },
    [pushParams],
  )
  const onPageSizeChange = useCallback(
    (size: number) => {
      pushParams({ per: String(size), page: null }, false)
    },
    [pushParams],
  )

  // ── Per-row + bulk mutation helpers ───────────────────────────────────────
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const runBulk = useCallback(
    async (
      action: string,
      ids: number[],
      extra?: { categoryIds?: number[]; tagIds?: number[] },
    ): Promise<{ ok: number; failed: Array<{ row: PostRow; reason: string }> }> => {
      const r = await csrfFetch('/api/cms/posts/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ids, ...(extra ?? {}) }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        // A whole-request failure (403/400/429) → mark every row failed with
        // the server reason so the bulk bar surfaces it.
        const reason = j.error ?? `Failed (${r.status})`
        return {
          ok: 0,
          failed: ids.map((id) => ({
            row: rows.find((x) => x.id === id) ?? ({ id } as PostRow),
            reason,
          })),
        }
      }
      const j = (await r.json()) as BulkResult
      router.refresh()
      return {
        ok: j.ok,
        failed: j.failed.map((f) => ({
          row: rows.find((x) => x.id === f.id) ?? ({ id: f.id } as PostRow),
          reason: f.reason,
        })),
      }
    },
    [rows, router],
  )

  // Per-row Move to Trash (single).
  const onConfirmDelete = async () => {
    if (pendingDeleteId === null) return
    setDeleting(true)
    try {
      const r = await csrfFetch(`/api/cms/posts/${pendingDeleteId}`, {
        method: 'DELETE',
      })
      if (!r.ok && r.status !== 204) {
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        if (j.error === 'not_found') {
          toast.success('Moved to Trash.')
        } else {
          toast.error(`Failed (${r.status})`)
          return
        }
      } else {
        toast.success('Moved to Trash.')
      }
      router.refresh()
    } finally {
      setDeleting(false)
      setPendingDeleteId(null)
    }
  }

  // ── Bulk taxonomy-assign modal state ──────────────────────────────────────
  const [assignKind, setAssignKind] = useState<'category' | 'tag' | null>(null)
  const [assignSelected, setAssignSelected] = useState<Set<number>>(new Set())
  const [assignIds, setAssignIds] = useState<number[]>([]) // selected post ids
  const [assignBusy, setAssignBusy] = useState(false)
  // Mutable term catalogs (so an inline-created term appends + selects). Seeded
  // from the id-bearing catalog the server page passes down — no extra fetch.
  const [catOptions, setCatOptions] = useState<TermOption[]>(
    categories.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      parentId: c.parentId ?? null,
    })),
  )
  const [tagOptions, setTagOptions] = useState<TermOption[]>(
    tags.map((t) => ({ id: t.id, slug: t.slug, name: t.name })),
  )

  const openAssign = useCallback((kind: 'category' | 'tag', ids: number[]) => {
    setAssignKind(kind)
    setAssignSelected(new Set())
    setAssignIds(ids)
  }, [])

  const submitAssign = async () => {
    if (assignKind === null || assignSelected.size === 0) return
    setAssignBusy(true)
    try {
      const termIds = [...assignSelected]
      const r = await runBulk(
        assignKind === 'category' ? 'assignCategories' : 'addTags',
        assignIds,
        assignKind === 'category'
          ? { categoryIds: termIds }
          : { tagIds: termIds },
      )
      if (r.ok > 0) {
        toast.success(
          assignKind === 'category'
            ? `Category added to ${r.ok} ${r.ok === 1 ? 'post' : 'posts'}.`
            : `Tag added to ${r.ok} ${r.ok === 1 ? 'post' : 'posts'}.`,
        )
      }
      if (r.failed.length > 0) {
        const reasons = Array.from(
          new Set(r.failed.map((f) => f.reason)),
        ).join('; ')
        toast.error(`${r.failed.length} could not be updated: ${reasons}`)
      }
    } finally {
      setAssignBusy(false)
      setAssignKind(null)
      setAssignSelected(new Set())
      setAssignIds([])
    }
  }

  // ── Columns ───────────────────────────────────────────────────────────────
  const columns: AdminTableColumn<PostRow>[] = useMemo(
    () => [
      {
        key: 'title',
        label: 'Title',
        sortable: true,
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
        sortable: false,
        cell: (r) => (
          <span className="text-xs text-warm-stone font-mono">
            /blog/{r.slug}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        cell: (r) => <StatusCell row={r} />,
      },
      {
        key: 'published',
        label: 'Published',
        sortable: true,
        cell: (r) => <PublishedCell row={r} />,
        hideOnMobile: true,
      },
      {
        key: 'updated',
        label: 'Last edited',
        sortable: true,
        cell: (r) => (
          <span className="text-xs text-warm-stone">
            {fmtDate(r.updated_at)}
          </span>
        ),
      },
    ],
    [],
  )

  // ── Bulk actions ──────────────────────────────────────────────────────────
  const bulkActions: AdminTableBulkAction<PostRow>[] = useMemo(
    () => [
      {
        id: 'publish',
        label: (n) => `Publish ${n}`,
        icon: Eye,
        run: async (selected) => runBulk('publish', selected.map((r) => r.id)),
      },
      {
        id: 'unpublish',
        label: (n) => `Unpublish ${n}`,
        icon: EyeOff,
        run: async (selected) =>
          runBulk('unpublish', selected.map((r) => r.id)),
      },
      {
        id: 'assignCategory',
        label: (n) => `Add category to ${n}`,
        icon: FolderPlus,
        // Opens the picker modal; the actual mutation happens on modal submit.
        // Return an early-exit { ok:0, failed:[] } so AdminTable keeps the
        // selection intact while the modal is open.
        run: async (selected) => {
          openAssign('category', selected.map((r) => r.id))
          return { ok: 0, failed: [] }
        },
      },
      {
        id: 'addTag',
        label: (n) => `Add tag to ${n}`,
        icon: TagIcon,
        run: async (selected) => {
          openAssign('tag', selected.map((r) => r.id))
          return { ok: 0, failed: [] }
        },
      },
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
        run: async (selected) => runBulk('trash', selected.map((r) => r.id)),
      },
    ],
    [runBulk, openAssign],
  )

  const activeFilterCount =
    (search.trim() !== '' ? 1 : 0) +
    (categorySlug ? 1 : 0) +
    (tagSlug ? 1 : 0)

  return (
    <>
      {/* ── Status tabs ─────────────────────────────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {POST_STATUS_FILTERS.map((tab) => {
          const count =
            tab === 'all'
              ? counts.all
              : tab === 'draft'
                ? counts.draft
                : tab === 'scheduled'
                  ? counts.scheduled
                  : tab === 'published'
                    ? counts.published
                    : counts.trash
          const active = tab === status
          // Trash tab links to the dedicated recovery view (Restore lives there).
          if (tab === 'trash') {
            return (
              <Link
                key={tab}
                href="/admin/blog?trashed=1"
                className="inline-flex items-center gap-1.5 rounded-full border border-warm-stone/30 bg-cream-50/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone transition-colors hover:border-copper-400 hover:text-near-black"
              >
                {STATUS_TAB_LABEL[tab]}
                <span className="rounded-full bg-warm-stone/15 px-1.5 py-0.5 text-[10px] tabular-nums text-warm-stone">
                  {count}
                </span>
              </Link>
            )
          }
          return (
            <button
              key={tab}
              type="button"
              onClick={() => pushParams({ status: tab === 'all' ? null : tab })}
              aria-pressed={active}
              className={[
                'inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] transition-all duration-quick',
                active
                  ? 'border-copper-500 bg-copper-500 text-cream-50 shadow-[0_6px_16px_-8px_rgba(184,115,51,0.6)]'
                  : 'border-warm-stone/30 bg-cream-50/60 text-warm-stone hover:border-copper-400 hover:text-near-black',
              ].join(' ')}
            >
              {STATUS_TAB_LABEL[tab]}
              <span
                className={[
                  'rounded-full px-1.5 py-0.5 text-[10px] tabular-nums',
                  active
                    ? 'bg-cream-50/25 text-cream-50'
                    : 'bg-warm-stone/15 text-warm-stone',
                ].join(' ')}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Search + taxonomy filter chips ──────────────────────────────── */}
      <div className="mb-5 space-y-3">
        <div className="flex items-center gap-2 rounded-xl border border-warm-stone/25 bg-cream-50/80 px-3 py-2 focus-within:border-copper-400 focus-within:ring-2 focus-within:ring-copper-300/40 sm:max-w-md">
          <Search size={16} strokeWidth={2} className="shrink-0 text-warm-stone" aria-hidden />
          <input
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search posts by title, web address, or excerpt…"
            maxLength={120}
            className="w-full bg-transparent text-sm text-near-black placeholder:text-warm-stone/60 focus:outline-none"
            aria-label="Search posts"
          />
          {searchInput !== '' && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('')
                pushParams({ q: null })
              }}
              aria-label="Clear search"
              className="shrink-0 text-warm-stone hover:text-near-black"
            >
              <X size={14} strokeWidth={2.2} />
            </button>
          )}
        </div>

        {/* Taxonomy filter chips — single-select per axis; clicking the active
            chip clears it. Visual chips (#0.59), never a select. */}
        {(categories.length > 0 || tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {categories.map((c) => {
              const active = categorySlug === c.slug
              return (
                <button
                  key={`cat-${c.slug}`}
                  type="button"
                  onClick={() =>
                    pushParams({
                      category: active ? null : c.slug,
                      tag: null,
                    })
                  }
                  aria-pressed={active}
                  className={[
                    'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-quick',
                    active
                      ? 'border-copper-500 bg-copper-500 text-cream-50'
                      : 'border-warm-stone/30 bg-cream-50/60 text-near-black hover:border-copper-400 hover:text-copper-700',
                  ].join(' ')}
                >
                  <FolderPlus size={12} strokeWidth={2.2} aria-hidden />
                  {c.name}
                </button>
              )
            })}
            {tags.map((t) => {
              const active = tagSlug === t.slug
              return (
                <button
                  key={`tag-${t.slug}`}
                  type="button"
                  onClick={() =>
                    pushParams({ tag: active ? null : t.slug, category: null })
                  }
                  aria-pressed={active}
                  className={[
                    'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-quick',
                    active
                      ? 'border-copper-500 bg-copper-500 text-cream-50'
                      : 'border-warm-stone/30 bg-cream-50/60 text-near-black hover:border-copper-400 hover:text-copper-700',
                  ].join(' ')}
                >
                  <TagIcon size={12} strokeWidth={2.2} aria-hidden />
                  {t.name}
                </button>
              )
            })}
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('')
                  pushParams({ q: null, category: null, tag: null, status: null })
                }}
                className="inline-flex items-center gap-1 rounded-full border border-warm-stone/30 px-3 py-1 text-xs font-medium text-warm-stone transition-colors hover:border-copper-400 hover:text-near-black"
              >
                <X size={12} strokeWidth={2.2} aria-hidden />
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      <AdminTable<PostRow>
        // Remount on ANY server-driven state change (incl. back/forward) so the
        // table's once-initialised internal page/sort state never drifts from
        // the URL — server mode is parent-authoritative. Cheap: the table is a
        // single page slice, not a heavy tree.
        key={`${status}|${sort}|${dir}|${page}|${perPage}|${categorySlug ?? ''}|${tagSlug ?? ''}|${search}`}
        rows={rows}
        getId={(r) => r.id}
        columns={columns}
        bulkActions={bulkActions}
        mode="server"
        total={total}
        page={page}
        pageSize={perPage}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        onSortChange={onSortChange}
        defaultSort={{ column: sort, direction: dir }}
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

      {/* Bulk taxonomy-assign modal — custom dialog hosting the chip picker. */}
      {assignKind !== null && (
        <BulkAssignModal
          kind={assignKind}
          count={assignIds.length}
          options={assignKind === 'category' ? catOptions : tagOptions}
          selected={assignSelected}
          onChange={setAssignSelected}
          onTermCreated={(term) => {
            if (assignKind === 'category') {
              setCatOptions((prev) => [...prev, term])
            } else {
              setTagOptions((prev) => [...prev, term])
            }
            setAssignSelected((prev) => new Set(prev).add(term.id))
          }}
          busy={assignBusy}
          onSubmit={submitAssign}
          onCancel={() => {
            if (assignBusy) return
            setAssignKind(null)
            setAssignSelected(new Set())
            setAssignIds([])
          }}
        />
      )}
    </>
  )
}

// ── Cells (small components so the columns memo stays tidy) ─────────────────

function StatusCell({ row }: { row: PostRow }) {
  const status = derivePostStatus(row)
  if (status === 'published')
    return <StatusBadge tone="live">Published</StatusBadge>
  if (status === 'scheduled')
    return (
      <span className="inline-flex items-center rounded-full bg-near-black px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-cream-50">
        Scheduled
      </span>
    )
  if (status === 'trash')
    return <StatusBadge tone="trashed">Trash</StatusBadge>
  return <StatusBadge tone="draft">Draft</StatusBadge>
}

// The Published column shows the publish DATE for a live post, "Scheduled ·
// <date>" for a future-dated one, and "Draft" for an unpublished post — the
// exact §4 spec wording.
function PublishedCell({ row }: { row: PostRow }) {
  const status = derivePostStatus(row)
  if (status === 'draft') {
    return <span className="text-xs text-warm-stone">Draft</span>
  }
  if (status === 'scheduled') {
    return (
      <span className="text-xs text-near-black">
        Scheduled · {fmtDate(row.published_at)}
      </span>
    )
  }
  return (
    <span className="text-xs text-warm-stone">{fmtDate(row.published_at)}</span>
  )
}

// Stable UTC yyyy-mm-dd (matches the public chrome's <time>); guards a NaN date.
function fmtDate(v: Date | string | null): string {
  if (v === null) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10)
}

// ── Bulk-assign modal (custom dialog hosting TaxonomyChips) ─────────────────

function BulkAssignModal({
  kind,
  count,
  options,
  selected,
  onChange,
  onTermCreated,
  busy,
  onSubmit,
  onCancel,
}: {
  kind: 'category' | 'tag'
  count: number
  options: TermOption[]
  selected: Set<number>
  onChange: (next: Set<number>) => void
  onTermCreated: (term: TermOption) => void
  busy: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const noun = kind === 'category' ? 'category' : 'tag'

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!busy) onCancel()
        }}
        className="fixed inset-0 z-40 cursor-default bg-near-black/45 backdrop-blur-[3px] animate-cavecms-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-assign-title"
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border border-warm-stone/20 bg-cream-50 shadow-[0_40px_80px_-30px_rgba(5,5,5,0.55)] animate-cavecms-fade-in"
      >
        <div className="px-8 pt-8 pb-5 sm:px-10">
          <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-copper-600">
            Bulk action
          </p>
          <h2
            id="bulk-assign-title"
            className="mt-2 font-serif text-2xl font-bold tracking-tight text-near-black"
          >
            Add {noun} to {count} {count === 1 ? 'post' : 'posts'}
          </h2>
          <p className="mt-2 text-sm text-warm-stone">
            Pick one or more {noun === 'category' ? 'categories' : 'tags'} to add.
            Existing {noun === 'category' ? 'categories' : 'tags'} on each post
            are kept — this only adds.
          </p>
          <div className="mt-5">
            <TaxonomyChips
              kind={kind}
              label={kind === 'category' ? 'Categories' : 'Tags'}
              options={options}
              selectedIds={selected}
              onChange={onChange}
              onTermCreated={onTermCreated}
              disabled={busy}
            />
          </div>
        </div>
        <div className="flex flex-col-reverse items-stretch gap-3 border-t border-warm-stone/15 bg-cream/40 px-8 py-5 sm:flex-row sm:items-center sm:justify-end sm:px-10">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex w-fit items-center justify-center rounded-full border border-warm-stone/30 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || selected.size === 0}
            className="inline-flex w-fit items-center justify-center rounded-full bg-near-black px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 shadow-[0_18px_40px_-22px_rgba(5,5,5,0.55)] transition-all hover:bg-copper-700 disabled:opacity-50"
          >
            {busy ? 'Working…' : `Add ${noun}`}
          </button>
        </div>
      </div>
    </>
  )
}
