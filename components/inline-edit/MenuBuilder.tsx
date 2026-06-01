'use client'
import { useMemo } from 'react'
import { Input } from '@/components/ui/Input'
import { EmptyState } from './EmptyState'
import { SortableList, DragHandle } from './SortableList'
import { ListChecks } from 'lucide-react'
import {
  normalizeFromValue,
  denormalizeToValue,
  indentParent,
  outdentChild,
  menuId,
  type MenuConfig,
  type MenuNode,
  type MenuLeaf,
} from '@/lib/cms/menuTree'
import type { FieldShape } from './ZodForm'

type Shape = FieldShape & { kind: 'menu_builder' }

function cfgOf(shape: Shape): MenuConfig {
  const cfg: MenuConfig = {
    childrenKey: shape.childrenKey,
    childLabelKey: shape.childLabelKey,
    childHrefKey: shape.childHrefKey,
    maxItems: shape.maxItems,
    maxChildren: shape.maxChildren,
  }
  if (shape.parentHrefKey) cfg.parentHrefKey = shape.parentHrefKey
  return cfg
}

// Shared drag-and-drop menu builder for one-level menus:
//   • header nav  — parents (links, with optional dropdown of sub-links)
//   • footer cols — parents (headings) each with a list of links
// Parents reorder via drag (outer SortableList); a parent's children reorder
// via drag (inner SortableList). Nesting/promoting is deterministic via the
// indent ⟨ / outdent ⟩ buttons (pure helpers in lib/cms/menuTree.ts), which
// also gives keyboard + touch operators a reliable path the drag gesture
// alone can't.
export function MenuBuilder({
  shape,
  value,
  onChange,
}: {
  shape: Shape
  value?: Array<Record<string, unknown>>
  onChange: (v: unknown) => void
}) {
  const cfg = useMemo(() => cfgOf(shape), [shape])
  const nodes = useMemo(() => normalizeFromValue(value, cfg), [value, cfg])
  const emit = (next: MenuNode[]) => onChange(denormalizeToValue(next, cfg))
  const hasParentHref = Boolean(shape.parentHrefKey)

  const setParent = (id: string, key: 'label' | 'href', v: string) =>
    emit(nodes.map((n) => (n.id === id ? { ...n, [key]: v } : n)))

  const setChild = (pid: string, cid: string, key: 'label' | 'href', v: string) =>
    emit(
      nodes.map((n) =>
        n.id === pid
          ? { ...n, children: n.children.map((c) => (c.id === cid ? { ...c, [key]: v } : c)) }
          : n,
      ),
    )

  const addParent = () => {
    if (nodes.length >= cfg.maxItems) return
    const blank: MenuNode = { id: menuId(), label: '', children: [] }
    if (hasParentHref) blank.href = ''
    emit([...nodes, blank])
  }

  const addChild = (pid: string) =>
    emit(
      nodes.map((n) =>
        n.id === pid && n.children.length < cfg.maxChildren
          ? { ...n, children: [...n.children, { id: menuId(), label: '', href: '' }] }
          : n,
      ),
    )

  return (
    <fieldset className="space-y-3 rounded-2xl border border-warm-stone/20 bg-cream-50/60 p-4">
      <legend className="cavecms-sticky-legend sticky top-0 z-10 -mt-1 -ml-2 rounded-md bg-cream-50/85 px-2 py-1 backdrop-blur-md">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          {shape.label}
        </span>
      </legend>
      {shape.help && (
        <span className="mt-1 block text-[11px] text-warm-stone/80">{shape.help}</span>
      )}

      {nodes.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={`Add your first ${shape.parentNoun}`}
          description={`Add a ${shape.parentNoun}, then add ${shape.childNoun}s under it. Use the nest button (or drag) to organise them.`}
          size="sm"
        />
      ) : (
        <SortableList<MenuNode>
          items={nodes}
          onChange={(next) => emit(next)}
          getId={(n) => n.id}
          renderItem={(node, i, helpers) => (
            <ParentRow
              node={node}
              shape={shape}
              handleProps={helpers.handleProps}
              canIndent={i > 0 && node.children.length === 0}
              onLabel={(v) => setParent(node.id, 'label', v)}
              onHref={(v) => setParent(node.id, 'href', v)}
              onIndent={() => emit(indentParent(nodes, node.id, cfg))}
              onAddChild={() => addChild(node.id)}
              onRemove={helpers.remove}
              childrenList={node.children}
              onChildrenReorder={(next) =>
                emit(nodes.map((n) => (n.id === node.id ? { ...n, children: next } : n)))
              }
              onChildLabel={(cid, v) => setChild(node.id, cid, 'label', v)}
              onChildHref={(cid, v) => setChild(node.id, cid, 'href', v)}
              onChildOutdent={(cid) => emit(outdentChild(nodes, node.id, cid, cfg))}
              atChildCap={node.children.length >= cfg.maxChildren}
            />
          )}
        />
      )}

      {nodes.length < cfg.maxItems && (
        <button
          type="button"
          onClick={addParent}
          className="inline-flex items-center gap-2 rounded-full border border-warm-stone/30 bg-cream-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-near-black transition-all hover:border-copper-400 hover:text-copper-700"
        >
          <PlusIcon />
          Add {shape.parentNoun}
        </button>
      )}
    </fieldset>
  )
}

