'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { Shimmer } from '@/components/inline-edit/Shimmer'
import { SortIndicator } from './SortIndicator'
import type { AdminTableColumn, AdminTableSort } from './helpers'

// Desktop (md+) table — header row + sortable column buttons + body
// rows. Skeleton loader fills the body while `loading`. The
// select-all checkbox uses a ref to set `indeterminate` because React
// doesn't expose it as a controlled prop.

interface DesktopTableProps<Row> {
  columns: AdminTableColumn<Row>[]
  visibleRows: Row[]
  rowActions?: (row: Row) => ReactNode
  sort: AdminTableSort
  selected: Set<string | number>
  allSelected: boolean
  someSelected: boolean
  showCheckboxColumn: boolean
  getRowId: (row: Row) => string | number
  canSelect: (row: Row) => boolean
  loading: boolean
  pageSize: number
  toggleAll: () => void
  toggleRow: (id: string | number) => void
  cycleSort: (column: string) => void
}

export function DesktopTable<Row>(props: DesktopTableProps<Row>) {
  const {
    columns,
    visibleRows,
    rowActions,
    sort,
    selected,
    allSelected,
    someSelected,
    showCheckboxColumn,
    getRowId,
    canSelect,
    loading,
    pageSize,
    toggleAll,
    toggleRow,
    cycleSort,
  } = props

  const selectAllRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  return (
    <div className="hidden md:block overflow-hidden rounded-2xl border border-warm-stone/15 bg-cream-50/50">
      <table className="w-full text-sm">
        <thead className="border-b border-warm-stone/15 bg-cream-50/80 text-[10px] uppercase tracking-[0.2em] text-warm-stone">
          <tr>
            {showCheckboxColumn && (
              <th scope="col" className="w-10 px-4 py-3">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label={
                    allSelected
                      ? 'Deselect all rows'
                      : 'Select all rows on this page'
                  }
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer accent-copper-600"
                />
              </th>
            )}
            {columns.map((col) => {
              const isSorted = sort?.column === col.key
              const align =
                col.align === 'right'
                  ? 'text-right'
                  : col.align === 'center'
                    ? 'text-center'
                    : 'text-left'
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={
                    isSorted
                      ? sort?.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : col.sortable
                        ? 'none'
                        : undefined
                  }
                  className={clsx(
                    'whitespace-nowrap px-4 py-3 font-semibold',
                    align,
                    colHideClass(col),
                  )}
                  style={col.width ? { width: col.width } : undefined}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => cycleSort(col.key)}
                      className={clsx(
                        'inline-flex items-center gap-1 transition-colors',
                        isSorted
                          ? 'text-near-black'
                          : 'text-warm-stone hover:text-near-black',
                      )}
                    >
                      <span>{col.label}</span>
                      <SortIndicator
                        state={isSorted ? sort?.direction ?? null : null}
                      />
                    </button>
                  ) : (
                    <span>{col.label}</span>
                  )}
                </th>
              )
            })}
            {rowActions && (
              <th scope="col" className="w-px px-4 py-3 text-right">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: Math.min(pageSize, 5) }).map((_, i) => (
                <tr
                  key={`skeleton-${i}`}
                  className="border-t border-warm-stone/10"
                >
                  {showCheckboxColumn && (
                    <td className="px-4 py-3">
                      <Shimmer className="h-4 w-4" rounded="sm" />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={clsx('px-4 py-3', colHideClass(col))}
                    >
                      <Shimmer className="h-3" />
                    </td>
                  ))}
                  {rowActions && (
                    <td className="px-4 py-3">
                      <Shimmer className="h-3 w-12" />
                    </td>
                  )}
                </tr>
              ))
            : visibleRows.map((row) => {
                const id = getRowId(row)
                const isSel = selected.has(id)
                return (
                  <tr
                    key={String(id)}
                    // `group/admin-row` named-group so child components
                    // (e.g. PagesClient's inline action icons) can use
                    // `group-hover/admin-row:opacity-100` to reveal
                    // themselves on row hover without leaking to other
                    // ancestors that also use group state.
                    className={clsx(
                      'group/admin-row border-t border-warm-stone/10 transition-colors',
                      isSel ? 'bg-copper-50/30' : 'hover:bg-cream-50',
                    )}
                  >
                    {showCheckboxColumn && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select row ${String(id)}`}
                          checked={isSel}
                          disabled={!canSelect(row)}
                          onChange={() => toggleRow(id)}
                          className="h-4 w-4 cursor-pointer accent-copper-600 disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={clsx(
                          'px-4 py-3',
                          col.align === 'right' && 'text-right',
                          col.align === 'center' && 'text-center',
                          colHideClass(col),
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="px-4 py-3 text-right">
                        {rowActions(row)}
                      </td>
                    )}
                  </tr>
                )
              })}
        </tbody>
      </table>
    </div>
  )
}

function colHideClass<Row>(col: AdminTableColumn<Row>): string {
  if (col.hideBelowLg) return 'hidden lg:table-cell'
  if (col.hideOnMobile) return 'hidden md:table-cell'
  return ''
}
