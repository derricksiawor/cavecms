'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { Plus, Pencil, Trash2, FolderTree, Tag as TagIcon } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from '@/components/inline-edit/Toast'
import { ConfirmModal } from '@/components/admin/ConfirmModal'
import { PillButton } from '@/components/admin/PillButton'
import { EmptyState } from '@/components/inline-edit/EmptyState'
import {
  PILL_BASE,
  VARIANT_CLASS,
  SIZE_CLASS,
  ICON_SIZE,
} from '@/components/admin/pillStyle'
import {
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin/AdminTable'
import { TermFormModal } from './TermFormModal'

export interface CategoryItem {
  id: number
  slug: string
  name: string
  description: string | null
  parentId: number | null
  position: number
  version: number
  postCount: number
}
export interface TagItem {
  id: number
  slug: string
  name: string
  postCount: number
}

type Tab = 'categories' | 'tags'

export function TaxonomyClient({
  initialCategories,
  initialTags,
  canDelete,
}: {
  initialCategories: CategoryItem[]
  initialTags: TagItem[]
  canDelete: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('categories')

  // Modal state — one form modal (create OR edit) for the active tab.
  const [formOpen, setFormOpen] = useState(false)
  const [editingCat, setEditingCat] = useState<CategoryItem | null>(null)
  const [editingTag, setEditingTag] = useState<TagItem | null>(null)

  // Delete confirmation — holds the term pending deletion (+ its kind).
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: 'category'; item: CategoryItem }
    | { kind: 'tag'; item: TagItem }
    | null
  >(null)
  const [deleting, setDeleting] = useState(false)

  // Name lookup so a child category can show "↳ under Parent" in the table.
  const catById = useMemo(
    () => new Map(initialCategories.map((c) => [c.id, c])),
    [initialCategories],
  )
  // Parent options = top-level categories (parentId === null). Excludes the
  // row being edited (a category can't parent itself).
  const parentOptions = useMemo(
    () =>
      initialCategories.filter(
        (c) => c.parentId === null && c.id !== editingCat?.id,
      ),
    [initialCategories, editingCat],
  )

  const openCreate = () => {
    setEditingCat(null)
    setEditingTag(null)
    setFormOpen(true)
  }
  const openEditCategory = (c: CategoryItem) => {
    setEditingCat(c)
    setEditingTag(null)
    setFormOpen(true)
  }
  const openEditTag = (t: TagItem) => {
    setEditingTag(t)
    setEditingCat(null)
    setFormOpen(true)
  }

  const onSaved = () => {
    setFormOpen(false)
    setEditingCat(null)
    setEditingTag(null)
    toast.success('Saved.')
    router.refresh()
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const base =
        pendingDelete.kind === 'category'
          ? '/api/cms/taxonomy/categories'
          : '/api/cms/taxonomy/tags'
      const res = await csrfFetch(`${base}/${pendingDelete.item.id}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 204) {
        toast.error('We couldn’t delete that. Try again in a moment.')
        return
      }
      toast.success(
        pendingDelete.kind === 'category' ? 'Category deleted.' : 'Tag deleted.',
      )
      router.refresh()
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  // ── category columns ──────────────────────────────────────────────
  const categoryColumns: AdminTableColumn<CategoryItem>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        sortAccessor: (r) => r.name.toLowerCase(),
        cell: (r) => (
          <div className="flex items-center gap-2">
            {r.parentId !== null && (
              <span aria-hidden className="text-warm-stone/60">
                ↳
              </span>
            )}
            <button
              type="button"
              onClick={() => openEditCategory(r)}
              className="font-medium text-near-black underline-offset-2 hover:underline"
            >
              {r.name}
            </button>
            {r.parentId !== null && catById.get(r.parentId) && (
              <span className="text-[11px] text-warm-stone">
                under {catById.get(r.parentId)!.name}
              </span>
            )}
          </div>
        ),
      },
      {
        key: 'slug',
        label: 'Web address',
        sortable: true,
        sortAccessor: (r) => r.slug,
        cell: (r) => (
          <span className="font-mono text-xs text-warm-stone">
            /blog/category/{r.slug}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: 'postCount',
        label: 'Posts',
        sortable: true,
        sortAccessor: (r) => r.postCount,
        cell: (r) => (
          <span className="text-xs text-warm-stone">
            {r.postCount} {r.postCount === 1 ? 'post' : 'posts'}
          </span>
        ),
      },
    ],
    [catById],
  )

  // ── tag columns ───────────────────────────────────────────────────
  const tagColumns: AdminTableColumn<TagItem>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        sortAccessor: (r) => r.name.toLowerCase(),
        cell: (r) => (
          <button
            type="button"
            onClick={() => openEditTag(r)}
            className="font-medium text-near-black underline-offset-2 hover:underline"
          >
            {r.name}
          </button>
        ),
      },
      {
        key: 'slug',
        label: 'Web address',
        sortable: true,
        sortAccessor: (r) => r.slug,
        cell: (r) => (
          <span className="font-mono text-xs text-warm-stone">
            /blog/tag/{r.slug}
          </span>
        ),
        hideOnMobile: true,
      },
      {
        key: 'postCount',
        label: 'Posts',
        sortable: true,
        sortAccessor: (r) => r.postCount,
        cell: (r) => (
          <span className="text-xs text-warm-stone">
            {r.postCount} {r.postCount === 1 ? 'post' : 'posts'}
          </span>
        ),
      },
    ],
    [],
  )

  const rowActions = (
    onEdit: () => void,
    onDelete: () => void,
    label: string,
  ) => (
    <div className="flex items-center gap-2">
      <PillButton onClick={onEdit} ariaLabel={`Edit ${label}`} icon={Pencil} variant="subtle">
        Edit
      </PillButton>
      {canDelete && (
        <PillButton
          onClick={onDelete}
          ariaLabel={`Delete ${label}`}
          icon={Trash2}
          variant="subtle"
        >
          Delete
        </PillButton>
      )}
    </div>
  )

  const formKind: Tab = tab
  const createLabel = tab === 'categories' ? 'New category' : 'New tag'

  return (
    <div className="space-y-6">
      {/* Tabs + create CTA */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div
          role="tablist"
          aria-label="Taxonomy type"
          className="inline-flex items-center gap-1 rounded-full border border-warm-stone/20 bg-cream-50/60 p-1"
        >
          {(
            [
              { id: 'categories' as const, label: 'Categories', icon: FolderTree },
              { id: 'tags' as const, label: 'Tags', icon: TagIcon },
            ]
          ).map((t) => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'inline-flex items-center gap-2 rounded-full px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] transition-colors',
                  active
                    ? 'bg-near-black text-cream-50'
                    : 'text-warm-stone hover:text-near-black',
                )}
              >
                <Icon size={14} strokeWidth={2.2} />
                {t.label}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={openCreate}
          className={clsx(PILL_BASE, VARIANT_CLASS['filled'], SIZE_CLASS['md'])}
        >
          <Plus size={ICON_SIZE['md']} strokeWidth={2.4} />
          {createLabel}
        </button>
      </div>

      {tab === 'categories' ? (
        <AdminTable<CategoryItem>
          rows={initialCategories}
          getId={(r) => r.id}
          columns={categoryColumns}
          rowActions={(r) =>
            rowActions(
              () => openEditCategory(r),
              () => setPendingDelete({ kind: 'category', item: r }),
              r.name,
            )
          }
          mobileRowHeader={(r) => (
            <button
              type="button"
              onClick={() => openEditCategory(r)}
              className="text-base font-semibold text-near-black underline-offset-2 hover:underline"
            >
              {r.name}
            </button>
          )}
          emptyState={
            <EmptyState
              icon={FolderTree}
              title="Organise posts into categories"
              description="Categories are the main sections of your blog — like Design, News, or Behind the scenes. Readers can browse each one on its own archive page."
              example="e.g. “Design notes”"
              cta={{ label: 'New category', onClick: openCreate, icon: Plus }}
            />
          }
          defaultSort={{ column: 'name', direction: 'asc' }}
          urlKey="cat"
        />
      ) : (
        <AdminTable<TagItem>
          rows={initialTags}
          getId={(r) => r.id}
          columns={tagColumns}
          rowActions={(r) =>
            rowActions(
              () => openEditTag(r),
              () => setPendingDelete({ kind: 'tag', item: r }),
              r.name,
            )
          }
          mobileRowHeader={(r) => (
            <button
              type="button"
              onClick={() => openEditTag(r)}
              className="text-base font-semibold text-near-black underline-offset-2 hover:underline"
            >
              {r.name}
            </button>
          )}
          emptyState={
            <EmptyState
              icon={TagIcon}
              title="Label posts with tags"
              description="Tags are lighter than categories — quick labels you can add to any post to connect related stories. Each tag gets its own archive page."
              example="e.g. “interiors”"
              cta={{ label: 'New tag', onClick: openCreate, icon: Plus }}
            />
          }
          defaultSort={{ column: 'name', direction: 'asc' }}
          urlKey="tag"
        />
      )}

      {formOpen && (
        <TermFormModal
          kind={formKind === 'categories' ? 'category' : 'tag'}
          editing={formKind === 'categories' ? editingCat : editingTag}
          parentOptions={formKind === 'categories' ? parentOptions : undefined}
          onClose={() => {
            setFormOpen(false)
            setEditingCat(null)
            setEditingTag(null)
          }}
          onSaved={onSaved}
        />
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        title={
          pendingDelete?.kind === 'category'
            ? 'Delete this category?'
            : 'Delete this tag?'
        }
        description={
          pendingDelete
            ? pendingDelete.item.postCount > 0
              ? `“${pendingDelete.item.name}” will be removed from ${pendingDelete.item.postCount} ${pendingDelete.item.postCount === 1 ? 'post' : 'posts'}. The posts themselves are kept — they just lose this label. This can’t be undone.`
              : `“${pendingDelete.item.name}” will be deleted. This can’t be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setPendingDelete(null)
        }}
      />
    </div>
  )
}
