'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  searchBlocks,
  type SearchHit,
  type SearchableItem,
} from '@/lib/cms/blockSearch'

// Chunk I — shared state machine for the slash + ⌘K palette surfaces.
//
// Before consolidation, SlashCommandPalette and SlashCommandInline
// each held their own copy of:
//   - query / debouncedQuery state + 80ms debounce
//   - activeIndex state + clamp-on-debouncedQuery-change reset
//   - hits = useMemo(searchBlocks(debouncedQuery))
//   - firingRef double-fire guard
//   - onKeyDown handler for ArrowUp/Down/Tab/Enter
//   - activeId for aria-activedescendant
//
// That's ~60 LOC duplicated per surface. Drift risk was already there
// (Tab fallthrough behaviour diverged; preventDefault gating differed
// on no-hits). The hook owns ALL the state + keyboard logic; the two
// surface components handle ONLY layout chrome and onSelect dispatch.
//
// Design notes:
//   - Stateless return shape (no class, no context) so testability
//     stays high and each consumer's render cycle is isolated.
//   - onSelect is the ONLY caller-owned policy — palette inserts at
//     page tail, inline inserts after source. The hook calls
//     onSelect(item) when Enter or click resolves; the consumer
//     wires the actual insertBlock call.
//   - firingRef stays caller-managed (returned from the hook) so
//     async insertBlock work can hold the guard across the await.
//     The hook flips it to true on Enter activation; the caller's
//     finally flips it back.

const DEBOUNCE_MS = 80

export interface UseSlashSearchOptions {
  /** Caller-owned double-fire guard. Passed in (not returned) so the
   *  consumer can declare it at the top of its component and share it
   *  with both the hook (which flips it true on Enter to gate re-
   *  entry) and its own onSelect (which flips it back to false in
   *  the async dispatch's finally). Hoisting the ref out of the hook
   *  removes the forward-reference dance the call site would
   *  otherwise need. */
  firingRef: React.MutableRefObject<boolean>
  /** When Enter (or click) lands on a hit, the consumer's onSelect
   *  is called with the chosen item. The consumer is responsible for
   *  the actual insertBlock dispatch + close + toast + firingRef
   *  reset. */
  onSelect: (item: SearchableItem) => void
}

export interface UseSlashSearchValue {
  /** Bound to the input. */
  query: string
  setQuery: (q: string) => void
  /** Debounced query, used for hits compute + the "Results for X" /
   *  empty-hint copy. */
  debouncedQuery: string
  /** Capped at 8 hits per searchBlocks() contract. */
  hits: SearchHit[]
  /** 0-based keyboard active index. Caller passes to BlockSearchResults.
   *  Clamped to 0 on every debouncedQuery change. */
  activeIndex: number
  setActiveIndex: (i: number | ((prev: number) => number)) => void
  /** Bound to the input's onKeyDown. Handles arrows + Tab + Enter.
   *  Esc is owned by SlashCommandProvider — this handler ignores it. */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  /** Per-row id matching BlockSearchResults' option ids. Bound to the
   *  input's aria-activedescendant for combobox semantics. */
  activeId: string | undefined
}

export function useSlashSearch(
  resultsIdStem: string,
  { firingRef, onSelect }: UseSlashSearchOptions,
): UseSlashSearchValue {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeIndex, setActiveIndexState] = useState(0)

  // Debounce query → debouncedQuery. 80ms balances:
  //   - typing comfort (result list doesn't jitter per keystroke)
  //   - perceived responsiveness (sub-100ms feels instant per
  //     Nielsen's response-time research)
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [query])

  const hits = useMemo(() => searchBlocks(debouncedQuery), [debouncedQuery])

  // Reset activeIndex on every debounced query change. Predictable
  // behaviour matches Notion + Linear (each new query starts at the
  // top of the result list).
  useEffect(() => {
    setActiveIndexState(0)
  }, [debouncedQuery])

  // Wrap setActiveIndex so callers (BlockSearchResults.onHover) can
  // pass a functional updater OR a number. Same API as React's
  // setState dispatcher.
  const setActiveIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      setActiveIndexState((prev) =>
        typeof next === 'function' ? next(prev) : next,
      )
    },
    [],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      // Arrow keys / Tab / Enter — but ONLY consume the event when we
      // actually have hits to navigate. preventDefault on ArrowDown
      // with 0 hits would suppress a hypothetical native behaviour we
      // never use (text inputs don't navigate on arrows), but
      // suppressing Tab with 0 hits would trap focus in the input.
      if (e.key === 'ArrowDown') {
        if (hits.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        setActiveIndexState((i) =>
          Math.min(i + 1, Math.max(hits.length - 1, 0)),
        )
        return
      }
      if (e.key === 'ArrowUp') {
        if (hits.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        setActiveIndexState((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' && hits.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        setActiveIndexState((i) => {
          const n = hits.length
          if (e.shiftKey) return (i - 1 + n) % n
          return (i + 1) % n
        })
        return
      }
      if (e.key === 'Enter') {
        if (hits.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        const hit = hits[activeIndex]
        if (!hit) return
        if (firingRef.current) return
        firingRef.current = true
        // Self-defending invariant: if onSelect throws SYNCHRONOUSLY
        // before its own try/finally is entered, we still want
        // firingRef released so the surface doesn't lock permanently.
        // Today's callers wrap their dispatch in an async run() with
        // its own try/finally, so the sync-throw window is empty —
        // this guard is forward-looking insurance against a future
        // caller refactor.
        try {
          onSelect(hit.item)
        } catch (err) {
          firingRef.current = false
          throw err
        }
        return
      }
    },
    [activeIndex, firingRef, hits, onSelect],
  )

  const activeId =
    hits[activeIndex] && hits.length > 0
      ? `${resultsIdStem}-opt-${activeIndex}`
      : undefined

  return {
    query,
    setQuery,
    debouncedQuery,
    hits,
    activeIndex,
    setActiveIndex,
    onKeyDown,
    activeId,
  }
}
