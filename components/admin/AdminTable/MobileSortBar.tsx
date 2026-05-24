'use client'

import { ChevronUp, ChevronDown } from 'lucide-react'
import type { ChangeEvent } from 'react'
import type { AdminTableColumn, AdminTableSort, SortDirection } from './helpers'

// Sort picker shown below `md`. A column-picker `<select>` paired with
// an asc/desc toggle button. Replaces the older "2N options" approach
// which became unreadable when a list had 5+ sortable columns.

export function MobileSortBar<Row>({
  componentId,
  sortableColumns,
  sort,
  onChange,
}: {
  componentId: string
  sortableColumns: AdminTableColumn<Row>[]
  sort: AdminTableSort
  onChange: (next: AdminTableSort) => void
}) {
  if (sortableColumns.length === 0) return null
  const column = sort?.column ?? ''
  const direction: SortDirection = sort?.direction ?? 'asc'

  const onColumnChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const col = e.target.value
    if (!col) {
      onChange(null)
      return
    }
    onChange({ column: col, direction })
  }

  const toggleDir = () => {
    if (!sort) return
    onChange({
      column: sort.column,
      direction: sort.direction === 'asc' ? 'desc' : 'asc',
    })
  }

  return (
    <div className="flex items-center gap-2 md:hidden">
      <label
        htmlFor={`${componentId}-mobile-sort-col`}
        className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
      >
        Sort by
      </label>
      <select
        id={`${componentId}-mobile-sort-col`}
        value={column}
        onChange={onColumnChange}
        className="flex-1 rounded-xl border border-warm-stone/30 bg-cream-50 px-3 py-2 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-400/40"
      >
        <option value="">Default order</option>
        {sortableColumns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={toggleDir}
        disabled={!sort}
        aria-label={direction === 'asc' ? 'Sort descending' : 'Sort ascending'}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/30 text-near-black transition-colors hover:border-copper-400 disabled:opacity-40"
      >
        {direction === 'asc' ? (
          <ChevronUp size={14} strokeWidth={2.2} />
        ) : (
          <ChevronDown size={14} strokeWidth={2.2} />
        )}
      </button>
    </div>
  )
}
