'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import clsx from 'clsx'
import { ChevronRight, LayoutGrid, Plus, Search, X } from 'lucide-react'
import {
  SEED_ENTRIES,
  isPaletteVisible,
  BLOCK_CATEGORIES,
  categoryForEntry,
  type SeedBlockType,
  type SeedEntry,
} from '@/lib/cms/blockSeeds'
import { mapInsertBlockError } from '@/lib/cms/insertBlockErrors'
import { useSectionTemplateGallery } from './SectionTemplateGalleryHost'
import { useInsertBlock } from './InlineEditContext'
import { safeStorage } from '@/lib/client/safeStorage'
import { SavedBlocksPanel } from './SavedBlocksPanel'

// WidgetPicker — extracted from the prior OutlinePanel "Add a block"
// footer into its own LEFT-pinned floating panel. Lives entirely
// separate from the OutlinePanel (right-pinned) so an operator can
// dismiss/move the outline without losing access to widget creation.
//
// Identical insert pipeline as the outline's old footer: useInsertBlock
// owns the body shape + router.refresh; this component owns the
// per-pill busy state + inline error banner + the section-template
// gallery trigger that opens the gallery host above the slash palette.
//
// Visual treatment matches the OutlinePanel + new EditableBlock
// toolbar — obsidian shell with champagne ring/accents, ivory text
// on dark — so the four edit-mode floating surfaces (admin bar,
// outline, widget picker, edit-mode pill) read as one chrome system.
//
// Open/collapsed preference persists to localStorage `cavecms:picker-open`.
// SSR returns the "open by default" markup; the post-mount effect
// applies the saved preference. <lg viewports default closed to keep
// the canvas usable on iPad.

// ─── Search ranking ─────────────────────────────────────────────────
// Operators reach the picker with ~40 widgets in scope after the
// luxury palette gate. A flat list forces scroll; type-to-filter is
// the Webflow / Elementor parity bar. Ranking tiers (best → worst):
//   0 — exact block type match  ('lx_action' typed === entry.type)
//   1 — label prefix            (entry.label starts with the query)
//   2 — alias prefix            (any alias starts with the query)
//   3 — label substring         (entry.label contains the query)
//   4 — alias substring         (any alias contains the query)
//   5 — keyword match           (any keyword contains the query)
// Lower number = higher rank; ties keep the SEED_ENTRIES declaration
// order (which is operator-curated — luxury widgets first, then the
// legacy gate filters legacies before this ranker even sees them).
//
// Empty query returns SEED_ENTRIES unchanged.

const RANK_NO_MATCH = 99
function rankEntry(entry: SeedEntry, q: string): number {
  if (q === '') return 0
  const type = entry.type.toLowerCase()
  const label = entry.label.toLowerCase()
  const aliases = (entry.aliases ?? []).map((a) => a.toLowerCase())
  const keywords = (entry.keywords ?? []).map((k) => k.toLowerCase())
  if (type === q) return 0
  if (label.startsWith(q)) return 1
  for (const a of aliases) if (a.startsWith(q)) return 2
  if (label.includes(q)) return 3
  for (const a of aliases) if (a.includes(q)) return 4
  for (const k of keywords) if (k.includes(q)) return 5
  return RANK_NO_MATCH
}

