'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, Plus, Search, X, GripVertical } from 'lucide-react'

// Visual post multi-select (#0.59 + #2 manual source) for the Posts widget.
// The operator searches posts by title and toggles them in/out; the persisted
// value is an ORDERED id array (the order = display order). Bounded: a hard
// `maxItems` cap with a graceful "N / max" counter + disabled add control once
// full (#0.251). Picked posts render as removable chips above the searchable
// results list. Both the search and the id-resolution hit
// /api/cms/posts/search (role-gated, bounded, missing-table-safe).

interface PostLite {
  id: number
  title: string
  slug: string
  published_at: string | null
}

interface PostPickerFieldProps {
  label: string
  help?: string
  maxItems: number
  value: number[]
  onChange: (v: number[]) => void
}

function fmt(value: string | null): string {
  if (!value) return 'Draft'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function PostPickerField({ label, help, maxItems, value, onChange }: PostPickerFieldProps) {
  const ids = useMemo(() => value ?? [], [value])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PostLite[]>([])
  const [picked, setPicked] = useState<PostLite[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Resolve the picked ids → titles (once on mount + whenever the id set
  // changes from outside). Keeps the chips labelled even after a reload.
  useEffect(() => {
    if (ids.length === 0) {
      setPicked([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/cms/posts/search?ids=${ids.join(',')}`, {
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return
        const data = (await res.json()) as { items: PostLite[] }
        if (!cancelled) {
          // Preserve the operator's id order.
          const byId = new Map((data.items ?? []).map((p) => [p.id, p]))
          setPicked(ids.map((id) => byId.get(id)).filter((p): p is PostLite => !!p))
        }
      } catch {
        /* leave chips as-is on a transient failure */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')])

  // Live search (debounced).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      let cancelled = false
      setLoading(true)
      void (async () => {
        try {
          const res = await fetch(`/api/cms/posts/search?q=${encodeURIComponent(query)}`, {
            headers: { accept: 'application/json' },
          })
          if (!res.ok) return
          const data = (await res.json()) as { items: PostLite[] }
          if (!cancelled) setResults(data.items ?? [])
        } catch {
          if (!cancelled) setResults([])
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
      return () => {
        cancelled = true
      }
    }, 220)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const atCap = ids.length >= maxItems

  const add = useCallback(
    (p: PostLite) => {
      if (ids.includes(p.id) || ids.length >= maxItems) return
      onChange([...ids, p.id])
      setPicked((prev) => [...prev, p])
    },
    [ids, maxItems, onChange],
  )

  const remove = useCallback(
    (id: number) => {
      onChange(ids.filter((x) => x !== id))
      setPicked((prev) => prev.filter((p) => p.id !== id))
    },
    [ids, onChange],
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
          {label}
        </span>
        <span
          className={clsx(
            'text-[10px] font-semibold uppercase tracking-[0.14em]',
            atCap ? 'text-copper-400' : 'text-cream-50/45',
          )}
        >
          {ids.length} / {maxItems}
        </span>
      </div>

      {/* Picked chips — in display order, each removable. */}
      {picked.length > 0 && (
        <ul className="space-y-1.5">
          {picked.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 rounded-lg border border-copper-400/40 bg-copper-400/[0.08] px-2.5 py-2"
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-cream-50/30" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-cream-50">{p.title}</div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-cream-50/40">{fmt(p.published_at)}</div>
              </div>
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-cream-50/55 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
                aria-label={`Remove ${p.title}`}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Search input */}
      <div className="flex items-center gap-2 rounded-xl border border-cream-50/15 bg-cream-50/[0.04] px-3 py-2 transition-all focus-within:border-copper-400/60">
        <Search className="h-4 w-4 shrink-0 text-cream-50/40" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={atCap ? 'Limit reached — remove one to add more' : 'Search posts to add…'}
          disabled={atCap}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-cream-50 placeholder:text-cream-50/40 focus:outline-none disabled:opacity-50"
          aria-label="Search posts"
        />
      </div>

      {/* Results — scrollable, capped at 30 by the route (#0.251). */}
      {!atCap && (
        <div className="max-h-56 overflow-y-auto rounded-xl border border-cream-50/10 bg-cream-50/[0.02]">
          {loading ? (
            <p className="px-3 py-4 text-center text-[12px] text-cream-50/40">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] text-cream-50/40">
              {query ? 'No posts match.' : 'No posts yet.'}
            </p>
          ) : (
            <ul>
              {results.map((p) => {
                const isPicked = ids.includes(p.id)
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => (isPicked ? remove(p.id) : add(p))}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-cream-50/[0.06] focus-visible:outline-none focus-visible:bg-cream-50/[0.06]"
                    >
                      <span
                        className={clsx(
                          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                          isPicked ? 'bg-copper-400/20 text-champagne' : 'bg-cream-50/[0.06] text-cream-50/40',
                        )}
                        aria-hidden
                      >
                        {isPicked ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-cream-50">{p.title}</span>
                        <span className="block text-[10px] uppercase tracking-[0.14em] text-cream-50/40">
                          {fmt(p.published_at)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {help && <span className="mt-1 block text-[11px] text-warm-stone/80">{help}</span>}
    </div>
  )
}
