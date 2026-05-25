'use client'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'

// Wrapper that lets any list of items become drag-reorderable. The
// caller renders the row content via `renderItem`; we provide the
// dnd-kit wiring, the drag handle, and the up/down/remove buttons.
//
// `getId` extracts a stable id from each item — fall back to the
// index for arrays of primitives. The handle is scoped to a grip
// icon so click handlers inside the row (buttons, inputs) work
// without triggering drag.
export function SortableList<T>({
  items,
  onChange,
  getId,
  renderItem,
  emptyState,
}: {
  items: T[]
  onChange: (next: T[]) => void
  getId: (item: T, index: number) => string | number
  renderItem: (
    item: T,
    i: number,
    helpers: {
      moveUp: () => void
      moveDown: () => void
      remove: () => void
      handleProps: Record<string, unknown>
      isFirst: boolean
      isLast: boolean
    },
  ) => ReactNode
  emptyState?: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const oldIdx = items.findIndex((it, i) => String(getId(it, i)) === String(e.active.id))
    const newIdx = items.findIndex((it, i) => String(getId(it, i)) === String(e.over!.id))
    if (oldIdx < 0 || newIdx < 0) return
    onChange(arrayMove(items, oldIdx, newIdx))
  }

  // Callers (all three live in ZodForm) coerce non-arrays to `[]`
  // before passing through — see SocialLinkArrayField / ObjectArrayField
  // / MediaArrayField. The TS `items: T[]` prop type enforces this at
  // compile time too. A runtime Array.isArray check here would be
  // dead code AND silently mask a future caller that violates the
  // contract; better to let `items.length` throw and surface the bug.
  if (items.length === 0) {
    return <>{emptyState}</>
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext
        items={items.map((it, i) => String(getId(it, i)))}
        strategy={verticalListSortingStrategy}
      >
        <ul className="space-y-3 list-none p-0">
          {items.map((item, i) => (
            <SortableRow
              key={String(getId(item, i))}
              id={String(getId(item, i))}
            >
              {(handleProps) =>
                renderItem(item, i, {
                  handleProps,
                  isFirst: i === 0,
                  isLast: i === items.length - 1,
                  moveUp: () => {
                    if (i === 0) return
                    const next = [...items]
                    ;[next[i - 1], next[i]] = [next[i]!, next[i - 1]!]
                    onChange(next)
                  },
                  moveDown: () => {
                    if (i === items.length - 1) return
                    const next = [...items]
                    ;[next[i + 1], next[i]] = [next[i]!, next[i + 1]!]
                    onChange(next)
                  },
                  remove: () => onChange(items.filter((_, j) => j !== i)),
                })
              }
            </SortableRow>
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function SortableRow({
  id,
  children,
}: {
  id: string
  children: (handleProps: Record<string, unknown>) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
        opacity: isDragging ? 0.85 : 1,
      }}
      className="animate-cavecms-fade-in"
    >
      {children({ ...attributes, ...listeners })}
    </li>
  )
}

// Standalone drag handle component the caller can drop into renderItem.
// Visual: copper-tinted grip dots, 44px touch target.
export function DragHandle({ handleProps }: { handleProps: Record<string, unknown> }) {
  return (
    <button
      type="button"
      aria-label="Drag to reorder"
      className="inline-flex h-11 w-8 cursor-grab items-center justify-center text-warm-stone hover:text-copper-700 transition-colors active:cursor-grabbing select-none"
      {...handleProps}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="9" cy="6" r="1.5" />
        <circle cx="15" cy="6" r="1.5" />
        <circle cx="9" cy="12" r="1.5" />
        <circle cx="15" cy="12" r="1.5" />
        <circle cx="9" cy="18" r="1.5" />
        <circle cx="15" cy="18" r="1.5" />
      </svg>
    </button>
  )
}
