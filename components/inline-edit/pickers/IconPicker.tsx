'use client'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { iconNames, type IconName } from 'lucide-react/dynamic'
import { Search, X, Star, Clock, Grid3x3 } from 'lucide-react'
import { safeStorage } from '@/lib/client/safeStorage'
import {
  acquireScrollLock,
  releaseScrollLock,
} from '@/lib/client/bodyScrollLock'
import { IconByName } from '@/components/project-sections/_shared/IconByName'

// Full Lucide library icon picker. Modal with backdrop, portal-mounted
// at document.body so it escapes the EditDrawer's overflow region and
// covers the full viewport on mobile.
//
// Anatomy (Elementor-parity):
//  - Top header: title, ×, current selection preview
//  - Left rail: filter pills (All / Common / Recents)
//  - Top of right pane: search input (debounced 150ms, substring match)
//  - Right pane body: grid of 48px tiles, 8 cols desktop, 6 mobile
//  - Footer: Insert (primary) / Cancel — Insert disabled until pick
//
// Performance: bounded render. We render up to MAX_VISIBLE_RESULTS
// tiles at once. Default view (no search) shows recents + the CaveCMS
// common set (~50 names) — well under the cap. Switch to "All" with
// no search → first 240 names alphabetically; operator searches to
// refine. Each visible tile uses `DynamicIcon` which lazy-imports
// the icon module — only the visible icons pay the cost.

const RECENT_ICONS_KEY = 'cavecms.editor.recentIcons'
const MAX_RECENTS = 12
const MAX_VISIBLE_RESULTS = 240

// Set built once at module-init so the per-render existence check in
// `visibleIcons` (and the recents-load filter below) is O(1) instead
// of O(1952). The set is also the runtime allowlist for localStorage
// reads — a poisoned recent entry that isn't a real Lucide name is
// dropped on load.
const LUCIDE_NAME_SET: ReadonlySet<string> = new Set(
  iconNames as ReadonlyArray<string>,
)

// Same shape as the Zod ICON_NAME_RE (lib/cms/block-registry.ts).
// Used to gate localStorage entries before we trust them — a hostile
// browser extension or shared-machine tamper can't smuggle bidi /
// non-kebab strings into editor state.
const ICON_NAME_RE = /^[a-z][a-z0-9-]{0,59}$/

// Curated CaveCMS "common" icons — drawn from the amenity registry plus
// editorial/UI staples. Kebab-case (matches Lucide's dynamicIconImports
// keys). Mirrors components/project-sections/_shared/amenityIcons.ts.
const COMMON_ICON_NAMES_RAW: ReadonlyArray<IconName> = [
  // Communication
  'mail', 'phone', 'map-pin', 'clock',
  // Amenities
  'waves', 'dumbbell', 'bell', 'trees', 'leaf', 'cpu',
  'circle-parking', 'car', 'shield-check', 'building-2', 'wifi',
  'palmtree', 'sparkles', 'coffee', 'utensils-crossed', 'wine',
  'film', 'flame', 'sun', 'zap', 'warehouse', 'anchor',
  'droplets', 'baby', 'paw-print', 'umbrella', 'home', 'key',
  // Markers
  'check', 'star', 'heart',
  // Editorial / UI
  'arrow-up-right', 'arrow-right', 'arrow-down-right', 'chevron-right',
  'quote', 'plus', 'minus', 'circle-check', 'circle-alert',
  'info', 'sparkle', 'gem', 'crown', 'award', 'badge-check',
  'eye', 'users', 'user', 'globe', 'building', 'briefcase',
] as IconName[]

// Pre-filter the COMMON set to icons that ACTUALLY exist in this
// Lucide build — done once at module load so the per-render
// `useMemo(visibleIcons)` doesn't redo a 52*1952 includes() scan.
const COMMON_ICON_NAMES: ReadonlyArray<IconName> = COMMON_ICON_NAMES_RAW.filter(
  (n) => LUCIDE_NAME_SET.has(n),
)

interface IconPickerModalProps {
  open: boolean
  onClose: () => void
  value: string | undefined
  onChange: (v: string | undefined) => void
}

type TabKey = 'all' | 'common' | 'recents'

// Load recents from localStorage with full validation. Drops anything
// that isn't a (a) string, (b) kebab-ASCII name, (c) actually present
// in this Lucide build. Self-heals the storage on drift so the next
// load is cheap. Called synchronously from the modal-open effect AND
// the IconPickerField trigger render so the result is always usable
// before first paint.
function loadValidatedRecents(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = safeStorage.get(RECENT_ICONS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const clean = parsed
      .filter((x): x is string => typeof x === 'string')
      .filter((x) => ICON_NAME_RE.test(x) && LUCIDE_NAME_SET.has(x))
      .slice(0, MAX_RECENTS)
    if (clean.length !== parsed.length) {
      try {
        safeStorage.set(RECENT_ICONS_KEY, JSON.stringify(clean))
      } catch {
        /* ignore */
      }
    }
    return clean
  } catch {
    return []
  }
}

