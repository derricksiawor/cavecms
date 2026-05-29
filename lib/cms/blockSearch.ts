// Chunk I — hand-rolled fuzzy search for the slash command + ⌘K palette.
//
// No fuse.js / cmdk / kbar. At the current ~22-entry catalog size, a
// library is over-engineering — the brute-force token-includes + bounded
// Levenshtein walker below is < 50 LOC, has zero deps, and outperforms a
// scored-index library on cold pageload (no JSON index to deserialise,
// no analyzer warm-up). When the catalog crosses ~200 entries we revisit.
//
// Ranking mental models drawn from the five-tool research pass
// (elite-web-researcher, 2026-05-17). Findings condensed here so future
// maintainers don't have to re-do the audit:
//
//   - Notion  /     — exact title prefix > alias prefix > title fuzzy
//                     substring > category keyword. No typo tolerance.
//                     Source paragraph REPLACED when empty.
//   - Linear ⌘K     — context-relevance > exact title > alias prefix >
//                     fuzzy substring > recency. No typo correction.
//   - Raycast       — documented: 1) exact alias, 2) alias prefix,
//                     3) title fuzzy, 4) subtitle/keyword, 5) frecency.
//                     Aliases are STRICT PREFIX only. User-tunable
//                     fuzzy sensitivity (Low/Medium/High).
//   - Wix Studio    — substring on element name + tags within category
//                     groupings; no global re-sort.
//   - Elementor     — case-insensitive substring on widget name within
//                     category groupings.
//
// Our take: combine Raycast's priority order (exact > prefix > substring
// > keyword > typo) with Notion's source-paragraph-replace behaviour,
// and add bounded Levenshtein (≤ 2) at the bottom for typo tolerance
// (Notion doesn't have it; we want "headign" → Heading to work because
// operators DO mistype, and 22 entries means false-positive risk is low).
//
// Empty query is the curated-order catalog slice (matches Notion +
// Elementor's "above the fold" default).

import {
  Image as ImageIcon,
  LayoutTemplate,
  type LucideIcon,
} from 'lucide-react'
import {
  SEED_ENTRIES,
  isPaletteVisible,
  type SeedBlockType,
  type SeedEntry,
} from './blockSeeds'

// SearchableItem is the catalog row consumed by both the slash popover
// and the ⌘K palette. Composed at module load from SEED_ENTRIES + the
// Picture entry (which runs through MediaPicker, not a direct seed
// POST) + a Templates stub (placeholder until Chunk J lands).
export interface SearchableItem {
  /** Stable id for React keys + dispatch tracing. Includes the label
   *  in kebab form so that if two SEED_ENTRIES ever share a blockType
   *  (a preset + its base block), their ids stay distinct. */
  id: string
  /** Dispatch hint — tells the caller WHICH insertion path to take.
   *   - 'seed'     → POST /api/cms/blocks with SEED_DATA[blockType]
   *                  (or the entry's data override).
   *   - 'media'    → open MediaPicker, then POST with media_id.
   *   - 'template' → reserved for Chunk J's section-template gallery.
   *                  Disabled in Chunk I (disabled flag below). */
  kind: 'seed' | 'media' | 'template'
  /** Present only when kind === 'seed'. The block_type to POST. */
  blockType?: SeedBlockType
  label: string
  description: string
  icon: LucideIcon
  /** Operator-mental-model synonyms. Surfaced as a small "aliases:
   *  h1, h2" chip on result rows so operators learn the shorthand. */
  aliases?: string[]
  /** Conceptual tags — looser-fit terms the operator might reach for
   *  ("stat" → Counter, "review" → Testimonial). NOT surfaced in the
   *  result row chrome; ranked LOWER than aliases on the assumption
   *  that an alias is a known shorthand while a keyword is a guess. */
  keywords?: string[]
  /** Per-entry seed payload override (matches SeedEntry.data). Lets
   *  Counter + Stats Row both seed `stats_row` with different default
   *  item[] arrays. Caller forwards this to the insertBlock action. */
  data?: Record<string, unknown>
  /** When set, the result row renders with reduced opacity + a
   *  tooltip; activation no-ops. Used today by the Templates stub. */
  disabled?: boolean
  disabledReason?: string
}

export interface SearchHit {
  item: SearchableItem
  /** Higher = better match. Range 0..1000. Used for sort + (in the
   *  result row) for the optional "best match" visual treatment. */
  score: number
  /** When the WINNING match was via an alias, the matched alias is
   *  returned so the result row's alias chip can highlight it
   *  ("matched via: h1"). Undefined when match was label / keyword /
   *  Levenshtein-against-label. */
  matchedAlias?: string
}

