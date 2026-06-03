'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Trash2,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { csrfFetch, readCsrf, refreshCsrf } from '@/lib/client/csrf'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/inline-edit/Toast'
import { ShimmerThumb } from '@/components/inline-edit/Shimmer'
import { runPerRowMutation } from '@/components/admin/AdminTable'
import { PillButton } from '@/components/admin/PillButton'

interface MediaItem {
  id: number
  filename_uuid: string
  mime_type: string
  alt_text: string
  width: number | null
  height: number | null
  byte_size: number
  variants: Record<string, string> | null
  created_at: string
}

const PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50, 100]
const DEFAULT_PAGE_SIZE = 20
// Match the server's MAX_LIMIT (50) — bigger batches halve the
// drain round-trip count on a large library.
const FETCH_BATCH_LIMIT = 50
const FETCH_TOTAL_CAP = 1000

type SortKey =
  | 'newest'
  | 'oldest'
  | 'largest'
  | 'smallest'
  | 'name_asc'
  | 'name_desc'

const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  largest: 'Largest first',
  smallest: 'Smallest first',
  name_asc: 'Description A → Z',
  name_desc: 'Description Z → A',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Refreshed media library — grid layout kept, with the same selection
// + bulk + pagination + sort controls every other admin list now has.
//
// Fetch model: drain cursor pagination once on mount up to
// FETCH_TOTAL_CAP, then run all sort / paginate / filter logic
// client-side. At >1000 assets we'll switch to server-side; today
// every project sits well under that ceiling.

