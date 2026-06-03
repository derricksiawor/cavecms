// Pure tree utilities for the outline drag-and-drop (Elementor-style nest +
// reparent). The OutlinePanel renders a FLAT, depth-ordered list inside ONE
// dnd-kit SortableContext; these helpers flatten the section→column→widget
// tree and compute a grammar-aware drop projection (the canonical dnd-kit tree
// pattern: arrayMove the flat list to the over-slot, read prev/next, derive the
// landing depth from the horizontal drag offset, then resolve {parentId,index}
// per grammar). Pure → unit-reasoned, no React/dnd-kit-event coupling.
//
// CaveCMS block grammar (strict 3-level + legacy loose widgets):
//   section (parentId null, depth 0)
//     column (parent = section, depth 1)
//       widget (parent = column, depth 2)
//   loose widget (parentId null, depth 0) — legacy top-level widgets
// A drag may only land where the grammar permits; invalid projections render a
// blocked indicator (no-drop) and are refused on drop.

import { arrayMove } from '@dnd-kit/sortable'
import type { BlockKind } from '@/lib/cms/blockMeta'

export interface OutlineItem {
  id: number
  blockKey: string | null
  blockType: string
  version: number
  kind: BlockKind
  parentId: number | null
}

export interface FlatNode {
  item: OutlineItem
  /** 0 = section / loose widget, 1 = column, 2 = widget-in-column */
  depth: number
  flatIndex: number
  collapsed: boolean
  childCount: number
  orphan: boolean
}

export interface Projection {
  /** resolved parent for the dragged block at the current pointer */
  parentId: number | null
  /** index among the resolved parent's children where it will land */
  index: number
  /** indentation depth to render the drop indicator at */
  depth: number
  /** false → grammar-invalid target; render blocked, refuse on drop */
  valid: boolean
}

// ── grammar ────────────────────────────────────────────────────────────────

export function depthForKind(kind: BlockKind): number {
  if (kind === 'section') return 0
  if (kind === 'column') return 1
  return 2
}

/** May a block of `kind` be a direct child of a parent of `parentKind`
 *  (null = root)? Encodes the strict grammar + the legacy loose-widget path. */
export function canBeChildOf(
  kind: BlockKind,
  parentKind: BlockKind | null,
): boolean {
  if (kind === 'section') return parentKind === null
  if (kind === 'column') return parentKind === 'section'
  return parentKind === 'column' || parentKind === null // widget
}

// ── flatten ──────────────────────────────────────────────────────────────

function bucketByParent(
  items: OutlineItem[],
): Map<number | null, OutlineItem[]> {
  const byParent = new Map<number | null, OutlineItem[]>()
  for (const b of items) {
    const arr = byParent.get(b.parentId) ?? []
    arr.push(b)
    byParent.set(b.parentId, arr)
  }
  return byParent
}

/**
 * Flatten the block tree into a depth-first ordered list, omitting the
 * descendants of any collapsed container. Items arrive in position order per
 * parent (server-ordered), so no re-sort. Orphans (parent not present) are
 * surfaced at the end at depth 0. Cycle-guarded.
 */
export function flattenTree(
  items: OutlineItem[],
  collapsed: Set<number>,
): FlatNode[] {
  const byParent = bucketByParent(items)
  const ids = new Set(items.map((b) => b.id))
  const out: FlatNode[] = []

  const push = (parentId: number | null, depth: number, seen: Set<number>) => {
    for (const item of byParent.get(parentId) ?? []) {
      if (seen.has(item.id)) continue // cycle guard
      const childList = byParent.get(item.id) ?? []
      const isCollapsed = collapsed.has(item.id)
      out.push({
        item,
        depth,
        flatIndex: out.length,
        collapsed: isCollapsed,
        childCount: childList.length,
        orphan: false,
      })
      if (!isCollapsed && childList.length > 0) {
        const next = new Set(seen)
        next.add(item.id)
        push(item.id, depth + 1, next)
      }
    }
  }
  push(null, 0, new Set())

  const orphanSeen = new Set<number>()
  for (const [pid, bucket] of byParent) {
    if (pid === null || ids.has(pid)) continue
    for (const orphan of bucket) {
      if (orphanSeen.has(orphan.id)) continue
      orphanSeen.add(orphan.id)
      out.push({
        item: orphan,
        depth: 0,
        flatIndex: out.length,
        collapsed: collapsed.has(orphan.id),
        childCount: (byParent.get(orphan.id) ?? []).length,
        orphan: true,
      })
    }
  }
  out.forEach((n, i) => (n.flatIndex = i))
  return out
}

/** Ids of every descendant of `rootId` (exclusive). Used to (a) skip the
 *  dragged subtree while it's collapsed under the cursor, and (b) reject a drop
 *  into the node's own descendant (cycle). */
