'use client'
import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, Search, Type } from 'lucide-react'
import {
  FONT_CATALOG,
  FONT_CATALOG_ORDER,
  FONT_CATEGORY_LABELS,
  fontCatalogVar,
  isFontCatalogKey,
  isTypographyRole,
  TYPOGRAPHY_ROLES,
  TYPOGRAPHY_ROLE_META,
  type FontCategory,
} from '@/lib/typography/catalog'
import type { CustomFont } from '@/lib/typography/customFonts'
import { csrfFetch } from '@/lib/client/csrf'
import { useCustomFonts } from './useCustomFonts'
import { useGoogleFonts, type GoogleFontCatalogEntry } from './useGoogleFonts'
import { useInView } from './useInView'
import { Popover } from './Popover'

// How many filtered Google families to render at once. The catalog is ~1,934
// families — rendering them all would mean ~1,934 DOM nodes + observers per
// picker open. We cap the visible window; the search box narrows the list so
// the operator finds any family by typing. Bounded per the scalability rule.
const GOOGLE_WINDOW = 60

// One picker option. The typeface preview is applied ONLY once the row
// scrolls into view (useInView) — so opening a picker with hundreds of
// fonts loads just the handful visible in the scroll viewport, not every
// font at once. Scales to the full catalog + 50 custom + (Phase B) Google.
function FontOption({
  name,
  sub,
  isActive,
  stack,
  onSelect,
}: {
  name: string
  sub: string
  isActive: boolean
  stack: string
  onSelect: () => void
}) {
  const { ref, inView } = useInView<HTMLButtonElement>()
  const faceStyle = inView ? { fontFamily: stack } : undefined
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={isActive}
      onClick={onSelect}
      className={
        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all duration-quick ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
        (isActive
          ? 'bg-copper-400/15 text-cream-50'
          : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-cream-50')
      }
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-cream-50/15 bg-cream-50/[0.04] text-[18px] font-bold text-cream-50"
        style={faceStyle}
      >
        Aa
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-current" style={faceStyle}>
          {name}
        </div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">{sub}</div>
      </div>
      {isActive && <Check className="h-4 w-4 text-copper-300" aria-hidden />}
    </button>
  )
}

// A Google-fonts catalog row. Like FontOption, the preview applies only once
// the row scrolls into view (useInView) — but the preview SOURCE differs by
// activation state:
//   • Activated (self-hosted): preview via the local --font-cat-gf-<slug> var.
//     No external request.
//   • Un-activated: render the "Aa" + name in a neutral CATEGORY fallback
//     (serif / sans / mono) — a typographic hint, NOT the real face. We do
//     NOT fetch anything from Google to preview: the site's own CSP is
//     font-src/style-src 'self', and — more importantly — pinging Google from
//     the admin browser would contradict the product's "nothing ever leaks to
//     Google" promise that this very picker prints. The real face appears the
//     instant the operator activates it (the server self-hosts the woff2, and
//     the row flips to the --font-cat-gf-<slug> var above).
function GoogleFontOption({
  entry,
  isActivated,
  isActive,
  isAdding,
  onSelect,
}: {
  entry: GoogleFontCatalogEntry
  isActivated: boolean
  isActive: boolean
  isAdding: boolean
  onSelect: () => void
}) {
  const { ref, inView } = useInView<HTMLButtonElement>()
  // Once visible: activated → self-hosted var (the real face); un-activated →
  // a neutral category fallback only (no external request — see the note
  // above). The real face renders the moment the operator activates it.
  let faceStyle: { fontFamily: string } | undefined
  if (inView) {
    faceStyle = isActivated
      ? { fontFamily: `var(${fontCatalogVar('gf-' + entry.slug)})` }
      : { fontFamily: entry.category === 'serif' ? 'serif' : entry.category === 'mono' ? 'monospace' : 'sans-serif' }
  }
  const sub = isActivated
    ? 'Google · self-hosted'
    : isAdding
      ? 'Adding…'
      : `Google · ${FONT_CATEGORY_LABELS[entry.category]}`
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={isActive}
      disabled={isAdding}
      onClick={onSelect}
      className={
        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all duration-quick ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 disabled:opacity-60 ' +
        (isActive
          ? 'bg-copper-400/15 text-cream-50'
          : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-cream-50')
      }
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-cream-50/15 bg-cream-50/[0.04] text-[18px] font-bold text-cream-50"
        style={faceStyle}
      >
        Aa
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-current" style={faceStyle}>
          {entry.family}
        </div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">{sub}</div>
      </div>
      {isAdding ? (
        <Loader2 className="h-4 w-4 animate-spin text-copper-300" aria-hidden />
      ) : (
        isActive && <Check className="h-4 w-4 text-copper-300" aria-hidden />
      )}
    </button>
  )
}

