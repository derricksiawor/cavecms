'use client'

import { X } from 'lucide-react'
import { PillButton } from '@/components/admin/PillButton'
import type { AdminTableBulkAction } from './helpers'

// Slides in above the table when ≥1 row is selected. Renders the
// bulk actions inline with a Clear button on the right. The bar is
// page-scoped — selection clears on page / sort / pageSize change.

export function BulkBar<Row>({
  count,
  actions,
  busy,
  onAction,
  onClear,
  selectionLabel,
}: {
  count: number
  actions: AdminTableBulkAction<Row>[]
  busy: boolean
  onAction: (action: AdminTableBulkAction<Row>) => void
  onClear: () => void
  selectionLabel?: string
}) {
  if (count === 0) return null
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-copper-300/40 bg-copper-50/40 px-4 py-3 animate-bwc-fade-in"
    >
      <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black">
        {count} {count === 1 ? 'item' : 'items'} {selectionLabel ?? 'selected'}
      </span>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {actions.map((action) => (
          <PillButton
            key={action.id}
            onClick={() => onAction(action)}
            disabled={busy}
            icon={action.icon}
            size="md"
            variant={action.destructive ? 'destructive' : 'filled'}
          >
            {action.label(count)}
          </PillButton>
        ))}
        <PillButton
          onClick={onClear}
          disabled={busy}
          icon={X}
          size="md"
          variant="subtle"
        >
          Clear
        </PillButton>
      </div>
    </div>
  )
}