// IntersectionObserver-based lazy tile. Renders a transparent
// placeholder until the tile is within ~200px of the viewport, then
// swaps to IconByName (which itself uses lucide-react DynamicIcon
// internally). This caps the initial-paint import storm on the "All"
// tab from 240 simultaneous module fetches down to the ~48 visible.
// Once a tile has rendered, it stays rendered (no swap-back) so a
// scroll-back to already-loaded tiles is instant.
function LazyIconTile({
  name,
  isActive,
  onPick,
  onCommit,
}: {
  name: string
  isActive: boolean
  onPick: () => void
  onCommit: () => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (visible) return
    const el = ref.current
    if (!el) return
    // SSR / older browsers without IntersectionObserver: just render.
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={isActive}
      onClick={onPick}
      onDoubleClick={onCommit}
      title={name}
      className={
        'group flex aspect-square items-center justify-center rounded-md border transition-all duration-quick ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
        (isActive
          ? 'border-copper-400 bg-copper-400/15 text-champagne ring-2 ring-copper-400/40'
          : 'border-cream-50/8 bg-cream-50/[0.03] text-cream-50/75 hover:scale-[1.05] hover:border-copper-400/60 hover:bg-copper-400/8 hover:text-champagne')
      }
    >
      {visible && <IconByName name={name} className="h-5 w-5" aria-hidden />}
    </button>
  )
}