// Cap result count. More than ~8 rows is keyboard-nav friction (the
// operator can't reach row 9 without losing the keyboard-only
// affordance). Notion + Linear both cap their default view around 8.
const MAX_RESULTS = 8

// Ranking weights — priority order encoded as score values 100 apart so
// no two tiers can collide. Tier-internal ties break on catalog order
// (the curated SEED_ENTRIES order is intentional + tested).
const WEIGHT_EXACT_LABEL = 1000
const WEIGHT_EXACT_ALIAS = 900
const WEIGHT_LABEL_PREFIX = 800
const WEIGHT_ALIAS_PREFIX = 700
const WEIGHT_LABEL_SUBSTRING = 600
const WEIGHT_ALIAS_SUBSTRING = 500
const WEIGHT_KEYWORD = 400
// Levenshtein tiers — base - lev * (50|30). lev=1 -> 250 (label) / 170
// (alias); lev=2 -> 200 / 140. Always below keyword (400) because an
// operator typing a real keyword is a more confident signal than a
// typo'd label.
const WEIGHT_LEV_LABEL_BASE = 300
const WEIGHT_LEV_LABEL_STEP = 50
const WEIGHT_LEV_ALIAS_BASE = 200
const WEIGHT_LEV_ALIAS_STEP = 30
const MAX_LEV_DISTANCE = 2

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

// Bounded Levenshtein — iterative DP, single-row rolling array.
//
// We cap at MAX_LEV_DISTANCE (2): callers ALWAYS check the length
// delta before invoking so |a|-|b| ≤ 2, which means the matrix is at
// most (|a|+1) × (|b|+1) cells and |a|+1 ≤ 18 for our 16-char labels.
// At ~22 catalog entries × ~5 aliases each × ~18×18 cell walk per
// keystroke, that's ~36k array ops/keystroke worst-case — well under
// the 80ms debounce budget the SlashCommandProvider enforces.
//
// We don't use the standard "if early-exit when min(row) > k" trick
// because the per-cell cost saving (~30%) doesn't materially change
// the 80ms budget but DOES make the function harder to reason about
// in review. Plain DP is the readable choice here.
//
// PERF — when SEED_ENTRIES grows past ~150 entries the per-keystroke
// cost crosses ~300k ops. At that point add the min-row early-exit:
//   `if (min(curr) > MAX_LEV_DISTANCE) return MAX_LEV_DISTANCE + 1`
// at the bottom of each outer-loop iteration. ~30% gain. Don't add
// it preemptively — the readability cost outweighs the perf gain at
// today's catalog size.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length
  const n = b.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j += 1) prev[j] = j
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      // Min of (deletion, insertion, substitution).
      const del = prev[j]! + 1
      const ins = curr[j - 1]! + 1
      const sub = prev[j - 1]! + cost
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
    }
    // Swap rows — `prev` becomes `curr` for the next iteration; the
    // old `prev` array is reused as scratch for the next `curr`.
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n]!
}

/**
 * Score a single catalog item against the query. Returns the best
 * match tier (label vs alias vs keyword vs Levenshtein) + the matched
 * alias when applicable. Returns 0 score when no tier matches.
 *
 * Exported for tests; the public surface uses `searchBlocks`.
 */
