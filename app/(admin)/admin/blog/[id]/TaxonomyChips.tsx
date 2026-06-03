'use client'
import { useMemo, useRef, useState } from 'react'
import { Plus, Check } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { slugify } from '@/lib/cms/slugify'
import { useToast } from '@/components/inline-edit/Toast'

// A taxonomy term (category or tag) the chip picker can render + select.
export interface TermOption {
  id: number
  slug: string
  name: string
  // Categories carry a parent for the one-level indent affordance; tags don't.
  parentId?: number | null
}

// Visual chip picker for assigning a post's categories OR tags (#0.59 — visual
// chips, NEVER a <select> of names). Existing terms render as clickable chips
// (selected = copper-filled with a check); a type-ahead input filters the
// catalog and, when the typed name matches no existing term, offers an inline
// "Create" affordance that mints the term on the fly (POST to the taxonomy API)
// and selects it. Multi-select. Controlled: the parent owns the selected-id
// Set + the option catalog (so a freshly-created term is appended).
export function TaxonomyChips({
  kind,
  label,
  help,
  options,
  selectedIds,
  onChange,
  onTermCreated,
  disabled = false,
}: {
  kind: 'category' | 'tag'
  label: string
  help?: string
  options: TermOption[]
  selectedIds: Set<number>
  onChange: (next: Set<number>) => void
  /** Called after a successful inline-create so the parent appends the new
   *  term to the catalog + selects it. */
  onTermCreated: (term: TermOption) => void
  disabled?: boolean
}) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.trim().toLowerCase()

  // Sort selected-first then alphabetical so the active selection stays visible
  // at the top; filter by the type-ahead query.
  const visible = useMemo(() => {
    const filtered = q
      ? options.filter((o) => o.name.toLowerCase().includes(q))
      : options
    return [...filtered].sort((a, b) => {
      const aSel = selectedIds.has(a.id) ? 0 : 1
      const bSel = selectedIds.has(b.id) ? 0 : 1
      if (aSel !== bSel) return aSel - bSel
      return a.name.localeCompare(b.name)
    })
  }, [options, q, selectedIds])

  // An exact (case-insensitive) name match means "already exists" → no create.
  const exactMatch = useMemo(
    () =>
      query.trim() !== '' &&
      options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase()),
    [options, query],
  )
  const canCreate = query.trim() !== '' && !exactMatch && !disabled

  const toggle = (id: number) => {
    if (disabled) return
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  const createTerm = async () => {
    const name = query.trim()
    if (name === '' || creating) return
    setCreating(true)
    try {
      const base =
        kind === 'category'
          ? '/api/cms/taxonomy/categories'
          : '/api/cms/taxonomy/tags'
      const res = await csrfFetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, slug: slugify(name) }),
      })
      if (res.status === 409) {
        toast.error('A term with that web address already exists.')
        return
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(
          j.error === 'slug_invalid'
            ? 'That name can’t be turned into a valid web address — try different wording.'
            : 'We couldn’t create that. Try again in a moment.',
        )
        return
      }
      const j = (await res.json()) as { id: number; slug: string }
      const term: TermOption = {
        id: j.id,
        slug: j.slug,
        name,
        ...(kind === 'category' ? { parentId: null } : {}),
      }
      onTermCreated(term)
      setQuery('')
      inputRef.current?.focus()
      toast.success(kind === 'category' ? 'Category added.' : 'Tag added.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
        {label}
      </span>
      {help && <p className="mt-1 text-[11px] text-warm-stone">{help}</p>}

      {/* Type-ahead + inline create */}
      <div className="mt-2 flex items-center gap-2 rounded-xl border border-warm-stone/25 bg-cream-50/80 px-3 py-2 focus-within:border-copper-400 focus-within:ring-2 focus-within:ring-copper-300/40">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (canCreate) void createTerm()
            }
          }}
          disabled={disabled}
          maxLength={120}
          placeholder={
            kind === 'category'
              ? 'Search or add a category…'
              : 'Search or add a tag…'
          }
          className="w-full bg-transparent text-sm text-near-black placeholder:text-warm-stone/60 focus:outline-none disabled:opacity-50"
        />
        {canCreate && (
          <button
            type="button"
            onClick={() => void createTerm()}
            disabled={creating}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-near-black px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cream-50 transition-colors hover:bg-copper-700 disabled:opacity-50"
          >
            <Plus size={12} strokeWidth={2.6} />
            {creating ? 'Adding…' : `Add “${query.trim()}”`}
          </button>
        )}
      </div>

      {/* Chip grid — the actual visual picker. Selected chips are copper-filled
          with a check; unselected are outlined. Scrollable when the catalog is
          large so a 100-term list never dominates the editor. */}
      {visible.length > 0 ? (
        <div className="mt-3 flex max-h-48 flex-wrap gap-2 overflow-y-auto pr-1">
          {visible.map((o) => {
            const selected = selectedIds.has(o.id)
            const isChild = kind === 'category' && o.parentId != null
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                disabled={disabled}
                aria-pressed={selected}
                className={[
                  'inline-flex w-fit items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all duration-quick disabled:opacity-50',
                  selected
                    ? 'border-copper-500 bg-copper-500 text-cream-50 shadow-[0_4px_14px_-6px_rgba(184,115,51,0.6)]'
                    : 'border-warm-stone/30 bg-cream-50/60 text-near-black hover:border-copper-400 hover:text-copper-700',
                  isChild ? 'ml-3' : '',
                ].join(' ')}
              >
                {selected && <Check size={13} strokeWidth={2.6} aria-hidden />}
                {isChild && (
                  <span aria-hidden className="opacity-60">
                    ↳
                  </span>
                )}
                {o.name}
              </button>
            )
          })}
        </div>
      ) : (
        <p className="mt-3 text-xs text-warm-stone">
          {q
            ? canCreate
              ? `No match — press Enter or “Add” to create “${query.trim()}”.`
              : 'No matches.'
            : kind === 'category'
              ? 'No categories yet — type a name above to create your first one.'
              : 'No tags yet — type a name above to create your first one.'}
        </p>
      )}
    </div>
  )
}