export function MediaLibrary({ role }: { role: 'admin' | 'editor' }) {
  const toast = useToast()
  const canDelete = role === 'admin'
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reachedCap, setReachedCap] = useState(false)
  // Per-file upload progress. Each entry maps a stable upload-id
  // (clientId, generated client-side) to its name + percent-complete
  // [0..100]. Entries are removed once the upload settles, success or
  // failure. Surfaces as a stacked progress-bar list above the grid.
  const [uploads, setUploads] = useState<
    Array<{ clientId: number; name: string; pct: number }>
  >([])
  const uploadIdRef = useRef(0)
  const [pendingDelete, setPendingDelete] = useState<MediaItem | null>(null)
  const [pendingBulk, setPendingBulk] = useState(false)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const inFlightRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    return () => {
      inFlightRef.current?.abort()
    }
  }, [])

  // Drain the full media list once. Cursor < N → next page. Stop at
  // FETCH_TOTAL_CAP to bound client memory. The list above the cap
  // surfaces a console.warn the operator can read in dev tools.
  const loadAll = useCallback(async () => {
    inFlightRef.current?.abort()
    const ctrl = new AbortController()
    inFlightRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const collected: MediaItem[] = []
      let cursor: number | null = null
      let capped = false
      while (collected.length < FETCH_TOTAL_CAP) {
        const params = new URLSearchParams({ limit: String(FETCH_BATCH_LIMIT) })
        if (cursor !== null) params.set('cursor', String(cursor))
        const r = await fetch('/api/cms/media?' + params.toString(), {
          credentials: 'include',
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        if (!r.ok) {
          setError("We couldn't load your files. Try again in a moment.")
          return
        }
        const j = (await r.json()) as {
          items: MediaItem[]
          nextCursor: number | null
        }
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
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (m) =>
        m.alt_text.toLowerCase().includes(q) || String(m.id).includes(q),
    )
  }, [items, query])

  const sorted = useMemo(() => {
    const list = [...filtered]
    switch (sort) {
      case 'newest':
        list.sort(
          (a, b) =>
            Date.parse(b.created_at) - Date.parse(a.created_at),
        )
        break
      case 'oldest':
        list.sort(
          (a, b) =>
            Date.parse(a.created_at) - Date.parse(b.created_at),
        )
        break
      case 'largest':
        list.sort((a, b) => b.byte_size - a.byte_size)
        break
      case 'smallest':
        list.sort((a, b) => a.byte_size - b.byte_size)
        break
      case 'name_asc':
        list.sort((a, b) =>
          a.alt_text.toLowerCase().localeCompare(b.alt_text.toLowerCase()),
        )
        break
      case 'name_desc':
        list.sort((a, b) =>
          b.alt_text.toLowerCase().localeCompare(a.alt_text.toLowerCase()),
        )
        break
    }
    return list
  }, [filtered, sort])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const clampedPage = Math.min(Math.max(1, page), totalPages)
  const visible = useMemo(
    () => sorted.slice((clampedPage - 1) * pageSize, clampedPage * pageSize),
    [sorted, clampedPage, pageSize],
  )

  // Auto-clamp page when filter/size changes shrink the dataset.
  useEffect(() => {
    if (page !== clampedPage) setPage(clampedPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampedPage])

  // Clear selection when page / filter / sort changes — selection is
  // page-scoped, matching the AdminTable contract.
  useEffect(() => {
    setSelected(new Set())
  }, [clampedPage, query, sort, pageSize])

  const visibleIds = useMemo(() => visible.map((m) => m.id), [visible])
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someSelected =
    visibleIds.some((id) => selected.has(id)) && !allSelected

  const selectAllRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  const toggleAll = () => {
    setSelected((prev) => {
      if (allSelected) return new Set()
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }
  const toggleRow = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const uploadFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files)
    for (const f of arr) {
      const alt = f.name.replace(/\.[^.]+$/, '').slice(0, 320)
      const clientId = ++uploadIdRef.current
      setUploads((prev) => [...prev, { clientId, name: f.name, pct: 0 }])
      try {
        const fd = new FormData()
        fd.append('file', f)
        fd.append('alt', alt)
        const result = await xhrUpload<MediaItem>(
          '/api/cms/media',
          fd,
          (pct) =>
            setUploads((prev) =>
              prev.map((u) => (u.clientId === clientId ? { ...u, pct } : u)),
            ),
        )
        setItems((prev) => [result, ...prev])
        toast.success(`Uploaded ${f.name}.`)
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "We couldn't upload that file. Try again.",
        )
      } finally {
        setUploads((prev) => prev.filter((u) => u.clientId !== clientId))
      }
    }
  }

  const deleteOne = async (item: MediaItem): Promise<void> => {
    const res = await csrfFetch(`/api/cms/media/${item.id}`, { method: 'DELETE' })
    if (res.status === 409) {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      if (j.error === 'in_use' || j.error === 'still_referenced') {
        throw new Error(`${item.alt_text || 'this file'} is still in use`)
      }
      throw new Error('Conflict — refresh and try again.')
    }
    if (!res.ok && res.status !== 204) {
      throw new Error("We couldn't do that just now. Try again.")
    }
  }

  const confirmDelete = async () => {
    const item = pendingDelete
    if (!item || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteOne(item)
      setItems((prev) => prev.filter((m) => m.id !== item.id))
      toast.success('File moved to Trash.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "We couldn't delete that just now. Try again in a moment.")
    } finally {
      setDeleteBusy(false)
      setPendingDelete(null)
    }
  }

  const onBulkDelete = async () => {
    if (selected.size === 0) return
    setBulkRunning(true)
    try {
      // Selection is page-scoped (cleared on page/sort/filter change),
      // but explicitly intersect against `visible` so a future hand
      // editing the selection-clear effect can't accidentally turn
      // this into a cross-page bulk delete.
      const selectedItems = visible.filter((m) => selected.has(m.id))
      const result = await runPerRowMutation(selectedItems, async (item) => {
        await deleteOne(item)
      })
      const removedIds = new Set(
        selectedItems
          .filter((s) => !result.failed.some((f) => f.row.id === s.id))
          .map((s) => s.id),
      )
      setItems((prev) => prev.filter((m) => !removedIds.has(m.id)))
      if (result.ok > 0) toast.success(`${result.ok} files moved to Trash.`)
      if (result.failed.length > 0) {
        const reasons = Array.from(
          new Set(result.failed.map((f) => f.reason)),
        ).join('; ')
        toast.error(
          `${result.failed.length} ${result.failed.length === 1 ? 'file' : 'files'} couldn't be moved: ${reasons}`,
        )
      }
      clearSelection()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "We couldn't delete that just now. Try again in a moment.")
    } finally {
      setBulkRunning(false)
      setPendingBulk(false)
    }
  }

  const pages = computePageRange(clampedPage, totalPages)

  return (
    <section className="mt-10 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px]">
          <Input
            type="search"
            placeholder="Search files by description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Sort
          <select
            value={sort}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setSort(e.target.value as SortKey)
            }
            className="rounded-xl border border-warm-stone/30 bg-cream-50 px-3 py-1.5 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-400/40"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/avif,application/pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {canDelete && visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warm-stone/15 bg-cream-50/40 px-4 py-2">
          <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-4 w-4 cursor-pointer accent-copper-600"
              aria-label={
                allSelected
                  ? 'Deselect all visible files'
                  : 'Select all visible files'
              }
            />
            Select all on this page
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black">
                {selected.size} selected
              </span>
              <PillButton
                onClick={() => setPendingBulk(true)}
                disabled={bulkRunning}
                icon={Trash2}
                variant="destructive"
                size="md"
              >
                Move {selected.size} to Trash
              </PillButton>
              <PillButton
                onClick={clearSelection}
                disabled={bulkRunning}
                icon={X}
                variant="subtle"
                size="md"
              >
                Clear
              </PillButton>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="text-sm font-medium text-copper-700">{error}</p>
      )}

      {uploads.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-warm-stone/20 bg-cream-50/60 px-4 py-3 backdrop-blur-sm">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-copper-600">
            Uploading {uploads.length}
            {uploads.length === 1 ? ' file' : ' files'}…
          </p>
          {uploads.map((u) => (
            <div key={u.clientId} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-near-black" title={u.name}>
                  {u.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-warm-stone">
                  {u.pct}%
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`${u.name} upload progress`}
                aria-valuenow={u.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1 overflow-hidden rounded-full bg-warm-stone/15"
              >
                <div
                  className="h-full rounded-full bg-copper-500 transition-all"
                  style={{ width: `${u.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {reachedCap && (
        <p className="rounded-xl border border-copper-300/40 bg-copper-50/40 px-4 py-2 text-xs text-near-black">
          Showing the most recent {FETCH_TOTAL_CAP} files. Use the search
          above to narrow the list — older files aren&rsquo;t in this view.
        </p>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files)
        }}
        className={clsx(
          'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 transition-all rounded-2xl p-3',
          dragOver && 'bg-copper-50 ring-2 ring-copper-300/40',
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="aspect-square flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-warm-stone/30 bg-cream-50/60 text-warm-stone transition-all hover:border-copper-400 hover:bg-cream-50 hover:text-copper-700"
        >
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-copper-100 text-copper-700">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </span>
          <span className="text-sm font-medium text-near-black">
            {dragOver ? 'Drop to upload' : 'Upload files'}
          </span>
          <span className="text-[11px] text-warm-stone">
            Drag and drop, or click to choose
          </span>
        </button>

        {loading && visible.length === 0 ? (
          <>
            {Array.from({ length: 7 }).map((_, i) => (
              <div
                key={`shim-${i}`}
                className="overflow-hidden rounded-2xl border border-warm-stone/15 bg-cream-50/40"
              >
                <ShimmerThumb />
              </div>
            ))}
          </>
        ) : visible.length === 0 ? (
          <p className="text-sm text-warm-stone col-span-full pl-2">
            {query
              ? 'Nothing matches that search. Try a different word.'
              : 'Your library is empty. Drop a file above to get started.'}
          </p>
        ) : (
          visible.map((m) => {
            const isSel = selected.has(m.id)
            return (
              <div
                key={m.id}
                className={clsx(
                  'group relative overflow-hidden rounded-2xl border bg-cream-50/60 backdrop-blur-sm transition-colors',
                  isSel
                    ? 'border-copper-400/60'
                    : 'border-warm-stone/20 hover:border-warm-stone/40',
                )}
              >
                {canDelete && (
                  <label
                    className={clsx(
                      'absolute left-2 top-2 z-10 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-cream-50/90 ring-1 ring-warm-stone/30 transition-opacity',
                      isSel || someSelected || allSelected
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggleRow(m.id)}
                      aria-label={`Select ${m.alt_text || `file ${m.id}`}`}
                      className="h-4 w-4 cursor-pointer accent-copper-600"
                    />
                  </label>
                )}
                <div className="aspect-square bg-near-black/5 flex items-center justify-center">
                  {m.mime_type === 'application/pdf' ? (
                    <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-warm-stone">
                      PDF · {formatBytes(m.byte_size)}
                    </span>
                  ) : m.variants?.thumb ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={m.variants.thumb}
                      alt={m.alt_text}
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-reveal group-hover:scale-105"
                    />
                  ) : (
                    <span className="text-[10px] uppercase tracking-[0.24em] text-warm-stone">
                      getting ready…
                    </span>
                  )}
                </div>
                <div className="p-3 space-y-2">
                  <p
                    className="truncate text-xs text-near-black font-medium"
                    title={m.alt_text}
                  >
                    {m.alt_text || (
                      <em className="text-warm-stone">no description</em>
                    )}
                  </p>
                  <p className="text-[10px] text-warm-stone font-mono truncate">
                    {m.width ?? '?'}×{m.height ?? '?'} · {formatBytes(m.byte_size)}
                  </p>
                  {canDelete && (
                    <PillButton
                      onClick={() => setPendingDelete(m)}
                      icon={Trash2}
                      variant="subtle"
                      className="mt-1 !w-full"
                    >
                      Move to Trash
                    </PillButton>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {sorted.length > 0 && (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Show
            </label>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(parseInt(e.target.value, 10))}
              className="rounded-xl border border-warm-stone/30 bg-cream-50 px-3 py-1.5 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-400/40"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              per page · {sorted.length} total
            </span>
          </div>
          <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center justify-end gap-1"
          >
            <button
              type="button"
              onClick={() => setPage(Math.max(1, clampedPage - 1))}
              disabled={clampedPage <= 1 || loading}
              aria-label="Previous page"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/25 text-warm-stone transition-colors hover:border-near-black hover:text-near-black disabled:opacity-40"
            >
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            {pages.map((p, i) =>
              p === '…' ? (
                <span
                  key={`ell-${i}`}
                  className="px-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
                >
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  aria-current={p === clampedPage ? 'page' : undefined}
                  className={clsx(
                    'inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-[11px] font-semibold uppercase tracking-[0.2em] transition-colors',
                    p === clampedPage
                      ? 'bg-near-black text-cream-50'
                      : 'border border-warm-stone/25 text-warm-stone hover:border-near-black hover:text-near-black',
                  )}
                >
                  {p}
                </button>
              ),
            )}
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages, clampedPage + 1))}
              disabled={clampedPage >= totalPages || loading}
              aria-label="Next page"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/25 text-warm-stone transition-colors hover:border-near-black hover:text-near-black disabled:opacity-40"
            >
              <ChevronRight size={16} strokeWidth={2} />
            </button>
          </nav>
        </div>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        title="Move this file to Trash?"
        description={
          pendingDelete
            ? `${pendingDelete.alt_text || 'This file'} will move to Trash. If a project or post is still using it, we'll refuse and ask you to swap it out first.`
            : ''
        }
        confirmLabel="Move to Trash"
        destructive
        busy={deleteBusy}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleteBusy) setPendingDelete(null)
        }}
      />

      <ConfirmModal
        open={pendingBulk}
        title={`Move ${selected.size} file${selected.size === 1 ? '' : 's'} to Trash?`}
        description={`These ${selected.size === 1 ? 'file' : 'files'} will move to Trash. Any file still in use by a project or post will be refused — we'll tell you which.`}
        confirmLabel="Move to Trash"
        destructive
        busy={bulkRunning}
        onConfirm={onBulkDelete}
        onCancel={() => {
          if (!bulkRunning) setPendingBulk(false)
        }}
      />
    </section>
  )
}

// Page-range helper — up to 7 slots with ellipses for big sets.
function computePageRange(
  current: number,
  total: number,
): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const slots: Array<number | '…'> = [1]
  const left = Math.max(2, current - 1)
  const right = Math.min(total - 1, current + 1)
  if (left > 2) slots.push('…')
  for (let p = left; p <= right; p++) slots.push(p)
  if (right < total - 1) slots.push('…')
  slots.push(total)
  return slots
}

// Inline copy of the XHR uploader to avoid pulling the entire
// MediaPicker module into this page. Same flow: read CSRF, attach
// header, send multipart, retry on 403.
async function xhrUpload<T>(
  url: string,
  body: FormData,
  onProgress: (pct: number) => void,
): Promise<T> {
  let token = readCsrf()
  if (!token) {
    try {
      token = await refreshCsrf()
    } catch {
      throw new Error("Your session expired — refresh the page and try again.")
    }
  }
  const send = (t: string): Promise<{ status: number; text: string }> =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url, true)
      xhr.withCredentials = true
      xhr.setRequestHeader('x-csrf-token', t)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText })
      xhr.onerror = () =>
        reject(
          new Error("We can't reach the server right now. Check your connection and try again."),
        )
      xhr.ontimeout = () =>
        reject(
          new Error(
            'The upload took too long. Try again with a smaller file or a stronger connection.',
          ),
        )
      xhr.timeout = 120_000
      xhr.send(body)
    })

  let res = await send(token)
  if (res.status === 403) {
    token = await refreshCsrf()
    res = await send(token)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error("That upload didn't go through. Try again in a moment.")
  }
  try {
    return JSON.parse(res.text) as T
  } catch {
    throw new Error('The server replied with something unexpected. Refresh the page and try again.')
  }
}