export function IconPickerModal({
  open,
  onClose,
  value,
  onChange,
}: IconPickerModalProps) {
  const [tab, setTab] = useState<TabKey>('common')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selection, setSelection] = useState<string | undefined>(value)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Recents: initialise SYNCHRONOUSLY from localStorage (validated) so
  // the open-effect's tab-default check sees the real list — not the
  // empty initial value the prior implementation captured in a stale
  // closure. The init function runs once per component instance; the
  // mounted-flag SSR guard inside loadValidatedRecents prevents a
  // hydration mismatch.
  const [recents, setRecents] = useState<string[]>(() => loadValidatedRecents())

  // Open-effect: reset transient state AND default the tab. Reads
  // `recents` from the closure of THIS render, which (now that the
  // load is synchronous) is the real list, not [].
  useEffect(() => {
    if (!open) return
    setSelection(value)
    setQuery('')
    setDebouncedQuery('')
    // Re-pull recents from storage on every open in case another
    // editor surface in the same SPA updated them in between.
    const fresh = loadValidatedRecents()
    setRecents(fresh)
    setTab(value && fresh.includes(value) ? 'recents' : 'common')
  }, [open, value])

  const pushRecent = useCallback((name: string) => {
    setRecents((prev) => {
      const next = [name, ...prev.filter((n) => n !== name)].slice(
        0,
        MAX_RECENTS,
      )
      try {
        safeStorage.set(RECENT_ICONS_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  // Debounced search — implemented inline with a ref-held timer so we
  // can guarantee cleanup on unmount (the prior closure-debounce had
  // no cleanup path; an unmount mid-debounce fired a setState on a
  // dead component).
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => setDebouncedQuery(query), 150)
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [query])

  // Compute the displayed icon list. Search wins over tab filter.
  // COMMON_ICON_NAMES is now pre-filtered at module-init against
  // LUCIDE_NAME_SET, so no per-render existence scan is needed.
  const visibleIcons = useMemo<ReadonlyArray<string>>(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (q) {
      const matches: string[] = []
      for (const n of iconNames) {
        if (n.includes(q)) {
          matches.push(n)
          if (matches.length >= MAX_VISIBLE_RESULTS) break
        }
      }
      return matches
    }
    if (tab === 'recents') return recents
    if (tab === 'common') return COMMON_ICON_NAMES
    // All tab — bounded.
    return (iconNames as ReadonlyArray<string>).slice(0, MAX_VISIBLE_RESULTS)
  }, [tab, debouncedQuery, recents])

  const totalMatchCount = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return null
    let n = 0
    for (const name of iconNames) if (name.includes(q)) n++
    return n
  }, [debouncedQuery])

  // `commit` declared BEFORE the keydown effect so the effect's
  // deps array can include it cleanly — the previous version had a
  // forward reference and an eslint-disable on the deps array.
  const commit = useCallback(() => {
    if (!selection) return
    onChange(selection)
    pushRecent(selection)
    onClose()
  }, [selection, onChange, pushRecent, onClose])

  // Keyboard nav.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture + stopImmediatePropagation so Esc closes ONLY the icon
        // picker, not the EditDrawer behind it (the drawer also has a
        // window-level Esc→close listener; sibling window listeners aren't
        // stopped by plain stopPropagation).
        e.stopImmediatePropagation()
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'Enter' && selection) {
        e.preventDefault()
        commit()
        return
      }
      if (
        ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)
      ) {
        const list = visibleIcons
        if (list.length === 0) return
        const cur = selection ? list.indexOf(selection) : -1
        // No selection yet: any arrow key lands on index 0. Without
        // this branch, ArrowDown from cur=-1 lands at cols-1 (the
        // 8th tile on desktop), which is asymmetric with ArrowRight
        // from null (lands at 0).
        if (cur < 0) {
          e.preventDefault()
          setSelection(list[0])
          return
        }
        // Read column count from a CSS var so the desktop/mobile
        // grid stays in sync without recomputing media queries.
        const grid = gridRef.current
        const cols = grid
          ? Math.max(
              1,
              Math.floor(
                grid.clientWidth /
                  // tile + gap (44 + 6 = 50)
                  50,
              ),
            )
          : 8
        let next = cur
        if (e.key === 'ArrowRight') next = cur + 1
        if (e.key === 'ArrowLeft') next = cur - 1
        if (e.key === 'ArrowDown') next = cur + cols
        if (e.key === 'ArrowUp') next = cur - cols
        if (next < 0) next = 0
        if (next >= list.length) next = list.length - 1
        e.preventDefault()
        setSelection(list[next])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, selection, visibleIcons, onClose, commit])

  // Body scroll lock on open — counter-based via lib/client/bodyScrollLock
  // so it stacks correctly with the EditDrawer's own lock. The previous
  // direct `body.style.overflow` overwrote the drawer's setting and
  // left the body locked after both surfaces closed in close-pair races.
  useEffect(() => {
    if (!open) return
    acquireScrollLock()
    return () => releaseScrollLock()
  }, [open])

  // Auto-focus search on open.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => searchRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])

  if (!open || !mounted) return null

  const TabButton = ({
    k,
    label,
    icon,
  }: {
    k: TabKey
    label: string
    icon: ReactNode
  }) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === k}
      onClick={() => setTab(k)}
      className={
        'flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-[0.16em] transition-all duration-quick ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
        (tab === k
          ? 'bg-copper-400/20 text-cream-50'
          : 'text-cream-50/65 hover:bg-cream-50/8 hover:text-cream-50')
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  const modal = (
    <div
      // z-[90]: above the EditDrawer (portaled to <body> at z-[85]) so a
      // picker launched from a drawer icon field isn't painted behind the
      // opaque drawer panel (which hid the grid + made tiles unclickable).
      // Below toasts (z-[100]).
      className="fixed inset-0 z-[90] flex items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Icon picker"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-near-black/65 backdrop-blur-md animate-cavecms-fade-in motion-reduce:animate-none"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className={
          'relative z-[81] flex w-full max-w-[820px] flex-col overflow-hidden bg-near-black text-cream-50 shadow-[0_24px_60px_-12px_rgba(5,5,5,0.65)] ' +
          'h-full sm:h-[640px] sm:max-h-[85vh] sm:rounded-2xl sm:border sm:border-cream-50/12 ' +
          'animate-cavecms-slide-up motion-reduce:animate-none'
        }
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-cream-50/10 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/55">
              Choose icon
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              {selection ? (
                <>
                  <IconByName
                    name={selection}
                    className="h-5 w-5 text-champagne"
                  />
                  <code className="font-mono text-[12.5px] text-cream-50/85">
                    {selection}
                  </code>
                </>
              ) : (
                <span className="text-[12.5px] text-cream-50/45">
                  No icon selected
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={!selection}
              className="rounded-full bg-champagne px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-obsidian transition-all hover:bg-antique-gold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
            >
              Insert
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close icon picker"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-cream-50/15 text-cream-50/65 transition-colors hover:border-cream-50/40 hover:text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        {/* Body — left rail + right pane */}
        <div className="flex min-h-0 flex-1">
          {/* Left rail. Stacked tabs at desktop; horizontal pills on
              mobile so the modal can use the full viewport width. */}
          <div className="hidden w-44 shrink-0 flex-col gap-1 border-r border-cream-50/10 p-3 sm:flex">
            <TabButton
              k="common"
              label="Common"
              icon={<Star className="h-3.5 w-3.5" aria-hidden />}
            />
            <TabButton
              k="recents"
              label="Recents"
              icon={<Clock className="h-3.5 w-3.5" aria-hidden />}
            />
            <TabButton
              k="all"
              label="All"
              icon={<Grid3x3 className="h-3.5 w-3.5" aria-hidden />}
            />
            <div className="mt-auto pt-2 text-[10px] tracking-[0.16em] text-cream-50/35">
              {iconNames.length.toLocaleString()} icons
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* Mobile tab pills */}
            <div className="flex gap-1 border-b border-cream-50/10 px-3 py-2 sm:hidden">
              <TabButton k="common" label="Common" icon={null} />
              <TabButton k="recents" label="Recents" icon={null} />
              <TabButton k="all" label="All" icon={null} />
            </div>

            {/* Search */}
            <div className="relative border-b border-cream-50/10 px-4 py-3">
              <Search
                className="pointer-events-none absolute left-7 top-1/2 h-4 w-4 -translate-y-1/2 text-cream-50/45"
                aria-hidden
              />
              <input
                ref={searchRef}
                type="search"
                placeholder='Search icons — try "mail", "arrow", "shield"…   ( / to focus )'
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="!w-full !rounded-xl !border !border-cream-50/15 !bg-cream-50/[0.04] !pl-10 !pr-3 !py-2.5 text-[14px] text-cream-50 placeholder:text-cream-50/35 focus:!border-copper-400 focus:!outline-none focus:!ring-2 focus:!ring-copper-400/40"
              />
            </div>

            {/* Grid */}
            <div
              ref={gridRef}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
              role="listbox"
              aria-label="Icon results"
            >
              {visibleIcons.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center">
                  <div className="max-w-xs">
                    <div className="text-[13px] text-cream-50/65">
                      {tab === 'recents'
                        ? 'No recently used icons yet. Pick one and it’ll show up here next time.'
                        : 'No matches.'}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
                    {visibleIcons.map((name) => (
                      <LazyIconTile
                        key={name}
                        name={name}
                        isActive={selection === name}
                        onPick={() => setSelection(name)}
                        onCommit={commit}
                      />
                    ))}
                  </div>

                  {totalMatchCount !== null &&
                    totalMatchCount > visibleIcons.length && (
                      <div className="mt-4 rounded-lg border border-cream-50/10 bg-cream-50/[0.03] px-3 py-2 text-center text-[11px] text-cream-50/55">
                        Showing the first{' '}
                        <strong className="text-cream-50/85">
                          {visibleIcons.length}
                        </strong>{' '}
                        of{' '}
                        <strong className="text-cream-50/85">
                          {totalMatchCount.toLocaleString()}
                        </strong>{' '}
                        matches — refine your search to narrow.
                      </div>
                    )}

                  {tab === 'all' && !debouncedQuery && (
                    <div className="mt-4 rounded-lg border border-cream-50/10 bg-cream-50/[0.03] px-3 py-2 text-center text-[11px] text-cream-50/55">
                      Showing first {MAX_VISIBLE_RESULTS} icons of{' '}
                      {iconNames.length.toLocaleString()} — search to find a
                      specific icon.
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer hint */}
            <div className="hidden items-center justify-between border-t border-cream-50/10 px-4 py-2 text-[10.5px] uppercase tracking-[0.18em] text-cream-50/40 sm:flex">
              <span>↑↓←→ navigate</span>
              <span>↵ insert</span>
              <span>esc close</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  return mounted ? createPortal(modal, document.body) : null
}

// Trigger row component — shows the current icon + name, opens the
// modal on click. The actual modal lives in IconPickerModal; the row
// is the in-form widget that ZodForm renders. Decoupled so the same
// modal could be reused from other contexts (e.g. a "set page icon"
// in admin meta) without rebuilding it.
interface IconPickerFieldProps {
  label: string
  help?: string
  value: string | undefined
  onChange: (v: string | undefined) => void
}

export function IconPickerField({
  label,
  help,
  value,
  onChange,
}: IconPickerFieldProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-warm-stone">
        {label}
      </span>

      <div className="flex items-center gap-2 rounded-xl border border-cream-50/15 bg-cream-50/[0.04] px-1.5 py-1.5 transition-all duration-quick focus-within:border-copper-400/60 hover:border-copper-400/40">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`${label} — open icon picker`}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-all duration-quick hover:bg-cream-50/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-cream-50/10 bg-cream-50/[0.04] text-champagne transition-colors group-hover:bg-copper-400/10">
            {value ? (
              <IconByName name={value} className="h-5 w-5" aria-hidden />
            ) : (
              <Search className="h-4 w-4 text-cream-50/40" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-cream-50">
              {value ? (
                <code className="font-mono text-[13px]">{value}</code>
              ) : (
                <span className="text-cream-50/45">Choose icon…</span>
              )}
            </div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
              {value ? 'Click to change' : 'Lucide library · search & pick'}
            </div>
          </div>
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-cream-50/55 transition-colors hover:bg-cream-50/10 hover:text-cream-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
            aria-label="Clear icon"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      {help && (
        <span className="mt-1 block text-[11px] text-warm-stone/80">
          {help}
        </span>
      )}

      <IconPickerModal
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        onChange={onChange}
      />
    </div>
  )
}
