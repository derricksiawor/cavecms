// Pure, framework-free tree logic shared by the header + footer menu
// builders. Operates on a normalized internal `MenuNode[]` (depth 1 max)
// so the builder UI is decoupled from the raw header/footer value shapes,
// which differ in field names:
//   header → { label, href, children:[{ label, href }] }
//   footer → { label, links:[{ text, href }] }  (column = heading, no href)
//
// `__id` is carried back into the value on denormalize (mirrors the
// ObjectArrayField pattern in ZodForm.tsx) so dnd row identity + input
// focus stay stable across re-renders while editing. The server's Zod
// schema strips the unknown `__id` key on save, so it never persists.

export interface MenuConfig {
  // Key holding the parent's link target. Omit for footer columns
  // (a column is a heading, not a link).
  parentHrefKey?: string
  // Key holding the children array: 'children' (header) | 'links' (footer).
  childrenKey: string
  // Key holding a child's label: 'label' (header) | 'text' (footer).
  childLabelKey: string
  // Key holding a child's href (always 'href').
  childHrefKey: string
  maxItems: number
  maxChildren: number
}

export interface MenuLeaf {
  id: string
  label: string
  href: string
}
export interface MenuNode {
  id: string
  label: string
  // undefined for footer columns (no parent href).
  href?: string
  children: MenuLeaf[]
}

let _seq = 0
export function menuId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `m-${Date.now()}-${_seq++}`
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []
}

function idOf(raw: Record<string, unknown>): string {
  return typeof raw.__id === 'string' && raw.__id.length > 0 ? raw.__id : menuId()
}

export function normalizeFromValue(value: unknown, cfg: MenuConfig): MenuNode[] {
  return asArray(value).map((raw) => {
    const children = asArray(raw[cfg.childrenKey]).map<MenuLeaf>((c) => ({
      id: idOf(c),
      label: String(c[cfg.childLabelKey] ?? ''),
      href: String(c[cfg.childHrefKey] ?? ''),
    }))
    const node: MenuNode = {
      id: idOf(raw),
      label: String(raw['label'] ?? ''),
      children,
    }
    if (cfg.parentHrefKey) node.href = String(raw[cfg.parentHrefKey] ?? '')
    return node
  })
}

export function denormalizeToValue(
  nodes: MenuNode[],
  cfg: MenuConfig,
): Array<Record<string, unknown>> {
  return nodes.map((n) => {
    const out: Record<string, unknown> = { __id: n.id, label: n.label }
    if (cfg.parentHrefKey) out[cfg.parentHrefKey] = n.href ?? ''
    out[cfg.childrenKey] = n.children.map((c) => ({
      __id: c.id,
      [cfg.childLabelKey]: c.label,
      [cfg.childHrefKey]: c.href,
    }))
    return out
  })
}

// Indent a top-level node → becomes the last child of the immediately
// preceding top-level node. No-op when: it's the first node (no preceding
// sibling), it already has children (would create depth 2), or the target
// parent is at maxChildren.
export function indentParent(nodes: MenuNode[], id: string, cfg: MenuConfig): MenuNode[] {
  const i = nodes.findIndex((n) => n.id === id)
  if (i <= 0) return nodes
  const node = nodes[i]!
  if (node.children.length > 0) return nodes
  const prev = nodes[i - 1]!
  if (prev.children.length >= cfg.maxChildren) return nodes
  const leaf: MenuLeaf = { id: node.id, label: node.label, href: node.href ?? '' }
  const next = nodes.filter((_, j) => j !== i)
  const pi = next.findIndex((n) => n.id === prev.id)
  next[pi] = { ...prev, children: [...prev.children, leaf] }
  return next
}

// Outdent a child → becomes a top-level node inserted right after its
// parent. No-op when already at maxItems. The footer case (no parentHrefKey)
// drops the child's href because a footer column is a heading, not a link.
export function outdentChild(
  nodes: MenuNode[],
  parentId: string,
  childId: string,
  cfg: MenuConfig,
): MenuNode[] {
  if (nodes.length >= cfg.maxItems) return nodes
  const pi = nodes.findIndex((n) => n.id === parentId)
  if (pi < 0) return nodes
  const parent = nodes[pi]!
  const child = parent.children.find((c) => c.id === childId)
  if (!child) return nodes
  const newParent: MenuNode = { id: child.id, label: child.label, children: [] }
  if (cfg.parentHrefKey) newParent.href = child.href
  const next = nodes.map((n) =>
    n.id === parentId ? { ...n, children: n.children.filter((c) => c.id !== childId) } : n,
  )
  next.splice(pi + 1, 0, newParent)
  return next
}
