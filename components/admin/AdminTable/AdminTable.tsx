'use client'

import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useId,
  type ReactNode,
} from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { useToast } from '@/components/inline-edit/Toast'
import { BulkBar } from './BulkBar'
import { MobileSortBar } from './MobileSortBar'
import { Pagination } from './Pagination'
import { DesktopTable } from './DesktopTable'
import { MobileCards } from './MobileCards'
import type {
  AdminTableBulkAction,
  AdminTableColumn,
  AdminTableSort,
  SortDirection,
} from './helpers'

// Universal admin list table. The orchestrator owns state (sort,
// page, page-size, selection, pending bulk) + URL sync. JSX is split
// into focused subcomponents — see ./BulkBar / ./MobileSortBar /
// ./Pagination / ./DesktopTable / ./MobileCards. Helpers live in
// ./helpers (pure: types, range, runPerRowMutation).
//
// Two modes:
//   - 'client': caller hands us the full row set. Sort + paginate +
//     slice in memory.
//   - 'server': caller owns sort/page state. We render the current
//     slice + emit change events.
//
// Selection is page-scoped. Cleared on page / sort / pageSize change,
// pruned of stale ids when rows shrink externally.

export interface AdminTableProps<Row> {
  rows: Row[]
  getId: (row: Row) => string | number
  columns: AdminTableColumn<Row>[]
  bulkActions?: AdminTableBulkAction<Row>[]
  rowActions?: (row: Row) => ReactNode
  mobileRowHeader?: (row: Row) => ReactNode
  emptyState: ReactNode
  filteredEmptyState?: ReactNode
  hasActiveFilter?: boolean
  mode?: 'client' | 'server'
  pageSize?: number
  pageSizeOptions?: number[]
  defaultSort?: AdminTableSort
  total?: number
  page?: number
  onPageChange?: (page: number) => void
  onPageSizeChange?: (size: number) => void
  onSortChange?: (sort: AdminTableSort) => void
  loading?: boolean
  urlKey?: string
  noUrlSync?: boolean
  selectionLabel?: string
  /** When this value changes, the table clears selection. Useful for
   *  parent-level mode toggles. */
  selectionResetKey?: string | number | null
  /** Return `false` to disable the row's checkbox (and exclude it
   *  from select-all). Useful for "you can't act on yourself" rows. */
  isRowSelectable?: (row: Row) => boolean
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 15, 20, 25, 50, 100]
const DEFAULT_PAGE_SIZE = 25