// Elementor-style family picker. Opens a popover with the two site
// ROLES (Headings / Body — which track Settings → Typography) plus the
// full self-hosted catalog grouped by category, searchable. Every
// option is rendered IN ITS OWN FACE so the operator picks visually,
// never by name (#0.59).
//
// `value` is EITHER a role token ('display' | 'body') OR a catalog font
// key ('cormorant-garamond', …) — the per-element override. undefined
// means the block uses its renderer default.

interface FontFamilyPickerFieldProps {
  label: string
  help?: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  // 'block' (default): per-element override — offers "renderer default" +
  // the two site roles + the catalog. 'role': configuring a global role
  // itself (Settings → Typography), so it offers ONLY catalog fonts (a
  // role can't point at "renderer default" or at another role).
  mode?: 'block' | 'role'
  // Surface the TRIGGER button sits on. 'dark' (default) is the inline-edit
  // drawer — pale-on-dark chip. 'light' is the cream settings card (Settings
  // → Typography) — ink-on-cream chip. Only the closed trigger + its label
  // changes; the popover body is always dark-surfaced.
  surface?: 'dark' | 'light'
}

// CSS font stack for a previewed value: roles resolve through the role
// leaf var (so the preview shows the operator's actual assigned font),
// catalog fonts through their --font-cat-* var.
function stackFor(value: string): string {
  if (isTypographyRole(value)) return `var(${TYPOGRAPHY_ROLE_META[value].cssVar})`
  return `var(${fontCatalogVar(value)})`
}

function describe(
  value: string | undefined,
  customFonts: readonly CustomFont[],
  googleActivated: readonly CustomFont[],
): { name: string; sub: string; stack: string } | null {
  if (!value) return null
  if (isTypographyRole(value)) {
    const m = TYPOGRAPHY_ROLE_META[value]
    return { name: `${m.label} role`, sub: 'Tracks Settings → Typography', stack: stackFor(value) }
  }
  const f = FONT_CATALOG[value]
  if (f) return { name: f.family, sub: FONT_CATEGORY_LABELS[f.category], stack: stackFor(value) }
  const c = customFonts.find((x) => x.key === value)
  if (c) {
    return { name: c.family, sub: `Custom · ${FONT_CATEGORY_LABELS[c.category]}`, stack: stackFor(value) }
  }
  // Activated Google fonts share the CustomFont shape (key `gf-<slug>`) and
  // render through the same --font-cat-* var.
  const g = googleActivated.find((x) => x.key === value)
  if (g) {
    return { name: g.family, sub: `Google · ${FONT_CATEGORY_LABELS[g.category]}`, stack: stackFor(value) }
  }
  return null
}