export function scoreItem(
  query: string,
  item: SearchableItem,
): { score: number; matchedAlias?: string } {
  const q = normalize(query)
  if (q === '') return { score: 0 }
  const lbl = normalize(item.label)
  let bestScore = 0
  let bestAlias: string | undefined

  // ── Tier 1-3: label exact / prefix / substring ──
  if (lbl === q) {
    bestScore = WEIGHT_EXACT_LABEL
  } else if (lbl.startsWith(q)) {
    bestScore = WEIGHT_LABEL_PREFIX
  } else if (lbl.includes(q)) {
    bestScore = WEIGHT_LABEL_SUBSTRING
  }

  // ── Tier 1-3 (alias variants): alias exact / prefix / substring ──
  for (const alias of item.aliases ?? []) {
    const al = normalize(alias)
    let aliasScore = 0
    if (al === q) aliasScore = WEIGHT_EXACT_ALIAS
    else if (al.startsWith(q)) aliasScore = WEIGHT_ALIAS_PREFIX
    else if (al.includes(q)) aliasScore = WEIGHT_ALIAS_SUBSTRING
    if (aliasScore > bestScore) {
      bestScore = aliasScore
      bestAlias = alias
    }
  }

  // ── Tier 4: keyword substring ──
  // Keywords are softer than aliases (a guess, not a known shorthand)
  // so they rank below the alias-substring tier. A keyword hit does
  // NOT populate matchedAlias (the chip is alias-specific).
  if (bestScore < WEIGHT_KEYWORD) {
    for (const keyword of item.keywords ?? []) {
      const kw = normalize(keyword)
      if (kw.includes(q)) {
        bestScore = WEIGHT_KEYWORD
        break
      }
    }
  }

  // ── Tier 5: bounded Levenshtein (typo tolerance) ──
  // Only when NO direct match landed (label / alias / keyword all
  // produced bestScore=0). Length-delta gate first so we don't waste a
  // DP walk on obviously non-matching pairs (e.g. q="head", lbl="testimonial").
  if (bestScore === 0) {
    if (Math.abs(lbl.length - q.length) <= MAX_LEV_DISTANCE) {
      const lev = levenshtein(lbl, q)
      if (lev <= MAX_LEV_DISTANCE) {
        bestScore = WEIGHT_LEV_LABEL_BASE - lev * WEIGHT_LEV_LABEL_STEP
      }
    }
    for (const alias of item.aliases ?? []) {
      const al = normalize(alias)
      if (Math.abs(al.length - q.length) <= MAX_LEV_DISTANCE) {
        const lev = levenshtein(al, q)
        if (lev <= MAX_LEV_DISTANCE) {
          const score = WEIGHT_LEV_ALIAS_BASE - lev * WEIGHT_LEV_ALIAS_STEP
          if (score > bestScore) {
            bestScore = score
            bestAlias = alias
          }
        }
      }
    }
  }

  return bestScore > 0
    ? { score: bestScore, matchedAlias: bestAlias }
    : { score: 0 }
}

/**
 * Search a catalog of SearchableItems against the query. Exported for
 * tests so they can pass arbitrary catalogs; the public `searchBlocks`
 * wraps this against the module-scoped composed catalog.
 *
 * Empty query → returns the first MAX_RESULTS items in catalog order
 * (the curated SEED_ENTRIES ordering — most-reached-for widgets first).
 *
 * Non-empty query → returns up to MAX_RESULTS hits, sorted by score
 * descending. Tier-internal ties break on catalog index ascending so
 * the curated order shows through for equal-score matches.
 */
export function searchCatalog(
  query: string,
  catalog: readonly SearchableItem[],
): SearchHit[] {
  const q = normalize(query)
  if (q === '') {
    return catalog
      .slice(0, MAX_RESULTS)
      .map((item) => ({ item, score: 0 }))
  }
  const hits: SearchHit[] = []
  for (let i = 0; i < catalog.length; i += 1) {
    const item = catalog[i]!
    const { score, matchedAlias } = scoreItem(q, item)
    if (score > 0) {
      hits.push({ item, score, matchedAlias })
    }
  }
  // Sort by score desc, then by catalog index asc for stable ordering
  // inside a tier. The index map closure captures `catalog` so we
  // don't re-scan for indexOf on each compare. Cached in a WeakMap
  // keyed by the catalog reference so the same frozen CATALOG_CACHE
  // doesn't rebuild the map on every keystroke (palette + inline both
  // call searchBlocks on every debounce tick).
  const idx = getCatalogIndex(catalog)
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (idx.get(a.item) ?? 0) - (idx.get(b.item) ?? 0)
  })
  return hits.slice(0, MAX_RESULTS)
}

// Per-catalog-reference index map. WeakMap so a future catalog
// invalidation (HMR, plugin re-registration) doesn't pin the old
// catalog identity + its index in memory — GC reclaims both together.
const INDEX_CACHE = new WeakMap<
  readonly SearchableItem[],
  Map<SearchableItem, number>
>()

function getCatalogIndex(
  catalog: readonly SearchableItem[],
): Map<SearchableItem, number> {
  let m = INDEX_CACHE.get(catalog)
  if (!m) {
    m = new Map<SearchableItem, number>()
    for (let i = 0; i < catalog.length; i += 1) {
      m.set(catalog[i]!, i)
    }
    INDEX_CACHE.set(catalog, m)
  }
  return m
}

