'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { computePageRange } from './helpers'

// Pagination footer = page-size dropdown on the left, page-number nav
// + prev/next chevrons on the right. Stacks vertically below `md`.
// The page-range computation lives in helpers.ts so it can be unit-
// tested without the JSX dependency.

export function Pagination({
  componentId,
  page,
  totalPages,
  totalCount,
  pageSize,
  pageSizeOptions,
  loading,
  onPageChange,
  onPageSizeChange,
}: {
  componentId: string
  page: number
  totalPages: number
  totalCount: number
  pageSize: number
  pageSizeOptions: number[]
  loading: boolean
  onPageChange: (next: number) => void
  onPageSizeChange: (next: number) => void
}) {
  if (totalCount <= 0) return null
  const pages = computePageRange(page, totalPages)
  return (
    <div className="flex flex-col gap-3 pt-2 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-2">
        <label
          htmlFor={`${componentId}-pagesize`}
          className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
        >
          Show
        </label>
        <select
          id={`${componentId}-pagesize`}
          value={pageSize}
          onChange={(e) => onPageSizeChange(parseInt(e.target.value, 10))}
          className="rounded-xl border border-warm-stone/30 bg-cream-50 px-3 py-1.5 text-sm text-near-black focus:outline-none focus:ring-2 focus:ring-copper-400/40"
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          per page
        </span>
        <span className="hidden text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone sm:inline-block">
          · {totalCount} total
        </span>
      </div>

      <nav
        aria-label="Pagination"
        className="flex flex-wrap items-center justify-end gap-1"
      >
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1 || loading}
          aria-label="Previous page"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/25 text-warm-stone transition-colors hover:border-near-black hover:text-near-black disabled:opacity-40 disabled:hover:border-warm-stone/25 disabled:hover:text-warm-stone"
        >
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
        {pages.map((p, i) =>
          p === '…' ? (
            <span
              key={`ellipsis-${i}`}
              className="px-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone"
            >
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              disabled={loading}
              aria-current={p === page ? 'page' : undefined}
              className={clsx(
                'inline-flex h-9 min-w-9 items-center justify-center rounded-full px-3 text-[11px] font-semibold uppercase tracking-[0.2em] transition-colors',
                p === page
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
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages || loading}
          aria-label="Next page"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-warm-stone/25 text-warm-stone transition-colors hover:border-near-black hover:text-near-black disabled:opacity-40 disabled:hover:border-warm-stone/25 disabled:hover:text-warm-stone"
        >
          <ChevronRight size={16} strokeWidth={2} />
        </button>
      </nav>
    </div>
  )
}