export function FontFamilyPickerField({
  label,
  help,
  value,
  onChange,
  mode = 'block',
  surface = 'dark',
}: FontFamilyPickerFieldProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Google section is collapsed by default — expanding it triggers the lazy
  // catalog fetch (useGoogleFonts(enabled)). Don't pull 1,934 families on
  // every picker open.
  const [googleOpen, setGoogleOpen] = useState(false)
  // slug currently being activated (server fetch in flight) → shows "Adding…".
  const [adding, setAdding] = useState<string | null>(null)
  const isRoleMode = mode === 'role'
  const isLight = surface === 'light'

  const { fonts: customFonts } = useCustomFonts()
  const {
    catalog: googleCatalog,
    activated: googleActivated,
    loading: googleLoading,
    reload: reloadGoogle,
  } = useGoogleFonts(googleOpen)
  const current = describe(value, customFonts, googleActivated)

  // Set of activated Google keys (`gf-<slug>`) for O(1) "already self-hosted?"
  // lookups in the Google list.
  const activatedKeys = useMemo(
    () => new Set(googleActivated.map((f) => f.key)),
    [googleActivated],
  )

  // Google catalog filtered by the shared search box, then WINDOWED to
  // GOOGLE_WINDOW rows. Without a query we still cap at the window (the most
  // popular families first — the catalog is popularity-sorted). With a query
  // the window covers the top matches; typing more narrows further.
  const googleFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches: GoogleFontCatalogEntry[] = []
    for (const e of googleCatalog) {
      if (q && !e.family.toLowerCase().includes(q)) continue
      matches.push(e)
      if (matches.length >= GOOGLE_WINDOW) break
    }
    return matches
  }, [query, googleCatalog])

  // Total match count (uncapped) so we can show "showing 60 of N — keep typing".
  const googleMatchCount = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return googleCatalog.length
    let n = 0
    for (const e of googleCatalog) if (e.family.toLowerCase().includes(q)) n++
    return n
  }, [query, googleCatalog])

  // Select a Google font. If not yet activated, POST to self-host its woff2
  // first (the server fetches it ONCE), then commit the value + refresh the
  // activated list. If already activated, just commit.
  async function selectGoogle(entry: GoogleFontCatalogEntry) {
    const key = `gf-${entry.slug}`
    if (activatedKeys.has(key)) {
      onChange(key)
      setOpen(false)
      return
    }
    if (adding) return
    setAdding(entry.slug)
    try {
      const r = await csrfFetch('/api/admin/fonts/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: entry.slug }),
      })
      if (!r.ok) {
        // Leave the picker open so the operator can retry / pick another.
        return
      }
      await reloadGoogle()
      onChange(key)
      setOpen(false)
    } finally {
      setAdding(null)
    }
  }

  // Catalog filtered by the search box, grouped by category in catalog order.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: Record<FontCategory, string[]> = { serif: [], sans: [], display: [], mono: [] }
    for (const key of FONT_CATALOG_ORDER) {
      const f = FONT_CATALOG[key]!
      if (q && !f.family.toLowerCase().includes(q)) continue
      out[f.category].push(key)
    }
    return out
  }, [query])

  // Operator's custom fonts, filtered by the search box.
  const customFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? customFonts.filter((f) => f.family.toLowerCase().includes(q)) : customFonts
  }, [query, customFonts])

  const optionBtn = (key: string, name: string, sub: string, isActive: boolean) => (
    <FontOption
      name={name}
      sub={sub}
      isActive={isActive}
      stack={stackFor(key)}
      onSelect={() => {
        onChange(key)
        setOpen(false)
      }}
    />
  )

  return (
    <div className="space-y-1.5">
      <span
        className={
          'block text-[11px] font-semibold uppercase tracking-[0.18em] ' +
          (isLight ? 'text-copper-700' : 'text-warm-stone')
        }
      >
        {label}
      </span>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={
          'group flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-all duration-quick focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
          (isLight
            ? 'border border-warm-stone/25 bg-cream-50 shadow-[0_1px_2px_rgba(45,38,33,0.04)] hover:border-copper-500/70 hover:shadow-[0_6px_18px_-12px_rgba(184,115,51,0.5)]'
            : 'border border-cream-50/15 bg-cream-50/[0.04] hover:border-copper-400/60')
        }
      >
        <span
          aria-hidden
          className={
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[17px] font-semibold transition-colors ' +
            (isLight
              ? 'border border-warm-stone/20 bg-cream-100/70 text-near-black group-hover:border-copper-400/50'
              : 'border border-cream-50/15 bg-cream-50/[0.06] text-cream-50')
          }
          style={{ fontFamily: current ? current.stack : 'inherit' }}
        >
          {current ? 'Aa' : <Type className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={
              'truncate text-[16px] leading-snug ' +
              (isLight ? 'text-near-black' : 'text-cream-50')
            }
            style={{ fontFamily: current ? current.stack : 'inherit' }}
          >
            {current ? current.name : 'Use renderer default'}
          </div>
          <div
            className={
              'mt-0.5 truncate text-[10px] uppercase tracking-[0.18em] ' +
              (isLight ? 'text-warm-stone/80' : 'text-cream-50/45')
            }
          >
            {current ? current.sub : 'No override'}
          </div>
        </div>
        <ChevronDown
          className={
            'h-4 w-4 shrink-0 transition-transform duration-quick ' +
            (open ? 'rotate-180 ' : '') +
            (isLight
              ? 'text-warm-stone group-hover:text-copper-600'
              : 'text-cream-50/50 group-hover:text-cream-50/80')
          }
          aria-hidden
        />
      </button>

      {help && (
        <span
          className={
            'mt-1 block text-[11px] ' +
            (isLight ? 'text-warm-stone/90' : 'text-warm-stone/80')
          }
        >
          {help}
        </span>
      )}

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        width={312}
        ariaLabel={`${label} picker`}
      >
        {/* Search */}
        <div className="relative mb-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cream-50/40"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fonts…"
            className="w-full rounded-lg border border-cream-50/15 bg-cream-50/[0.04] py-2 pl-8 pr-2.5 text-[13px] text-cream-50 placeholder:text-cream-50/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
          />
        </div>

        <div
          className="max-h-[340px] space-y-3 overflow-y-auto pr-0.5"
          role="listbox"
          aria-label={label}
        >
          {!isRoleMode && (
            <>
          {/* Default sentinel */}
          <button
            type="button"
            role="option"
            aria-selected={value === undefined}
            onClick={() => {
              onChange(undefined)
              setOpen(false)
            }}
            className={
              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all duration-quick ' +
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70 ' +
              (value === undefined
                ? 'bg-copper-400/15 text-cream-50'
                : 'text-cream-50/85 hover:bg-cream-50/10 hover:text-cream-50')
            }
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-cream-50/15 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
              —
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] text-current">Use renderer default</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-cream-50/45">
                Inherits whatever the block defines
              </div>
            </div>
            {value === undefined && <Check className="h-4 w-4 text-copper-300" aria-hidden />}
          </button>

          {/* Site roles — hidden while searching the catalog */}
          {!query.trim() && (
            <div>
              <div className="px-0.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
                Site roles
              </div>
              <div className="space-y-1">
                {TYPOGRAPHY_ROLES.map((role) => (
                  <span key={role}>
                    {optionBtn(
                      role,
                      `${TYPOGRAPHY_ROLE_META[role].label} role`,
                      'Tracks Settings → Typography',
                      value === role,
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
            </>
          )}

          {/* Catalog, grouped by category */}
          {(Object.keys(grouped) as FontCategory[]).map((cat) =>
            grouped[cat].length === 0 ? null : (
              <div key={cat}>
                <div className="px-0.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
                  {FONT_CATEGORY_LABELS[cat]}
                </div>
                <div className="space-y-1">
                  {grouped[cat].map((key) => {
                    const f = FONT_CATALOG[key]!
                    const wlabel = f.weightRange
                      ? `${f.weightRange[0]}–${f.weightRange[1]}`
                      : `${f.staticWeight ?? 400}`
                    return (
                      <span key={key}>
                        {optionBtn(
                          key,
                          f.family,
                          `${FONT_CATEGORY_LABELS[f.category]} · ${wlabel}`,
                          isFontCatalogKey(value ?? '') && value === key,
                        )}
                      </span>
                    )
                  })}
                </div>
              </div>
            ),
          )}

          {/* Custom — operator-uploaded fonts (self-hosted) */}
          {customFiltered.length > 0 && (
            <div>
              <div className="px-0.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65">
                Custom
              </div>
              <div className="space-y-1">
                {customFiltered.map((f) => (
                  <span key={f.key}>
                    {optionBtn(
                      f.key,
                      f.family,
                      `Custom · ${FONT_CATEGORY_LABELS[f.category]}`,
                      value === f.key,
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Google Fonts — the full ~1,900-family library, self-hosted on
             demand. Collapsed by default so opening the picker never fetches
             the catalog; expanding it triggers the lazy fetch. Filtered by the
             same search box, windowed to GOOGLE_WINDOW rows (never 1,934 DOM
             nodes). Selecting an un-activated font self-hosts its woff2 on the
             server first — visitors never load anything from Google. */}
          <div>
            <button
              type="button"
              onClick={() => setGoogleOpen((v) => !v)}
              aria-expanded={googleOpen}
              className="flex w-full items-center gap-2 rounded-lg px-0.5 py-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.22em] text-cream-50/65 transition-colors hover:text-cream-50/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-copper-400/70"
            >
              <ChevronRight
                className={
                  'h-3.5 w-3.5 shrink-0 transition-transform duration-quick ' +
                  (googleOpen ? 'rotate-90' : '')
                }
                aria-hidden
              />
              <span className="flex-1">Google Fonts (1,900+)</span>
            </button>

            {googleOpen && (
              <div className="mt-1 space-y-1">
                {googleLoading && googleCatalog.length === 0 ? (
                  <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-cream-50/55">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Loading library…
                  </div>
                ) : googleFiltered.length === 0 ? (
                  <div className="px-2.5 py-2 text-[12px] text-cream-50/55">
                    No Google fonts match “{query.trim()}”.
                  </div>
                ) : (
                  <>
                    {googleFiltered.map((entry) => {
                      const key = `gf-${entry.slug}`
                      return (
                        <span key={key}>
                          <GoogleFontOption
                            entry={entry}
                            isActivated={activatedKeys.has(key)}
                            isActive={value === key}
                            isAdding={adding === entry.slug}
                            onSelect={() => void selectGoogle(entry)}
                          />
                        </span>
                      )
                    })}
                    {googleMatchCount > googleFiltered.length && (
                      <div className="px-2.5 py-1.5 text-[11px] text-cream-50/45">
                        Showing {googleFiltered.length} of {googleMatchCount} — keep
                        typing to narrow.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </Popover>
    </div>
  )
}