export function AdminTable<Row>(props: AdminTableProps<Row>) {
  const {
    rows,
    getId,
    columns,
    bulkActions = [],
    rowActions,
    mobileRowHeader,
    emptyState,
    filteredEmptyState,
    hasActiveFilter = false,
    mode = 'client',
    pageSize: pageSizeProp = DEFAULT_PAGE_SIZE,
    pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
    defaultSort = null,
    total,
    page: pageProp,
    onPageChange,
    onPageSizeChange,
    onSortChange,
    loading = false,
    urlKey,
    noUrlSync = false,
    selectionLabel,
    selectionResetKey,
    isRowSelectable,
  } = props

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const componentId = useId()
  const toast = useToast()

  // Stable refs for caller-supplied callbacks. getId / isRowSelectable
  // are called inside useMemo deps; without the ref pattern, an inline
  // arrow function in the caller would invalidate the memo on every
  // parent render.
  const getIdRef = useRef(getId)
  getIdRef.current = getId
  const getRowId = useCallback(
    (row: Row) => getIdRef.current(row),
    [],
  )
  const isRowSelectableRef = useRef(isRowSelectable)
  isRowSelectableRef.current = isRowSelectable
  const canSelect = useCallback(
    (row: Row) =>
      isRowSelectableRef.current ? isRowSelectableRef.current(row) : true,
    [],
  )

  // Param keys (prefixed for multi-table pages). Full words to avoid
  // collisions with future route params named `p`, `n`, etc.
  const PK = useMemo(() => {
    const prefix = urlKey ? `${urlKey}_` : ''
    return {
      page: `${prefix}page`,
      size: `${prefix}per`,
      sort: `${prefix}sort`,
    }
  }, [urlKey])

  // Initial state from URL — re-derived on every URL change so back/
  // forward navigation rehydrates state without a remount.
  const readPageFromUrl = useCallback((): number => {
    if (mode === 'server') return pageProp ?? 1
    if (noUrlSync) return 1
    const v = parseInt(searchParams.get(PK.page) ?? '1', 10)
    return Number.isFinite(v) && v > 0 ? v : 1
  }, [mode, pageProp, noUrlSync, searchParams, PK.page])

  const readSizeFromUrl = useCallback((): number => {
    if (noUrlSync) return pageSizeProp
    const v = parseInt(searchParams.get(PK.size) ?? `${pageSizeProp}`, 10)
    return pageSizeOptions.includes(v) ? v : pageSizeProp
  }, [noUrlSync, pageSizeProp, pageSizeOptions, searchParams, PK.size])

  const readSortFromUrl = useCallback((): AdminTableSort => {
    if (noUrlSync) return defaultSort
    const raw = searchParams.get(PK.sort)
    if (!raw) return defaultSort
    const idx = raw.indexOf(':')
    if (idx < 1) return defaultSort
    const col = raw.slice(0, idx)
    const dir = raw.slice(idx + 1)
    if (dir !== 'asc' && dir !== 'desc') return defaultSort
    // Allowlist check — only accept a column that exists and is
    // marked sortable. Defends against a hand-crafted ?sort=foo:asc URL.
    const exists = columns.some((c) => c.key === col && c.sortable)
    return exists
      ? { column: col, direction: dir as SortDirection }
      : defaultSort
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noUrlSync, searchParams, PK.sort, columns])

  const [page, setPageState] = useState(() => readPageFromUrl())
  const [pageSize, setPageSizeState] = useState(() => readSizeFromUrl())
  const [sort, setSortState] = useState<AdminTableSort>(() => readSortFromUrl())
  const [selected, setSelected] = useState<Set<string | number>>(new Set())
  const [pendingBulk, setPendingBulk] =
    useState<AdminTableBulkAction<Row> | null>(null)
  const [bulkRunning, setBulkRunning] = useState(false)

  // URL → state listener (browser back/forward). Bails when the URL
  // matches our last write to avoid a write/read loop against the
  // URL-sync effect below.
  const lastWroteUrlRef = useRef<string>('')
  useEffect(() => {
    if (mode === 'server' || noUrlSync) return
    const current = searchParams.toString()
    if (current === lastWroteUrlRef.current) return
    const nextPage = readPageFromUrl()
    const nextSize = readSizeFromUrl()
    const nextSort = readSortFromUrl()
    if (nextPage !== page) setPageState(nextPage)
    if (nextSize !== pageSize) setPageSizeState(nextSize)
    if (
      (nextSort?.column ?? null) !== (sort?.column ?? null) ||
      (nextSort?.direction ?? null) !== (sort?.direction ?? null)
    ) {
      setSortState(nextSort)
    }
  }, [
    searchParams,
    mode,
    noUrlSync,
    readPageFromUrl,
    readSizeFromUrl,
    readSortFromUrl,
    page,
    pageSize,
    sort,
  ])

  // State → URL writer.
  const didMount = useRef(false)
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      return
    }
    if (mode === 'server' || noUrlSync) return
    const params = new URLSearchParams(searchParams.toString())
    if (page > 1) params.set(PK.page, String(page))
    else params.delete(PK.page)
    if (pageSize !== pageSizeProp) params.set(PK.size, String(pageSize))
    else params.delete(PK.size)
    if (sort) params.set(PK.sort, `${sort.column}:${sort.direction}`)
    else params.delete(PK.sort)
    const next = params.toString()
    const current = searchParams.toString()
    if (next !== current) {
      lastWroteUrlRef.current = next
      router.replace(`${pathname}${next ? `?${next}` : ''}`, { scroll: false })
    }
  }, [
    page,
    pageSize,
    sort,
    mode,
    noUrlSync,
    pathname,
    PK.page,
    PK.size,
    PK.sort,
    pageSizeProp,
    router,
    searchParams,
  ])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  // Strip OUR url params on unmount so a sibling view (e.g. the
  // "Reorder" mode in /admin/projects) doesn't render against stale
  // page/sort state left behind by a prior table.
  useEffect(() => {
    if (mode === 'server' || noUrlSync) return
    return () => {
      const params = new URLSearchParams(window.location.search)
      let touched = false
      for (const key of [PK.page, PK.size, PK.sort]) {
        if (params.has(key)) {
          params.delete(key)
          touched = true
        }
      }
      if (touched) {
        const next = params.toString()
        const url = `${window.location.pathname}${next ? `?${next}` : ''}`
        window.history.replaceState(null, '', url)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Imperative reset hook for parent-driven mode toggles.
  useEffect(() => {
    if (selectionResetKey !== undefined) clearSelection()
  }, [selectionResetKey, clearSelection])

  const cycleSort = useCallback(
    (column: string) => {
      let next: AdminTableSort
      if (!sort || sort.column !== column) next = { column, direction: 'asc' }
      else if (sort.direction === 'asc') next = { column, direction: 'desc' }
      else next = null
      setSortState(next)
      setPageState(1)
      clearSelection()
      if (mode === 'server') {
        onSortChange?.(next)
        onPageChange?.(1)
      }
    },
    [sort, mode, onSortChange, onPageChange, clearSelection],
  )

  const setPage = useCallback(
    (next: number) => {
      setPageState(next)
      clearSelection()
      if (mode === 'server') onPageChange?.(next)
    },
    [mode, onPageChange, clearSelection],
  )

  const setPageSize = useCallback(
    (next: number) => {
      setPageSizeState(next)
      setPageState(1)
      clearSelection()
      if (mode === 'server') {
        onPageSizeChange?.(next)
        onPageChange?.(1)
      }
    },
    [mode, onPageSizeChange, onPageChange, clearSelection],
  )

  // Resolve the active sort accessor once. Depending on `columns`
  // identity at the memo level (rather than the column lookup) keeps
  // the sort cache stable when callers don't memoise the columns
  // array.
  const activeAccessor = useMemo(() => {
    if (!sort) return null
    const col = columns.find((c) => c.key === sort.column)
    if (!col) return null
    return (
      col.sortAccessor ??
      ((r: Row) =>
        (r as Record<string, unknown>)[col.key] as
          | string
          | number
          | Date
          | null
          | undefined)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort?.column, columns])

  const sortedRows = useMemo(() => {
    if (mode === 'server' || !sort || !activeAccessor) return rows
    const sign = sort.direction === 'asc' ? 1 : -1
    const sorted = [...rows].sort((a, b) => {
      const av = activeAccessor(a)
      const bv = activeAccessor(b)
      const aNull = av === null || av === undefined || av === ''
      const bNull = bv === null || bv === undefined || bv === ''
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      if (av instanceof Date && bv instanceof Date)
        return (av.getTime() - bv.getTime()) * sign
      if (typeof av === 'number' && typeof bv === 'number')
        return (av - bv) * sign
      const as = String(av).toLowerCase()
      const bs = String(bv).toLowerCase()
      if (as < bs) return -1 * sign
      if (as > bs) return 1 * sign
      return 0
    })
    return sorted
  }, [rows, sort, activeAccessor, mode])

  const totalCount = mode === 'server' ? total ?? 0 : sortedRows.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const clampedPage = Math.min(Math.max(1, page), totalPages)

  useEffect(() => {
    if (clampedPage !== page) setPage(clampedPage)
  }, [clampedPage, page, setPage])

  const visibleRows = useMemo(() => {
    if (mode === 'server') return rows
    return sortedRows.slice(
      (clampedPage - 1) * pageSize,
      clampedPage * pageSize,
    )
  }, [mode, rows, sortedRows, clampedPage, pageSize])

  // Selectable ids = visible rows that pass `isRowSelectable`.
  const selectableIds = useMemo(
    () => visibleRows.filter((r) => canSelect(r)).map((r) => getRowId(r)),
    [visibleRows, canSelect, getRowId],
  )

  // Prune stale ids from selection whenever rows shrink (parent
  // mutation, filter narrowing, etc.).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const present = new Set(rows.map((r) => getRowId(r)))
      let drift = false
      const next = new Set<string | number>()
      for (const id of prev) {
        if (present.has(id)) next.add(id)
        else drift = true
      }
      return drift ? next : prev
    })
  }, [rows, getRowId])

  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selected.has(id))
  const someSelected =
    selectableIds.some((id) => selected.has(id)) && !allSelected

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (allSelected) return new Set()
      const next = new Set(prev)
      for (const id of selectableIds) next.add(id)
      return next
    })
  }, [allSelected, selectableIds])

  const toggleRow = useCallback((id: string | number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedRows = useMemo(
    () => visibleRows.filter((r) => selected.has(getRowId(r))),
    [visibleRows, selected, getRowId],
  )

  const requestBulk = (action: AdminTableBulkAction<Row>) => {
    if (selectedRows.length === 0) return
    if (action.confirm) setPendingBulk(action)
    else void executeBulk(action)
  }

  const executeBulk = async (action: AdminTableBulkAction<Row>) => {
    if (selectedRows.length === 0) return
    setBulkRunning(true)
    try {
      const { ok, failed } = await action.run(selectedRows)
      if (ok > 0) toast.success(`${action.label(ok)} — done.`)
      if (failed.length > 0) {
        const reasons = Array.from(
          new Set(failed.map((f) => f.reason)),
        ).join('; ')
        toast.error(
          `${failed.length} ${failed.length === 1 ? 'item' : 'items'} could not be processed: ${reasons}`,
        )
      }
      // Treat `{ ok: 0, failed: [] }` as an early-exit signal (e.g.
      // the run aborted on a reauth cancel) — leave the selection
      // intact so the operator doesn't have to re-pick rows.
      if (ok > 0 || failed.length > 0) clearSelection()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Bulk action failed.'
      toast.error(msg)
    } finally {
      setBulkRunning(false)
      setPendingBulk(null)
    }
  }

  // Mobile sort change handler — used by MobileSortBar.
  const setSortFromMobile = useCallback(
    (next: AdminTableSort) => {
      setSortState(next)
      setPageState(1)
      clearSelection()
      if (mode === 'server') {
        onSortChange?.(next)
        onPageChange?.(1)
      }
    },
    [mode, onSortChange, onPageChange, clearSelection],
  )

  // ───────────────────────────── empty state
  if (!loading && rows.length === 0) {
    const content =
      hasActiveFilter && filteredEmptyState ? filteredEmptyState : emptyState
    return content === null ? null : <div>{content}</div>
  }

  const sortableColumns = columns.filter((c) => c.sortable)
  const showCheckboxColumn = bulkActions.length > 0

  return (
    <div className="space-y-4">
      <BulkBar
        count={selectedRows.length}
        actions={bulkActions}
        busy={bulkRunning}
        onAction={requestBulk}
        onClear={clearSelection}
        selectionLabel={selectionLabel}
      />

      <MobileSortBar
        componentId={componentId}
        sortableColumns={sortableColumns}
        sort={sort}
        onChange={setSortFromMobile}
      />

      <DesktopTable
        columns={columns}
        visibleRows={visibleRows}
        rowActions={rowActions}
        sort={sort}
        selected={selected}
        allSelected={allSelected}
        someSelected={someSelected}
        showCheckboxColumn={showCheckboxColumn}
        getRowId={getRowId}
        canSelect={canSelect}
        loading={loading}
        pageSize={pageSize}
        toggleAll={toggleAll}
        toggleRow={toggleRow}
        cycleSort={cycleSort}
      />

      <MobileCards
        columns={columns}
        visibleRows={visibleRows}
        rowActions={rowActions}
        mobileRowHeader={mobileRowHeader}
        selected={selected}
        showCheckboxColumn={showCheckboxColumn}
        getRowId={getRowId}
        canSelect={canSelect}
        loading={loading}
        toggleRow={toggleRow}
      />

      <Pagination
        componentId={componentId}
        page={clampedPage}
        totalPages={totalPages}
        totalCount={totalCount}
        pageSize={pageSize}
        pageSizeOptions={pageSizeOptions}
        loading={loading}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <ConfirmModal
        open={pendingBulk !== null}
        title={pendingBulk?.confirm?.title ?? 'Confirm'}
        description={
          pendingBulk?.confirm?.description(selectedRows.length) ?? ''
        }
        confirmLabel={pendingBulk?.confirm?.confirmLabel ?? 'Confirm'}
        destructive={pendingBulk?.destructive}
        busy={bulkRunning}
        onConfirm={() => {
          if (pendingBulk) void executeBulk(pendingBulk)
        }}
        onCancel={() => {
          if (!bulkRunning) setPendingBulk(null)
        }}
      />
    </div>
  )
}