export function WidgetPicker({ pageId }: { pageId: number }) {
  const insertBlock = useInsertBlock()
  const templateGallery = useSectionTemplateGallery()
  const inFlightRef = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [focusIndex, setFocusIndex] = useState(0)
  // Tab discriminator. "widgets" = the seed-entry pill list (default).
  // "saved" = the per-user Saved-Blocks library panel. Persisted to
  // localStorage so an operator who reaches for the library tab on
  // their last edit returns to it on the next page. Mirrors the
  // open/closed persistence pattern below.
  const [tab, setTab] = useState<'widgets' | 'saved'>('widgets')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // `hasMounted` powers the mount-in slide-from-left entrance. SSR
  // renders the panel off-screen (translate-x-[-full] + opacity 0).
  // The post-mount effect flips it true; the CSS transition handles
  // the slide-in. Mirror pattern of OutlinePanel's right-side entrance.
  const [hasMounted, setHasMounted] = useState(false)

  // Hydrate saved open/closed state + flip hasMounted in one effect
  // pass. localStorage default → open on lg+, closed on <lg. Mirrors
  // the OutlinePanel pattern so the two panels feel like siblings.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = safeStorage.get('cavecms:picker-open')
    if (saved === 'true') setOpen(true)
    else if (saved === 'false') setOpen(false)
    else if (window.matchMedia('(max-width: 1023.98px)').matches) {
      setOpen(false)
    }
    const savedTab = safeStorage.get('cavecms:picker-tab')
    if (savedTab === 'saved') setTab('saved')
    setHasMounted(true)
  }, [])

  // Persist tab selection so an operator who reaches for the library
  // returns to the same tab on their next edit. Skip first effect
  // pass so the hydration above isn't overwritten by the initial
  // render's default.
  const skipFirstTabPersistRef = useRef(true)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (skipFirstTabPersistRef.current) {
      skipFirstTabPersistRef.current = false
      return
    }
    safeStorage.set('cavecms:picker-tab', tab)
  }, [tab])

  // Persist on toggle. Skip the first effect so the read-effect's
  // computed default doesn't get overwritten by the SSR-default value.
  const skipFirstPersistRef = useRef(true)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (skipFirstPersistRef.current) {
      skipFirstPersistRef.current = false
      return
    }
    safeStorage.set('cavecms:picker-open', String(open))
  }, [open])

  // Filtered + ranked entries. Recomputes only when the query or the
  // palette-visible set changes (SEED_ENTRIES is module-scope and
  // never mutates — defended by `readonly SeedEntry[]` in blockSeeds).
  const visibleEntries = useMemo(
    () => SEED_ENTRIES.filter(isPaletteVisible),
    [],
  )
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return visibleEntries
    const ranked = visibleEntries
      .map((entry, originalIndex) => ({
        entry,
        rank: rankEntry(entry, q),
        originalIndex,
      }))
      .filter((r) => r.rank !== RANK_NO_MATCH)
      .sort((a, b) =>
        a.rank !== b.rank ? a.rank - b.rank : a.originalIndex - b.originalIndex,
      )
    return ranked.map((r) => r.entry)
  }, [visibleEntries, query])

  // Reset keyboard focus to the first match when the result set
  // changes — otherwise an arrow-down on an out-of-range index would
  // land on a deleted entry.
  useEffect(() => {
    setFocusIndex(0)
  }, [query])

  const add = async (
    blockType: SeedBlockType,
    data?: Record<string, unknown>,
    busyKey?: string,
  ) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(busyKey ?? blockType)
    setErr(null)
    try {
      const res = await insertBlock(blockType, { pageId, data })
      if (!res.ok) {
        setErr(mapInsertBlockError(res.error).copy)
        return
      }
    } finally {
      setBusy(null)
      inFlightRef.current = false
    }
  }

  // Keyboard nav on the search input — arrow keys move the focused
  // pill, Enter inserts the focused pill. Escape clears the query.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filtered.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      setFocusIndex((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      setFocusIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[focusIndex]
      if (entry) void add(entry.type, entry.data, entry.label)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setQuery('')
    }
  }

  return (
    <aside
      aria-label="Widget picker"
      aria-hidden={!hasMounted}
      className={clsx(
        'fixed left-4 top-28 z-30 w-72 lg:w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl bg-obsidian/95 text-ivory shadow-[0_24px_60px_-30px_rgba(0,0,0,0.6)] ring-1 ring-champagne/30 backdrop-blur-sm',
        // Slide-in-from-left + fade entrance on mount; max-h transitions
        // in parallel for collapse/expand. duration-drawer (400ms) on
        // the luxury easing curve so the panel settles in deliberately
        // rather than snapping.
        'transition-all duration-drawer ease-luxury motion-reduce:transition-none',
        open ? 'max-h-[calc(100vh-9rem)]' : 'max-h-14',
        hasMounted
          ? 'translate-x-0 opacity-100'
          : '-translate-x-[calc(100%+1.5rem)] opacity-0 pointer-events-none',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="widget-picker-body"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-champagne/5"
      >
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-champagne/15 text-champagne ring-1 ring-champagne/30"
          >
            <LayoutGrid size={13} strokeWidth={2} />
          </span>
          <span className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-champagne">
              Widgets
            </span>
            <span className="text-[11px] font-medium text-ivory/60">
              Drag or click to add
            </span>
          </span>
        </span>
        <ChevronRight
          size={14}
          strokeWidth={2.2}
          className={clsx(
            'text-ivory/40 transition-transform motion-reduce:transition-none',
            open ? 'rotate-90' : 'rotate-0',
          )}
        />
      </button>

      {/* Body always rendered so the collapse/expand fades smoothly in
         lockstep with the outer max-h transition. inert + aria-hidden
         block focus + AT when collapsed; opacity + translate carry
         the visual motion. */}
      <div
        id="widget-picker-body"
        aria-hidden={!open}
        inert={!open}
        className={clsx(
          'max-h-[calc(100vh-13rem)] overflow-y-auto px-3 py-3 transition-all duration-standard ease-luxury motion-reduce:transition-none',
          open
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 -translate-y-1 pointer-events-none',
        )}
      >
        {/* Tab strip — Widgets (seed pills) vs Saved (per-user library).
           The Saved tab fetches the operator's saved-block library on
           mount via SavedBlocksPanel and renders cards with insert +
           delete affordances. Tab selection persists via localStorage
           in the effect above so the operator returns to the same tab
           on the next edit. */}
        <div
          role="tablist"
          aria-label="Picker source"
          className="mb-2.5 flex items-center gap-1 rounded-full bg-ivory/[0.04] p-0.5 ring-1 ring-ivory/10"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'widgets'}
            onClick={() => setTab('widgets')}
            className={clsx(
              'flex-1 rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors',
              tab === 'widgets'
                ? 'bg-champagne text-obsidian'
                : 'text-ivory/65 hover:text-ivory',
            )}
          >
            Widgets
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'saved'}
            onClick={() => setTab('saved')}
            className={clsx(
              'flex-1 rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors',
              tab === 'saved'
                ? 'bg-champagne text-obsidian'
                : 'text-ivory/65 hover:text-ivory',
            )}
          >
            Saved
          </button>
        </div>

        {tab === 'saved' ? (
          <SavedBlocksPanel pageId={pageId} />
        ) : (
          <WidgetTab
            err={err}
            query={query}
            setQuery={setQuery}
            searchInputRef={searchInputRef}
            onSearchKeyDown={onSearchKeyDown}
            templateGallery={templateGallery}
            busy={busy}
            filtered={filtered}
            focusIndex={focusIndex}
            add={add}
          />
        )}
      </div>
    </aside>
  )
}

