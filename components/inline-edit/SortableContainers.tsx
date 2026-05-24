'use client'

import type { ReactNode } from 'react'
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import clsx from 'clsx'
import { encodeEmptyColumnDropId } from './EditModeDndShell'

// Three thin client wrappers around dnd-kit's SortableContext + the
// empty-column useDroppable. The actual draggable items are rendered
// inside as server-side children (the editable shells declare their
// own useSortable). Splitting these out keeps BlockTreeRenderer a
// server component while still mounting client contexts where the
// hierarchy requires them.
//
// Top-level uses verticalListSortingStrategy because sections + loose
// top-level widgets stack vertically. Per-section uses horizontal
// (columns sit side-by-side in a CSS grid). Per-column uses vertical.

export function TopLevelSortable({
  items,
  children,
}: {
  items: number[]
  children: ReactNode
}) {
  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  )
}

export function SectionColumnsSortable({
  items,
  children,
}: {
  items: number[]
  children: ReactNode
}) {
  return (
    <SortableContext items={items} strategy={horizontalListSortingStrategy}>
      {children}
    </SortableContext>
  )
}

export function ColumnWidgetsSortable({
  items,
  children,
}: {
  items: number[]
  children: ReactNode
}) {
  return (
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  )
}

// Empty-column drop zone. Registers a useDroppable with the synthetic
// `empty-col:NN` id so a widget dragged onto an empty column lands
// inside it. The visual is owned by the caller (EmptyColumnSlot);
// we just add a ring + color shift when an active draggable is over
// us so the operator gets confirmation.
export function EmptyColumnDroppable({
  columnId,
  children,
  className,
}: {
  columnId: number
  children: ReactNode
  className?: string
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: encodeEmptyColumnDropId(columnId),
    data: { containerId: columnId, kind: 'empty-column' },
  })
  // Highlight only when something is being dragged (active truthy)
  // AND the cursor is inside this zone. Avoids a stuck highlight
  // when an unrelated re-render lands while the operator hovers.
  const highlight = isOver && active !== null
  return (
    <div
      ref={setNodeRef}
      className={clsx(
        className,
        highlight && 'ring-2 ring-copper-400 ring-offset-2 ring-offset-cream',
      )}
    >
      {children}
    </div>
  )
}