export function descendantIds(
  items: OutlineItem[],
  rootId: number,
): Set<number> {
  const byParent = bucketByParent(items)
  const out = new Set<number>()
  const walk = (pid: number) => {
    for (const c of byParent.get(pid) ?? []) {
      if (out.has(c.id)) continue
      out.add(c.id)
      walk(c.id)
    }
  }
  walk(rootId)
  return out
}

// ── projection ─────────────────────────────────────────────────────────────

const INDENT_STEPS = (offsetLeft: number, indentWidth: number): number =>
  Math.round(offsetLeft / indentWidth)

/** Nearest row at index `< from` whose kind === target (scanning back). */
function scanBack(
  flat: FlatNode[],
  from: number,
  pred: (n: FlatNode) => boolean,
): FlatNode | null {
  for (let i = Math.min(from, flat.length) - 1; i >= 0; i--) {
    if (pred(flat[i]!)) return flat[i]!
  }
  return null
}

/**
 * Canonical dnd-kit tree projection, grammar-constrained. `flat` is the FULL
 * visible flat list (collapsed subtrees already omitted). Returns where the
 * dragged block lands + whether the grammar allows it.
 *
 *  - SECTION → always root (depth 0); reorders among sections.
 *  - COLUMN  → under the section owning the slot (depth 1); invalid if none.
 *  - WIDGET  → under the column owning the slot (depth 2); or loose at root
 *              (depth 0) when there's no column OR the operator dragged left
 *              (offsetLeft) past the un-nest threshold at a column-end boundary.
 */
export function getProjection(
  flat: FlatNode[],
  activeId: number,
  overId: number,
  offsetLeft: number,
  indentWidth: number,
): Projection {
  const overIndex = flat.findIndex((n) => n.item.id === overId)
  const activeIndex = flat.findIndex((n) => n.item.id === activeId)
  if (overIndex < 0 || activeIndex < 0) {
    return { parentId: null, index: 0, depth: 0, valid: false }
  }
  // Move active to the over-slot so prev/next reflect the projected order and
  // the sibling-index count naturally excludes the dragged row (no off-by-one).
  const moved = arrayMove(flat, activeIndex, overIndex)
  const active = flat[activeIndex]!
  const kind = active.item.kind
  const prev = moved[overIndex - 1] ?? null
  const next = moved[overIndex + 1] ?? null
  const dragSteps = INDENT_STEPS(offsetLeft, indentWidth)

  const indexAmong = (parentId: number | null): number => {
    let n = 0
    for (let i = 0; i < overIndex; i++) {
      if (moved[i]!.item.parentId === parentId) n++
    }
    return n
  }

  // SECTION — root only.
  if (kind === 'section') {
    return { parentId: null, index: indexAmong(null), depth: 0, valid: true }
  }

  // COLUMN — nearest section at/above the slot.
  if (kind === 'column') {
    const section = scanBack(moved, overIndex, (n) => n.item.kind === 'section')
    if (!section) return { parentId: null, index: 0, depth: 1, valid: false }
    return {
      parentId: section.item.id,
      index: indexAmong(section.item.id),
      depth: 1,
      valid: true,
    }
  }

  // WIDGET — nearest column, or loose at root.
  // Column owning the slot: prev if it's a column (drop as first child), else
  // prev's parent column if prev is a widget.
  let column: OutlineItem | null = null
  if (prev) {
    if (prev.item.kind === 'column') column = prev.item
    else if (prev.item.kind === 'widget' && prev.item.parentId != null) {
      const c = flat.find((n) => n.item.id === prev.item.parentId)
      column = c ? c.item : null
    }
  }
  const atColumnEnd =
    column != null && (!next || next.item.parentId !== column.id)
  const rootGap =
    (prev == null || prev.depth === 0) && (next == null || next.depth === 0)
  // Un-nest: dragged left (dragSteps <= -1) at a column-end boundary → loose.
  if ((rootGap && dragSteps <= 0) || (atColumnEnd && dragSteps <= -1)) {
    if (canBeChildOf('widget', null)) {
      return { parentId: null, index: indexAmong(null), depth: 0, valid: true }
    }
  }
  if (column) {
    return {
      parentId: column.id,
      index: indexAmong(column.id),
      depth: 2,
      valid: true,
    }
  }
  // No column context: loose if a root gap, else invalid (e.g. between a
  // section header and its first column — a widget can't live there).
  if (rootGap && canBeChildOf('widget', null)) {
    return { parentId: null, index: indexAmong(null), depth: 0, valid: true }
  }
  return { parentId: null, index: 0, depth: 2, valid: false }
}
