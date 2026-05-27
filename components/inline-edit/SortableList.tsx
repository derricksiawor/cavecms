'use client'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState, type ReactNode } from 'react'

// Wrapper that lets any list of items become drag-reorderable. The
// caller renders the row content via `renderItem`; we provide the
// dnd-kit wiring, the drag handle, and the up/down/remove buttons.
//
// `getId` extracts a stable id from each item — fall back to the
// index for arrays of primitives. The handle is scoped to a grip
// icon so click handlers inside the row (buttons, inputs) work
// without triggering drag.
//
// Visual drag affordance:
//   • The in-place row dims to opacity 0.25 while dragging — the
//     operator can still see the slot it left and the other rows
//     reflowing around the gap.
//   • A `<DragOverlay>` portal renders a floating clone of the row
//     that follows the cursor, with a copper ring + drop shadow.
//   • The fade-in mount animation is intentionally NOT applied on the
//     row root — that keyframe targets `transform`, which overrides
//     dnd-kit's inline transform during drag and made the dragging
//     row appear visually frozen in place.
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

  const [activeId, setActiveId] = useState<string | null>(null)

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id))
  }
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    if (!e.over || e.active.id === e.over.id) return
    const oldIdx = items.findIndex((it, i) => String(getId(it, i)) === String(e.active.id))
    const newIdx = items.findIndex((it, i) => String(getId(it, i)) === String(e.over!.id))
    if (oldIdx < 0 || newIdx < 0) return
    onChange(arrayMove(items, oldIdx, newIdx))
  }
  const onDragCancel = () => setActiveId(null)

  // Callers (all three live in ZodForm) coerce non-arrays to `[]`
  // before passing through — see SocialLinkArrayField / ObjectArrayField
  // / MediaArrayField. The TS `items: T[]` prop type enforces this at
  // compile time too. A runtime Array.isArray check here would be
  // dead code AND silently mask a future caller that violates the
  // contract; better to let `items.length` throw and surface the bug.
  if (items.length === 0) {
    return <>{emptyState}</>
  }

  const activeIdx =
    activeId === null
      ? -1
      : items.findIndex((it, i) => String(getId(it, i)) === activeId)
  // `items[activeIdx]` is `T | undefined` under strict
  // noUncheckedIndexedAccess. The activeIdx >= 0 guard pairs with a
  // non-null assertion so the variable narrows cleanly to T for the
  // DragOverlay clone below; the only way activeItem reads as a real
  // T value is when activeIdx points at a still-present row.
  const activeItem: T | null = activeIdx >= 0 ? items[activeIdx]! : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
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
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}>
        {activeItem !== null ? (
          <div className="cavecms-drag-preview rounded-md bg-cream-50 ring-1 ring-copper-500/60 shadow-[0_20px_60px_-15px_rgba(112,66,20,0.45)]">
            {renderItem(activeItem, activeIdx, {
              handleProps: {},
              isFirst: activeIdx === 0,
              isLast: activeIdx === items.length - 1,
              moveUp: () => {},
              moveDown: () => {},
              remove: () => {},
            })}
          </div>
        ) : null}
      </DragOverlay>
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
        opacity: isDragging ? 0.25 : 1,
      }}
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
