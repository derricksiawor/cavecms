'use client'

import { type ReactNode } from 'react'
import clsx from 'clsx'
import { Shimmer } from '@/components/inline-edit/Shimmer'
import type { AdminTableColumn } from './helpers'

// Card-list rendering used below `md`. One card per row, with a
// header (first sortable column or caller-provided), a dl/dt/dd block
// for the rest of the columns, and a row-actions slot at the bottom.

interface MobileCardsProps<Row> {
  columns: AdminTableColumn<Row>[]
  visibleRows: Row[]
  rowActions?: (row: Row) => ReactNode
  mobileRowHeader?: (row: Row) => ReactNode
  selected: Set<string | number>
  showCheckboxColumn: boolean
  getRowId: (row: Row) => string | number
  canSelect: (row: Row) => boolean
  loading: boolean
  toggleRow: (id: string | number) => void
}

export function MobileCards<Row>(props: MobileCardsProps<Row>) {
  const {
    columns,
    visibleRows,
    rowActions,
    mobileRowHeader,
    selected,
    showCheckboxColumn,
    getRowId,
    canSelect,
    loading,
    toggleRow,
  } = props

  // Skip (a) explicit mobileCardHide, (b) anything hidden below md or
  // lg — those are intentionally desktop-only and would be too wide
  // for a card row.
  const mobileCardColumns = columns.filter(
    (c) => !c.mobileCardHide && !c.hideOnMobile && !c.hideBelowLg,
  )

  // Mobile header fallback — first sortable column's cell, else the
  // first column's cell. Keeps the card readable when the caller
  // forgets `mobileRowHeader`.
  const headerFallback =
    columns.find((c) => c.sortable)?.cell ?? columns[0]?.cell ?? null
  const renderHeader = (row: Row): ReactNode =>
    mobileRowHeader ? mobileRowHeader(row) : headerFallback?.(row) ?? null

  return (
    <div className="md:hidden space-y-3">
      {loading
        ? Array.from({ length: 3 }).map((_, i) => (
            <div
              key={`skeleton-mobile-${i}`}
              className="rounded-2xl border border-warm-stone/15 bg-cream-50/50 px-4 py-3 space-y-2"
            >
              <Shimmer className="h-4 w-2/3" />
              <Shimmer className="h-3 w-1/2" />
            </div>
          ))
        : visibleRows.map((row) => {
            const id = getRowId(row)
            const isSel = selected.has(id)
            return (
              <div
                key={`mobile-${String(id)}`}
                className={clsx(
                  'rounded-2xl border bg-cream-50/60 px-4 py-3 transition-colors',
                  isSel
                    ? 'border-copper-400/50 bg-copper-50/40'
                    : 'border-warm-stone/15',
                )}
              >
                <div className="flex items-start gap-3">
                  {showCheckboxColumn && (
                    <input
                      type="checkbox"
                      aria-label={`Select row ${String(id)}`}
                      checked={isSel}
                      disabled={!canSelect(row)}
                      onChange={() => toggleRow(id)}
                      className="mt-1 h-4 w-4 cursor-pointer accent-copper-600 disabled:cursor-not-allowed disabled:opacity-40"
                    />
                  )}
                  <div className="flex-1 space-y-2">
                    <div className="font-medium text-near-black">
                      {renderHeader(row)}
                    </div>
                    {mobileCardColumns.length > 0 && (
                      <dl className="space-y-1">
                        {mobileCardColumns.map((col) => (
                          <div
                            key={col.key}
                            className="flex items-baseline justify-between gap-3 text-sm"
                          >
                            <dt className="shrink-0 text-[10px] uppercase tracking-[0.2em] text-warm-stone">
                              {col.label}
                            </dt>
                            <dd className="text-right text-near-black">
                              {col.cell(row)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {rowActions && (
                      <div className="pt-1 flex flex-wrap justify-end gap-2">
                        {rowActions(row)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
    </div>
  )
}
