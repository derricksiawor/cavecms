'use client'
import { useEffect, useState } from 'react'
import { csrfFetch } from '@/lib/client/csrf'
import { slugify } from '@/lib/cms/slugify'
import type { CategoryItem, TagItem } from './TaxonomyClient'

// Create/edit modal for a category or tag. Custom modal (never native
// alert/confirm/prompt). Slug auto-derives from the name until the operator
// edits the slug field directly (then it stops following). For categories, a
// parent dropdown offers top-level categories (one-level hierarchy). Premium
// styling: rounded-2xl, copper accents, w-fit buttons, inline error.

type Kind = 'category' | 'tag'

interface Props {
  kind: Kind
  // null = create; an item = edit
  editing: CategoryItem | TagItem | null
  // Top-level categories available as a parent (categories tab only). Excludes
  // the row being edited + any row that already has children (one level deep).
  parentOptions?: CategoryItem[]
  onClose: () => void
  onSaved: () => void
}

function isCategory(
  item: CategoryItem | TagItem | null,
  kind: Kind,
): item is CategoryItem {
  return kind === 'category' && item !== null
}

export function TermFormModal({
  kind,
  editing,
  parentOptions = [],
  onClose,
  onSaved,
}: Props) {
  const cat = isCategory(editing, kind) ? editing : null
  const [name, setName] = useState(editing?.name ?? '')
  const [slug, setSlug] = useState(editing?.slug ?? '')
  const [description, setDescription] = useState(cat?.description ?? '')
  const [parentId, setParentId] = useState<number | null>(cat?.parentId ?? null)
  // Slug follows the name until the operator touches the slug field (or when
  // editing an existing term, which already has a deliberate slug).
  const [slugTouched, setSlugTouched] = useState(editing !== null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name))
  }, [name, slugTouched])

  const friendlyError = (code: string): string => {
    switch (code) {
      case 'slug_taken':
        return 'That web address is already used by another term. Try a different one.'
      case 'slug_invalid':
        return 'The web address can only use lowercase letters, numbers and single hyphens — and can’t be a reserved word like “category”, “tag” or “feed”.'
      case 'stale_version':
        return 'Someone else just changed this term — close and reopen it so you don’t overwrite their edit.'
      case 'parent_not_found':
        return 'The parent category no longer exists. Pick another.'
      case 'parent_too_deep':
        return 'Categories can only be nested one level deep.'
      case 'parent_self':
        return 'A category can’t be its own parent.'
      case 'has_children':
        return 'This category already has sub-categories, so it can’t become a sub-category itself.'
      default:
        return 'We couldn’t save that. Try again in a moment.'
    }
  }

  async function save() {
    setSaving(true)
    setError(null)
    const base =
      kind === 'category'
        ? '/api/cms/taxonomy/categories'
        : '/api/cms/taxonomy/tags'
    const url = editing ? `${base}/${editing.id}` : base
    const method = editing ? 'PATCH' : 'POST'

    const body: Record<string, unknown> = { name, slug }
    if (kind === 'category') {
      body.description = description.trim() === '' ? null : description.trim()
      body.parentId = parentId
    }
    if (editing && kind === 'category') {
      body.version = (editing as CategoryItem).version
    }

    const res = await csrfFetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (res.ok) {
      onSaved()
      return
    }
    let code = 'unknown'
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) code = j.error
    } catch {
      /* keep default */
    }
    setError(friendlyError(code))
  }

  const noun = kind === 'category' ? 'category' : 'tag'
  const heading = editing
    ? `Edit ${noun}`
    : kind === 'category'
      ? 'New category'
      : 'New tag'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-near-black/45 p-4 backdrop-blur-[3px] animate-cavecms-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="term-form-title"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-warm-stone/20 bg-cream-50 p-8 shadow-[0_40px_80px_-30px_rgba(5,5,5,0.5)]">
        <h2
          id="term-form-title"
          className="font-serif text-2xl font-bold tracking-tight text-near-black"
        >
          {heading}
        </h2>

        <label className="mt-6 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          maxLength={120}
          placeholder={kind === 'category' ? 'e.g. Design notes' : 'e.g. interiors'}
          className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-white px-4 py-3 text-sm text-near-black focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
        />

        <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
          Web address
        </label>
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-warm-stone/25 bg-white px-4 py-2.5">
          <span className="shrink-0 font-mono text-xs text-warm-stone">
            /blog/{kind}/
          </span>
          <input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value)
            }}
            maxLength={120}
            placeholder={kind === 'category' ? 'design-notes' : 'interiors'}
            className="w-full bg-transparent font-mono text-sm text-near-black focus:outline-none"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-warm-stone">
          This is the link to the {noun}’s archive page. Lowercase letters,
          numbers and hyphens only.
        </p>

        {kind === 'category' && (
          <>
            <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={320}
              rows={2}
              placeholder="A short line shown at the top of the category’s archive page."
              className="mt-2 w-full resize-none rounded-xl border border-warm-stone/25 bg-white px-4 py-3 text-sm text-near-black focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
            />

            <label className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.2em] text-warm-stone">
              Parent category (optional)
            </label>
            <select
              value={parentId === null ? '' : String(parentId)}
              onChange={(e) =>
                setParentId(e.target.value === '' ? null : Number(e.target.value))
              }
              className="mt-2 w-full rounded-xl border border-warm-stone/25 bg-white px-4 py-3 text-sm text-near-black focus:border-copper-400 focus:outline-none focus:ring-2 focus:ring-copper-300/40"
            >
              <option value="">— None (top level) —</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[11px] text-warm-stone">
              Nest this under another category. Categories go one level deep.
            </p>
          </>
        )}

        {error && (
          <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
        )}

        <div className="mt-8 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex w-fit items-center justify-center rounded-full border border-warm-stone/30 px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-near-black transition-colors hover:border-copper-400 hover:text-copper-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || name.trim() === '' || slug.trim() === ''}
            className="inline-flex w-fit items-center justify-center rounded-full bg-near-black px-7 py-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-cream-50 transition-all hover:bg-copper-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : `Create ${noun}`}
          </button>
        </div>
      </div>
    </div>
  )
}