// Extracted widget-tab body so the tab-switch above stays self-contained.
// Same markup as the prior inline body — the only change is the wrapper.
interface WidgetTabProps {
  err: string | null
  query: string
  setQuery: (q: string) => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  templateGallery: ReturnType<typeof useSectionTemplateGallery>
  busy: string | null
  filtered: SeedEntry[]
  focusIndex: number
  add: (
    blockType: SeedBlockType,
    data?: Record<string, unknown>,
    busyKey?: string,
  ) => Promise<void>
}

function WidgetTab({
  err,
  query,
  setQuery,
  searchInputRef,
  onSearchKeyDown,
  templateGallery,
  busy,
  filtered,
  focusIndex,
  add,
}: WidgetTabProps) {
  return (
    <>
        {/* Search input — sits above the pill list. Operators with a
           specific widget in mind type "btn" / "heading" / "stat" and
           the ranker surfaces the right match at index 0 so Enter
           inserts immediately. Arrow keys nav the focused pill; the
           focused pill gets a brighter champagne ring than a hover. */}
        <div className="mb-2.5 flex items-center gap-2 rounded-xl bg-ivory/5 px-2.5 py-1.5 ring-1 ring-ivory/10 focus-within:ring-champagne/40">
          <Search
            size={12}
            strokeWidth={2.2}
            className="shrink-0 text-ivory/40"
            aria-hidden="true"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search widgets…"
            aria-label="Search widgets"
            className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-ivory outline-none placeholder:text-ivory/30"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchInputRef.current?.focus()
              }}
              aria-label="Clear search"
              className="rounded-full p-0.5 text-ivory/40 transition-colors hover:bg-ivory/10 hover:text-ivory"
            >
              <X size={11} strokeWidth={2.4} />
            </button>
          )}
        </div>

        {err && (
          <p
            role="alert"
            className="mb-2 rounded-xl bg-red-500/15 px-3 py-2 text-[11px] font-medium text-red-300 ring-1 ring-red-400/40"
          >
            {err}
          </p>
        )}
        {/* Drag-or-click affordance — each pill below is wrapped in
           useDraggable so an operator can either tap the pill (insert
           at end of page, click path) or grab + drop it onto any drop
           target in the canvas (insert at that exact position, drag
           path). PointerSensor's 6px activation distance separates a
           click from a drag without conflict. The Templates pill above
           stays click-only — it opens a multi-block gallery, not a
           single-block insert, so dragging it has no meaningful
           destination semantics. */}
        {/* "Start from template" pill — opens the section-template
           gallery. Shown only when the search query is empty so a
           text filter doesn't dilute the result set with a
           non-widget action. */}
        {query === '' && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => templateGallery.open()}
              className="inline-flex items-center gap-1.5 rounded-full bg-champagne px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-obsidian transition-all hover:bg-antique-gold hover:text-ivory disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={10} strokeWidth={2.4} />
              Templates
            </button>
          </div>
        )}
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-[11px] font-medium text-ivory/50">
            No widgets match{' '}
            <span className="font-semibold text-ivory/80">
              &ldquo;{query}&rdquo;
            </span>
            .
          </p>
        )}
        {/* Empty query → group by category with headings (operator
           browsing). Active query → flat ranked list (keyboard-nav +
           focus highlight), since a filtered search shouldn't re-impose
           category headers. */}
        {query === '' ? (
          <div className="flex flex-col gap-6">
            {BLOCK_CATEGORIES.map((cat) => {
              const inCat = filtered.filter((e) => categoryForEntry(e) === cat.key)
              if (inCat.length === 0) return null
              return (
                <div key={cat.key} className="[&:first-child]:pt-2 [&:last-child]:pb-3 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-ivory/10 [&:not(:first-child)]:pt-5">
                  <p className="mb-2 px-1 text-[9px] font-semibold uppercase tracking-[0.22em] text-ivory/40">
                    {cat.label}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {inCat.map((entry) => (
                      <DraggablePill
                        key={entry.label}
                        entry={entry}
                        isBusy={busy === entry.label}
                        isFocused={false}
                        disabled={busy !== null}
                        onClick={() => add(entry.type, entry.data, entry.label)}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {filtered.map((entry, idx) => (
              <DraggablePill
                key={entry.label}
                entry={entry}
                isBusy={busy === entry.label}
                isFocused={idx === focusIndex}
                disabled={busy !== null}
                onClick={() => add(entry.type, entry.data, entry.label)}
              />
            ))}
          </div>
        )}
    </>
  )
}

// ─── DraggablePill ──────────────────────────────────────────────────
// Each widget pill in the picker is both a click target (insert at end
// of page via WidgetPicker.add → useInsertBlock) AND a drag source
// (insert at the dropped position via the page-wide EditModeDndShell
// onDragEnd palette branch). The two paths share the same insert API
// (`/api/cms/blocks` POST) — click sends no parent/before/after, drag
// computes them from the drop target.
//
// `useDraggable.id` is `palette:<label>`; label is unique across
// SEED_ENTRIES so this collides with no block id (numeric) and no
// `empty-col:<n>` synthetic id. The `data` payload carries the seed
// block type + per-entry seed data (e.g. Counter's 1-item items[]
// versus Stats Row's 3-item items[]) so the DnD shell doesn't need
// to look up SEED_ENTRIES — it just reads `event.active.data.current`.
//
// `disabled` gates both click + drag during an in-flight insert to
// prevent double-create races. The PointerSensor activation distance
// (6px, configured in EditModeDndShell) keeps a quick tap on the
// click path and a deliberate grab on the drag path.
function DraggablePill({
  entry,
  isBusy,
  isFocused,
  disabled,
  onClick,
}: {
  entry: SeedEntry
  isBusy: boolean
  isFocused: boolean
  disabled: boolean
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${entry.label}`,
    data: {
      kind: 'palette',
      blockType: entry.type,
      seedData: entry.data,
      label: entry.label,
    },
    disabled,
  })
  const Icon = entry.icon
  return (
    <button
      ref={setNodeRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      // touch-action: none ensures touch-drag works on iPad / mobile
      // without the browser hijacking the gesture for scroll. Cursor
      // signals the gesture affordance — grab when idle, grabbing
      // mid-drag, default when disabled.
      style={{ touchAction: 'none' }}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] transition-all disabled:cursor-not-allowed disabled:opacity-50',
        !disabled && (isDragging ? 'cursor-grabbing' : 'cursor-grab'),
        isDragging && 'opacity-40',
        isBusy
          ? 'bg-champagne/15 text-champagne'
          : isFocused
            ? 'bg-champagne text-obsidian ring-2 ring-champagne/40'
            : 'bg-ivory/5 text-ivory/85 hover:bg-champagne hover:text-obsidian',
      )}
      title={entry.description}
      {...listeners}
      {...attributes}
    >
      {isBusy ? (
        <Plus size={10} strokeWidth={2.4} className="animate-spin" />
      ) : (
        <Icon size={10} strokeWidth={2.4} />
      )}
      {isBusy ? 'Adding…' : entry.label}
    </button>
  )
}
