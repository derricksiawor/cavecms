import type { HydratedBlock } from './hydrate'

// Tree shape + partition for the migration-0011 section→column→widget
// hierarchy. Pure value/struct manipulation; no `server-only` import
// because the OutlinePanel (client component) may want to call this
// to render its sidebar tree.
//
// Settings + className lookups for sections + columns live in
// `./blockMeta.ts` so client components (EditDrawer, OutlinePanel)
// can import meta parsers WITHOUT pulling in HydratedBlock and the
// transitive server-only types.

// Re-export the meta API at the tree-module surface so existing
// callers can still `import { parseSectionMeta } from './blockTree'`
// while new client-only callers prefer `from './blockMeta'`.
export {
  DEFAULT_SECTION_META,
  parseColumnMeta,
  parseSectionMeta,
  SECTION_BACKGROUND_CLASS,
  SECTION_BACKGROUND_LABEL,
  SECTION_COLUMNS_CLASS,
  SECTION_PADDING_CLASS,
  SECTION_PADDING_LABEL,
  type ColumnMeta,
  type SectionBackground,
  type SectionColumnsCount,
  type SectionMeta,
  type SectionPadding,
} from './blockMeta'

export interface ColumnNode {
  column: HydratedBlock
  widgets: HydratedBlock[]
}

export interface SectionNode {
  section: HydratedBlock
  columns: ColumnNode[]
}

export type TreeNode =
  | { kind: 'section'; node: SectionNode }
  | { kind: 'looseWidget'; node: HydratedBlock }

/**
 * Bucket an iterable of blocks by parent_id and sort each bucket by
 * position. Shared by `buildBlockTree` (renderer), the DnD client
 * shell (drag-end sibling lookup), and the reorder endpoint (drift
 * check). Centralising the primitive prevents three subtly different
 * impls from drifting on ordering semantics under equal positions.
 *
 * The position comparator is stable (Array.prototype.sort is stable
 * per ES2019); ties preserve input order — which is whatever order
 * mysql2 returned the rows in, typically `ORDER BY position`.
 */
export function groupByParent<
  T extends { parentId: number | null; position: number },
>(blocks: T[]): Map<number | null, T[]> {
  const byParent = new Map<number | null, T[]>()
  for (const b of blocks) {
    const arr = byParent.get(b.parentId) ?? []
    arr.push(b)
    byParent.set(b.parentId, arr)
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.position - b.position)
  }
  return byParent
}

/**
 * Partition the flat HydratedBlock[] into the 2-level section→column→
 * widget tree (migration 0011). Top-level entries are either:
 *   - a section (with its column children + widget grandchildren), or
 *   - a "loose" top-level widget (legacy rows + back-compat path).
 *
 * Per-parent buckets are sorted by `position` so renderer order matches
 * the operator's drag-drop intent. Orphan rows (e.g. kind='column' at
 * top-level — schema invariant violation) are silently skipped: the
 * post-migrate asserts in scripts/post-migrate-asserts.ts catch the
 * underlying data corruption; the renderer must not 500.
 *
 * When a section row has a child whose kind is NOT 'column' (a widget
 * accidentally re-parented to a section, or kind drift) we drop the
 * child and emit one `console.warn` per render so live invariant
 * violations are observable between offline assert runs. ONE log per
 * affected section, not per dropped child, so a single corruption
 * doesn't flood the request log.
 *
 * O(N) — single pass to bucket, single pass per parent to sort, single
 * pass over top-level to assemble.
 */
export function buildBlockTree(blocks: HydratedBlock[]): TreeNode[] {
  if (blocks.length === 0) return []

  const byParent = groupByParent(blocks)
  const topLevel = byParent.get(null) ?? []
  const result: TreeNode[] = []

  // Orphan walk — flag any row whose parent_id references an id that's
  // not in the supplied block set. Soft-delete doesn't cascade through
  // the FK (CASCADE only fires on hard delete), so a manual SQL fixup
  // or a delete-handler bug could leave widgets parented to a soft-
  // deleted column. Pre-fix those rows vanished from the rendered tree
  // with no diagnostic. One log line per render per affected page.
  const liveIds = new Set(blocks.map((b) => b.id))
  const orphanIds: number[] = []
  for (const b of blocks) {
    if (b.parentId === null) continue
    if (!liveIds.has(b.parentId)) orphanIds.push(b.id)
  }
  if (orphanIds.length > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'block_tree_orphan_rows_dropped',
        orphan_ids: orphanIds.slice(0, 20),
        total: orphanIds.length,
      }),
    )
  }

  for (const top of topLevel) {
    if (top.kind === 'section') {
      const children = byParent.get(top.id) ?? []
      const columns: ColumnNode[] = []
      let invalidChildren = 0
      for (const child of children) {
        if (child.kind !== 'column') {
          invalidChildren += 1
          continue
        }
        const widgets = (byParent.get(child.id) ?? []).filter(
          (w) => w.kind === 'widget',
        )
        columns.push({ column: child, widgets })
      }
      if (invalidChildren > 0) {
        // Live invariant violation — surface it without flooding logs.
        // One row per render per affected section. Forensics path picks
        // the section id out and the post-migrate-asserts gate catches
        // the underlying corruption on the next deploy.
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'block_tree_section_invalid_child_kinds',
            section_id: top.id,
            dropped: invalidChildren,
          }),
        )
      }
      result.push({ kind: 'section', node: { section: top, columns } })
    } else if (top.kind === 'widget') {
      result.push({ kind: 'looseWidget', node: top })
    } else {
      // top.kind === 'column' at parentId=null is an invariant
      // violation — surface it loudly so the operator sees the
      // disappearing column without waiting for the next deploy's
      // post-migrate-asserts gate. Throttled by Map.set in
      // groupByParent / one row per affected column per render.
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'block_tree_column_at_top_level',
          block_id: top.id,
        }),
      )
    }
  }

  return result
}
