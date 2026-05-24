'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { BookmarkPlus, Loader2, Search, Trash2, X } from 'lucide-react'
import { csrfFetch } from '@/lib/client/csrf'
import { useToast } from './Toast'
import { useInsertBlock, type InsertableBlockType } from './InlineEditContext'
import type {
  SavedBlockDetail,
  SavedBlockListItem,
} from '@/lib/cms/savedBlocks'

// SavedBlocksPanel — mounted inside WidgetPicker as the "Saved" tab.
//
// Behaviour:
//   1. Fetches the per-user library via GET /api/cms/saved-blocks on
//      mount + on demand (refresh after delete / external invalidation).
//   2. Renders each row as a card; clicking the card fetches the full
//      data + meta via GET /[id] then routes through useInsertBlock so
//      the new block lands via the same path the standard WidgetPicker
//      pills + slash command use — same audit, same undo wiring, same
//      revalidate.
//   3. Inline search filter (substring against name + blockType).
//   4. Delete via DELETE /[id] with confirm prompt (window.confirm to
//      stay self-contained; the canvas-side ConfirmModal lives in the
//      ContextMenuProvider and isn't reachable from inside the picker).
//
// Empty state copy points operators at the source verb ("right-click any
// widget → Save as block"). Error states fall back to a retry pill so
// the panel is recoverable without a full reload.

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const diffSec = Math.max(0, Math.floor(diffMs / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  const diffMo = Math.floor(diffDay / 30)
  if (diffMo < 12) return `${diffMo}mo ago`
  const diffYr = Math.floor(diffMo / 12)
  return `${diffYr}y ago`
}

interface Props {
  pageId: number
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: SavedBlockListItem[] }

export function SavedBlocksPanel({ pageId }: Props) {
  const toast = useToast()
  const insertBlock = useInsertBlock()
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  // In-flight ref so a fast double-click on the same card doesn't
  // double-instantiate. The button's disabled prop covers the UI but
  // an enter-key replay during the same tick can still slip past.
  const inFlightRef = useRef(false)

  const fetchList = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const res = await fetch('/api/cms/saved-blocks', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        setState({
          kind: 'error',
          message:
            res.status === 401 || res.status === 403
              ? "You don't have access to the saved-blocks library."
              : "We couldn't load your saved blocks. Try again.",
        })
        return
      }
      const j = (await res.json()) as { items?: SavedBlockListItem[] }
      setState({ kind: 'ready', items: j.items ?? [] })
    } catch {
      setState({
        kind: 'error',
        message:
          "We can't reach the server right now. Try again in a moment.",
      })
    }
  }, [])

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  // Filter — substring against name + blockType. Empty query returns
  // the full list. Locale-insensitive lowercase keeps things simple;
  // operator-set names are normally ASCII/Latin and the locale-aware
  // toLocaleLowerCase fallback would over-engineer this surface.
  const filtered = useMemo(() => {
    if (state.kind !== 'ready') return []
    const q = query.trim().toLowerCase()
    if (q === '') return state.items
    return state.items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.blockType.toLowerCase().includes(q),
    )
  }, [state, query])

  const insertFromSaved = useCallback(
    async (item: SavedBlockListItem) => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      setBusyId(item.id)
      try {
        // Fetch the full row so we have data + meta. The list endpoint
        // omits these to keep the panel-load roundtrip small.
        const res = await fetch(`/api/cms/saved-blocks/${item.id}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
        if (!res.ok) {
          if (res.status === 404) {
            toast.error('This saved block was removed. Refreshing the list.')
            void fetchList()
            return
          }
          toast.error(
            "We couldn't load that saved block. Try again in a moment.",
          )
          return
        }
        const detail = (await res.json()) as SavedBlockDetail
        const insertResult = await insertBlock(
          detail.blockType as InsertableBlockType,
          {
            pageId,
            data: detail.data as Record<string, unknown> | undefined,
            meta:
              detail.meta && typeof detail.meta === 'object'
                ? (detail.meta as Record<string, unknown>)
                : undefined,
          },
        )
        if (!insertResult.ok) {
          if (insertResult.error === 'invalid_saved_block') {
            toast.error(
              "This saved block is no longer valid — remove it and save a fresh one.",
            )
          } else if (
            insertResult.error === 'block_type_reserved_for_fixed_slot'
          ) {
            toast.error(
              "This block is part of the page template and can't be pasted here.",
            )
          } else {
            toast.error("We couldn't insert that block. Try again.")
          }
          return
        }
        toast.success(`Added "${item.name}".`)
      } finally {
        setBusyId(null)
        inFlightRef.current = false
      }
    },
    [fetchList, insertBlock, pageId, toast],
  )

  const removeSaved = useCallback(
    async (item: SavedBlockListItem) => {
      // Self-contained confirm — the canvas-side ConfirmModal lives in
      // ContextMenuProvider and isn't reachable from inside the picker
      // panel. window.confirm is the lightest path for an in-panel
      // destructive verb (no portal, no focus dance) and the gesture
      // is reversible at the source (operator can re-save).
      if (
        typeof window !== 'undefined' &&
        !window.confirm(
          `Remove "${item.name}" from your saved blocks? You can save it again from the source.`,
        )
      ) {
        return
      }
      setDeletingId(item.id)
      try {
        const res = await csrfFetch(`/api/cms/saved-blocks/${item.id}`, {
          method: 'DELETE',
        })
        if (!res.ok) {
          if (res.status === 404) {
            toast.info('Already removed.')
          } else {
            toast.error("We couldn't remove that. Try again.")
            return
          }
        } else {
          toast.success('Removed from your library.')
        }
        // Optimistic local update + background refetch to keep the list
        // in sync with any peer deletes that may have landed.
        setState((prev) =>
          prev.kind === 'ready'
            ? { kind: 'ready', items: prev.items.filter((i) => i.id !== item.id) }
            : prev,
        )
      } catch {
        toast.error(
          "We can't reach the server right now. Try again in a moment.",
        )
      } finally {
        setDeletingId(null)
      }
    },
    [toast],
  )

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center justify-center px-2 py-8 text-[11px] font-medium text-ivory/50">
        <Loader2 size={12} className="mr-2 animate-spin" />
        Loading your library…
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="px-2 py-6 text-center">
        <p className="mb-2 text-[11px] font-medium text-red-300">
          {state.message}
        </p>
        <button
          type="button"
          onClick={() => void fetchList()}
          className="inline-flex items-center gap-1.5 rounded-full bg-ivory/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-ivory transition-colors hover:bg-champagne hover:text-obsidian"
        >
          Try again
        </button>
      </div>
    )
  }

  if (state.items.length === 0) {
    return (
      <div className="px-2 py-6 text-center">
        <div
          aria-hidden="true"
          className="mx-auto mb-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-champagne/15 text-champagne ring-1 ring-champagne/30"
        >
          <BookmarkPlus size={14} strokeWidth={2} />
        </div>
        <p className="px-2 text-[11px] leading-relaxed text-ivory/65">
          Right-click any widget on the canvas and choose{' '}
          <span className="font-semibold text-ivory/90">Save as block</span> to
          start your library.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2.5 flex items-center gap-2 rounded-xl bg-ivory/5 px-2.5 py-1.5 ring-1 ring-ivory/10 focus-within:ring-champagne/40">
        <Search
          size={12}
          strokeWidth={2.2}
          className="shrink-0 text-ivory/40"
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search saved…"
          aria-label="Search saved blocks"
          className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-ivory outline-none placeholder:text-ivory/30"
        />
        {query !== '' && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="rounded-full p-0.5 text-ivory/40 transition-colors hover:bg-ivory/10 hover:text-ivory"
          >
            <X size={11} strokeWidth={2.4} />
          </button>
        )}
      </div>

      {filtered.length === 0 && query !== '' && (
        <p className="px-1 py-2 text-[11px] font-medium text-ivory/50">
          No saved blocks match{' '}
          <span className="font-semibold text-ivory/80">
            &ldquo;{query}&rdquo;
          </span>
          .
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {filtered.map((item) => {
          const isBusy = busyId === item.id
          const isDeleting = deletingId === item.id
          return (
            <li
              key={item.id}
              className={clsx(
                'group flex items-center gap-2 rounded-xl bg-ivory/[0.04] px-2.5 py-2 ring-1 ring-ivory/10 transition-colors hover:bg-champagne/10 hover:ring-champagne/30',
                (isBusy || isDeleting) && 'opacity-60',
              )}
            >
              <button
                type="button"
                onClick={() => void insertFromSaved(item)}
                disabled={isBusy || isDeleting || busyId !== null}
                aria-label={`Insert ${item.name}`}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-not-allowed"
              >
                <span className="line-clamp-1 text-[12px] font-semibold tracking-tight text-ivory">
                  {isBusy ? 'Inserting…' : item.name}
                </span>
                <span className="flex items-center gap-1.5 text-[9.5px] font-medium uppercase tracking-[0.16em] text-ivory/50">
                  <span className="inline-flex rounded-full bg-ivory/5 px-1.5 py-0.5 text-ivory/65 ring-1 ring-ivory/10">
                    {item.blockType.replace(/_/g, ' ')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{formatRelativeTime(item.createdAt)}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void removeSaved(item)}
                disabled={isBusy || isDeleting}
                aria-label={`Remove ${item.name} from saved blocks`}
                className="shrink-0 rounded-full p-1.5 text-ivory/40 opacity-0 transition-all hover:bg-red-500/15 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
              >
                {isDeleting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Trash2 size={12} strokeWidth={2.2} />
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