function ParentRow({
  node,
  shape,
  handleProps,
  canIndent,
  atChildCap,
  onLabel,
  onHref,
  onIndent,
  onAddChild,
  onRemove,
  childrenList,
  onChildrenReorder,
  onChildLabel,
  onChildHref,
  onChildOutdent,
}: {
  node: MenuNode
  shape: Shape
  handleProps: Record<string, unknown>
  canIndent: boolean
  atChildCap: boolean
  onLabel: (v: string) => void
  onHref: (v: string) => void
  onIndent: () => void
  onAddChild: () => void
  onRemove: () => void
  childrenList: MenuLeaf[]
  onChildrenReorder: (next: MenuLeaf[]) => void
  onChildLabel: (cid: string, v: string) => void
  onChildHref: (cid: string, v: string) => void
  onChildOutdent: (cid: string) => void
}) {
  const dropdownOnly = Boolean(shape.parentHrefKey) && (node.href ?? '') === ''
  return (
    <div className="cavecms-repeater-item rounded-xl border border-warm-stone/20 bg-white p-2 shadow-[0_4px_14px_-10px_rgba(5,5,5,0.18)]">
      <div className="flex items-center gap-2">
        <DragHandle handleProps={handleProps} />
        <Input
          aria-label={`${shape.parentNoun} label`}
          placeholder={shape.parentHrefKey ? 'e.g. About' : 'e.g. Company'}
          value={node.label}
          onChange={(e) => onLabel(e.target.value)}
          className="min-w-0 flex-1"
        />
        {shape.parentHrefKey && (
          <Input
            aria-label={`${shape.parentNoun} link`}
            placeholder="/about (blank = dropdown only)"
            value={node.href ?? ''}
            onChange={(e) => onHref(e.target.value)}
            className="min-w-0 flex-1"
          />
        )}
        <RowBtn label={`Nest as ${shape.childNoun}`} disabled={!canIndent} onClick={onIndent}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </RowBtn>
        <RowBtn label="Remove" onClick={onRemove} danger>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </RowBtn>
      </div>

      {/* children list + add affordance — always present so the
          "Add {childNoun}" button is reachable even with no children yet */}
      <div className="ml-3 mt-2 space-y-2 border-l border-warm-stone/15 pl-3">
          {childrenList.length > 0 && (
            <SortableList<MenuLeaf>
              items={childrenList}
              onChange={onChildrenReorder}
              getId={(c) => c.id}
              renderItem={(leaf, _i, helpers) => (
                <div className="flex items-center gap-2 rounded-xl border border-warm-stone/15 bg-cream-50 p-2">
                  <DragHandle handleProps={helpers.handleProps} />
                  <Input
                    aria-label={`${shape.childNoun} label`}
                    placeholder="e.g. Our Team"
                    value={leaf.label}
                    onChange={(e) => onChildLabel(leaf.id, e.target.value)}
                    className="min-w-0 flex-1"
                  />
                  <Input
                    aria-label={`${shape.childNoun} link`}
                    placeholder="/team or https://…"
                    value={leaf.href}
                    onChange={(e) => onChildHref(leaf.id, e.target.value)}
                    className="min-w-0 flex-1"
                  />
                  <RowBtn label={`Promote to ${shape.parentNoun}`} onClick={() => onChildOutdent(leaf.id)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </RowBtn>
                  <RowBtn label="Remove" onClick={helpers.remove} danger>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </RowBtn>
                </div>
              )}
            />
          )}
          <div className="flex items-center gap-3">
            {dropdownOnly && (
              <span className="text-[10px] uppercase tracking-[0.18em] text-warm-stone/70">
                dropdown only
              </span>
            )}
            <button
              type="button"
              onClick={onAddChild}
              disabled={atChildCap}
              className="text-[11px] font-semibold uppercase tracking-[0.18em] text-copper-700 transition-colors hover:text-copper-500 disabled:opacity-40"
            >
              + Add {shape.childNoun}
            </button>
          </div>
      </div>
    </div>
  )
}

function RowBtn({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-30 ${
        danger
          ? 'text-warm-stone hover:bg-red-50 hover:text-red-600'
          : 'text-warm-stone hover:bg-cream-100 hover:text-near-black'
      }`}
    >
      {children}
    </button>
  )
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}