// ── Module-scoped catalog ──
// Built once on first access + frozen. Callers can't mutate the top-
// level array; entries' `data` payloads stay reference-shared with
// SEED_ENTRIES (a deep-freeze would be defence-in-depth but costs
// memory + the server's parseAndSanitize is the authoritative trust
// boundary so the top-level freeze is sufficient).
//
// Computed lazily so import order between this module + blockSeeds
// can't matter (the call site reads SEED_ENTRIES which is a const
// export but Vite/Next's HMR can produce odd init orders).
//
// HMR note: when blockSeeds.ts is edited in dev, this module does
// NOT re-evaluate — CATALOG_CACHE still references the old
// SEED_ENTRIES until a full page reload. Operators editing the seed
// table for the first time will see fast-refresh propagate via the
// consumers that import SEED_ENTRIES directly (the 4 pickers); the
// palette/inline surfaces pick up the new shape on the next manual
// reload. Acceptable trade-off vs adding HMR plumbing for a
// developer-only path.
//
// PLUGIN MODEL — when future widget packs need to register entries
// dynamically (Chunk K/L), the right move is: swap the `let` cache
// for a Set-based registry, expose `registerBlocks(items[])` that
// appends + re-freezes, drop Object.freeze (consumers MUST treat the
// return of getBlockCatalog() as immutable but the cache itself
// becomes mutable internally). Two-file change; deferred until a
// concrete plugin model arrives so the API isn't overfit to one
// hypothetical client.
let CATALOG_CACHE: ReadonlyArray<SearchableItem> | null = null

function kebabId(entry: SeedEntry): string {
  // Appends the kebab-cased label so two SEED_ENTRIES that resolve to
  // the same blockType (a preset alongside its base block) still get
  // distinct ids — e.g. 'block:lx_stat:counter' vs 'block:lx_stat:stat'.
  // Stable across renders (label is operator-facing and pinned in
  // SEED_ENTRIES). Today every entry's type is unique, so this is a
  // defensive guard rather than an active disambiguation.
  const labelKey = normalize(entry.label).replace(/\s+/g, '-')
  return `block:${entry.type}:${labelKey}`
}

function buildCatalog(): readonly SearchableItem[] {
  if (CATALOG_CACHE !== null) return CATALOG_CACHE
  // Filter legacy widget types out of the search catalog — operators
  // shouldn't reach them via /slash or ⌘K either. Existing DB rows of
  // legacy types still render; only NEW creation is gated. See
  // blockSeeds.ts LEGACY_BLOCK_TYPES for the migration rationale.
  const seeds: SearchableItem[] = SEED_ENTRIES.filter(isPaletteVisible).map((entry) => ({
    id: kebabId(entry),
    kind: 'seed' as const,
    blockType: entry.type,
    label: entry.label,
    description: entry.description,
    icon: entry.icon,
    aliases: entry.aliases,
    keywords: entry.keywords,
    data: entry.data,
  }))
  // Picture — the MediaPicker round-trip path. Image is the only
  // catalog entry that can't seed directly (the image-block Zod
  // schema requires a positive media_id, so a seed payload can't
  // include it).
  const image: SearchableItem = {
    id: 'media:image',
    kind: 'media',
    label: 'Picture',
    description: 'Pick from the media library or upload a new one.',
    icon: ImageIcon,
    aliases: ['image', 'photo', 'pic', 'img'],
    keywords: ['media', 'upload', 'gallery', 'figure'],
  }
  // Chunk J — section template entry. Selecting this item opens the
  // SectionTemplateGallery modal (palette closes first, gallery takes
  // over). The palette's handleSelect inspects `item.kind === 'template'`
  // and dispatches to the gallery host.
  const templateEntry: SearchableItem = {
    id: 'template:section',
    kind: 'template',
    label: 'Section template',
    description: 'Open the gallery — 8 multi-block starter sections.',
    icon: LayoutTemplate,
    aliases: ['template', 'preset', 'starter'],
    keywords: ['layout', 'pattern', 'block-group', 'gallery'],
  }
  CATALOG_CACHE = Object.freeze([...seeds, image, templateEntry])
  return CATALOG_CACHE
}

/**
 * Public search entry — composed catalog (SEED_ENTRIES + Picture +
 * Templates stub). Stable identity per session; freshly composed if
 * the module is HMR'd.
 */
export function searchBlocks(query: string): SearchHit[] {
  return searchCatalog(query, buildCatalog())
}

/** @internal — exported for tests + Chunk J's incoming template
 *  gallery dispatcher. Today's slash + palette surfaces consume
 *  searchBlocks(); they don't need the full catalog read. */
export function getBlockCatalog(): readonly SearchableItem[] {
  return buildCatalog()
}

/** Test-only — reset the module-scoped cache so tests with mutated
 *  SEED_ENTRIES (rare; we don't mutate today) see a fresh catalog. */
export function _resetCatalogCacheForTests(): void {
  CATALOG_CACHE = null
}
