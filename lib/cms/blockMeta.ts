// Pure value-layer for section + column + widget meta JSON (migration
// 0011 + Chunk E). No `server-only` import, no DB types. The
// client-side EditDrawer (Chunk C) imports the parsers + class lookups
// from here so it does NOT drag the server-only `lib/cms/hydrate.ts`
// HydratedBlock type transitively through `lib/cms/blockTree.ts`.
//
// Anything that touches section/column/widget SETTINGS (enums,
// defaults, className lookups for live-preview swatches, the EditDrawer
// style tab, the Chunk E spacing toolbar) lives here. The TREE shape
// (TreeNode, buildBlockTree) stays in `lib/cms/blockTree.ts` because
// partition needs HydratedBlock.

import { z } from 'zod'

import {
  SPACING_TIERS,
  isSpacingTier,
  type SpacingTier,
} from './spacingTokens'
import type { SpacingMeta } from './spacingClasses'
import { BLOCK_TONE_ENUMS } from './blockTones'

// Single source of truth for the kind discriminator. The literal
// union appears in API bodies, hydrate types, the renderer partition,
// audit diffs, and the DnD shell — centralising prevents drift if a
// future shape (row, grid) lands and only some sites get updated.
export type BlockKind = 'section' | 'column' | 'widget'

// Section background tokens. Legacy palette ('cream' / 'near-black' /
// 'copper-tint') stays defined so unmigrated pages keep rendering;
// luxury palette ('obsidian' / 'ivory' / 'champagne' / 'bone') is the
// new default for sections built on the luxury system. The legacy
// values are gated out of the operator picker by the luxury-redesign
// migration filter — see editor UI for the active set. The Zod gate
// (SectionMetaSchema) still accepts every value so legacy DB rows
// continue to validate at the write boundary.
export type SectionBackground =
  | 'cream'
  | 'near-black'
  | 'copper-tint'
  | 'obsidian'
  | 'ivory'
  | 'champagne'
  | 'bone'
  | 'charcoal'
// Section padding scale. Legacy tiers ('sm' / 'md' / 'lg') stay defined
// for legacy pages. Luxury system adds 'xl' (160px) and '2xl' (192px)
// using the editorial spacing scale (--spacing-section-xl / -2xl in
// globals.css). Editorial sections breathe — the luxury default for
// new sections is 'lg' or 'xl'; cinematic hero treatments use '2xl'.
export type SectionPadding = 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
export type SectionColumnsCount = 1 | 2 | 3 | 4

// Single source of truth for the section column-count cap. Used by
// the Zod literal union below, the EditableSection toolbar's
// "Add column" guard, the InsertSectionHere shape picker, and the
// renderer's meta.columns clamp. Bumping this requires updating the
// Zod union AND adding a SECTION_COLUMNS_CLASS entry — both live in
// this file so drift is mechanical, not silent.
export const MAX_SECTION_COLUMNS: SectionColumnsCount = 4

// Clamp an arbitrary integer to the valid section columns range.
// Used by the renderer to derive the grid template from the actual
// column-row count (the source of truth post-Chunk-C) — meta.columns
// is now a CREATION HINT only; the live renderer counts children so
// add-column / delete-column gestures don't desync the grid.
//
// Math.round handles floats; the bounds check clamps to [1, MAX].
// The narrow at the bottom is safe because rounded n in {1,2,3,4}
// maps to the literal-union type one-to-one.
export function clampColumnsCount(n: number): SectionColumnsCount {
  const rounded = Math.round(n)
  if (!Number.isFinite(rounded) || rounded <= 1) return 1
  if (rounded >= MAX_SECTION_COLUMNS) return MAX_SECTION_COLUMNS
  return rounded as SectionColumnsCount
}

// Per-device hide flags. Webflow / Elementor parity — operators
// sometimes hide a section/column/widget on a specific viewport (e.g.
// a desktop-only hero ribbon, a mobile-only sticky CTA). The renderer
// composes these into responsive Tailwind `hidden` classes via
// `visibilityClasses()` below. All three fields are independently
// optional — operators set only the surfaces they want to hide.
export interface VisibilityMeta {
  hideOnMobile?: boolean
  hideOnTablet?: boolean
  hideOnDesktop?: boolean
}

// Identity + advanced surface shared across Section/Column/Widget. The
// EditDrawer Advanced tab routes `htmlId` via ADVANCED_KEYS. `label`
// is the operator-set identifier shown in OutlinePanel + EditDrawer
// header (see displayNameFor in EditDrawer.tsx — already reads
// `meta.label`). `htmlId` is the in-page anchor target — surfaced by
// the renderer as `<section id={...}>` etc.
//
// NB: the audit-cited `anchor` field is the same concept as `htmlId`
// (an in-page link target). One canonical key — `htmlId` — covers
// both. EditDrawer.tsx:102 ADVANCED_KEYS already lists both for
// back-compat field-shape lookup; only `htmlId` is persisted to meta.
export interface IdentityMeta {
  htmlId?: string
  label?: string
  visibility?: VisibilityMeta
}

// Optional cover-image background on a section (Elementor parity).
// When set, the renderer paints the image as an absolutely-positioned
// <img> beneath the section's content + an optional overlay layer so
// foreground widgets (heading, text, CTA) compose ON TOP of the photo.
// The `<img>` route (vs CSS background-image) is deliberate — preload-
// discoverable, LCP-friendly for hero sections. Decorative by default;
// if the image carries meaning, an operator should use the lx_figure /
// lx_cover_image widget instead.
export interface SectionBackgroundImage {
  media_id: number
  alt: string
}
export type SectionBackgroundOverlay =
  | 'none'
  | 'darken'
  | 'darken-strong'
  | 'gradient-bottom'
  | 'champagne'
export type SectionMinHeight =
  | 'none'
  | 'sm'
  | 'md'
  | 'lg'
  | 'xl'
  | 'screen'
// Object-fit choice for a section/column background image. Maps 1:1
// to the CSS object-fit values. Default 'cover' — the common hero
// case (fill the frame, crop overflow). 'contain' shows the whole
// image (letterboxed); 'fill' stretches; 'scale-down' picks the
// smaller of contain/none; 'none' is original size.
export type SectionBackgroundFit =
  | 'cover'
  | 'contain'
  | 'fill'
  | 'none'
  | 'scale-down'

export interface SectionMeta extends SpacingMeta, IdentityMeta {
  columns: SectionColumnsCount
  background: SectionBackground
  padding: SectionPadding
  backgroundImage?: SectionBackgroundImage
  backgroundOverlay?: SectionBackgroundOverlay
  backgroundFit?: SectionBackgroundFit
  minHeight?: SectionMinHeight
}

export interface ColumnMeta extends SpacingMeta, IdentityMeta {
  // Optional grid-span override (1..12). When undefined the column
  // takes its share of the section's even split.
  width?: number
  // Optional cover-image background (mirrors SectionMeta).
  // Lets a column carry its own photo backdrop independent of the
  // section — useful for "split hero" layouts (text column +
  // photo column with full bleed inside that column).
  backgroundImage?: SectionBackgroundImage
  backgroundOverlay?: SectionBackgroundOverlay
  backgroundFit?: SectionBackgroundFit
  minHeight?: SectionMinHeight
  // CSS grid self-alignment for the column within its row.
  // 'center' vertically centers a short text column next to a tall image.
  verticalAlign?: 'center' | 'start' | 'end'
}

// Chunk E: widgets gain per-side spacing meta. Pre-Chunk-E widget
// rows had meta = NULL; the column already stored meta as JSON NULL
// per migration 0011, so no schema change is required — the renderer
// + parsers tolerate null and the API gate validates incoming payloads
// against WidgetMetaSchema. Older widget rows continue rendering with
// their natural padding; only widgets the operator has touched carry
// non-null meta. Widgets gain `htmlId` + `visibility` (Webflow parity
// for in-page anchors and per-device hide). Widgets do NOT carry
// `label` — they are identified by their inline content
// (IDENTITY_TEXT_KEYS in EditDrawer.tsx).
export interface WidgetMeta extends SpacingMeta {
  htmlId?: string
  visibility?: VisibilityMeta
}

export const DEFAULT_SECTION_META: SectionMeta = {
  columns: 1,
  background: 'cream',
  padding: 'md',
}

// ─── Theme-aware tone defaults (insert-time auto-adapt) ──────────────
// Single source of truth for the visual brightness of every color
// token referenced by section backgrounds OR widget tones. Adding a
// new token is a one-place edit here — both `isSectionSurfaceDark()`
// (ancestor-section darkness probe) and `lightToneFor()` (dynamic
// per-block light-tone selection) read from this map.
//
// 'neutral' covers tokens that work on both surfaces (champagne /
// gold reads on dark and light; lx_eyebrow's default). 'dark' and
// 'light' carry the dark vs light reading; missing keys are treated
// as `null` (unknown brightness — no substitution).
//
// Keep this aligned with the actual rendered colors in globals.css.
// A CI-grade luminance check (computing WCAG luminance from each hex)
// would derive this automatically; today it's a small static table
// because the palette is small (10 tokens) and the design intent of
// each token is explicit.
export type ColorBrightness = 'dark' | 'light' | 'neutral'
export const COLOR_TOKEN_BRIGHTNESS: Readonly<
  Record<string, ColorBrightness>
> = {
  // Section bg + widget tone (shared namespace)
  obsidian: 'dark',
  'near-black': 'dark',
  charcoal: 'dark',
  ivory: 'light',
  cream: 'light',
  bone: 'light',
  'copper-tint': 'light',
  champagne: 'neutral',
  // Widget-tone-only tokens (not section bgs)
  'warm-stone': 'dark',
}

// Background overlays that darken a section's surface enough that text
// reads against the overlay rather than the bg color underneath. Used
// by `isSectionSurfaceDark()` to override a light bg color when a
// cover photo + dark overlay is in play (cinematic hero pattern —
// cream section, dark photo, foreground text needs to be light).
const DARKENING_OVERLAYS: ReadonlySet<SectionBackgroundOverlay> = new Set([
  'darken',
  'darken-strong',
  'gradient-bottom',
])

interface SurfaceProbeMeta {
  background?: SectionBackground
  backgroundImage?: SectionBackgroundImage
  backgroundOverlay?: SectionBackgroundOverlay
}

/** Probe whether the visible surface of a section reads as dark — used
 *  by the insert pipeline to pick a contrasting tone for new tone-aware
 *  widgets. Returns false when meta is null/undefined (no section
 *  ancestor → page body is cream/light) OR when neither the bg color
 *  nor the cover-photo overlay is dark. */
export function isSectionSurfaceDark(
  meta: SurfaceProbeMeta | null | undefined,
): boolean {
  if (!meta) return false
  // Cover photo with dark overlay wins regardless of underlying bg
  // color — the operator picked a dark hero treatment.
  if (
    meta.backgroundImage &&
    meta.backgroundOverlay &&
    DARKENING_OVERLAYS.has(meta.backgroundOverlay)
  ) {
    return true
  }
  if (!meta.background) return false
  return COLOR_TOKEN_BRIGHTNESS[meta.background] === 'dark'
}

/** Resolve the first 'light' tone in a block's tone enum, or null when
 *  the block has no tone field / no light member. The dynamic resolver
 *  in useInsertBlock calls this when the destination section reads
 *  dark — the returned token becomes the inserted widget's `tone`
 *  value, replacing the schema's dark default.
 *
 *  Returns null for:
 *    - Unknown block types (no entry in BLOCK_TONE_ENUMS)
 *    - Enums whose tokens are all 'dark'/'neutral'/'unknown' (no
 *      light option to substitute) — the resolver leaves the schema
 *      default in place in that case. */
export function lightToneFor(blockType: string): string | null {
  const enumValues = (
    BLOCK_TONE_ENUMS as Readonly<Record<string, readonly string[]>>
  )[blockType]
  if (!enumValues) return null
  for (const token of enumValues) {
    if (COLOR_TOKEN_BRIGHTNESS[token] === 'light') return token
  }
  return null
}

const VALID_BACKGROUNDS: ReadonlySet<SectionBackground> = new Set([
  'cream',
  'near-black',
  'copper-tint',
  'obsidian',
  'ivory',
  'champagne',
  'bone',
  'charcoal',
])
const VALID_PADDINGS: ReadonlySet<SectionPadding> = new Set([
  'none',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
])
const VALID_OVERLAYS: ReadonlySet<SectionBackgroundOverlay> = new Set([
  'none',
  'darken',
  'darken-strong',
  'gradient-bottom',
  'champagne',
])
const VALID_MIN_HEIGHTS: ReadonlySet<SectionMinHeight> = new Set([
  'none',
  'sm',
  'md',
  'lg',
  'xl',
  'screen',
])
const VALID_FITS: ReadonlySet<SectionBackgroundFit> = new Set([
  'cover',
  'contain',
  'fill',
  'none',
  'scale-down',
])
function readSectionBackgroundImage(v: unknown): SectionBackgroundImage | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const id = r['media_id']
  const alt = r['alt']
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    return undefined
  }
  return {
    media_id: id,
    alt: typeof alt === 'string' ? alt.slice(0, 320) : '',
  }
}

// Chunk E: per-side spacing fields are OPTIONAL on every container +
// widget meta. The eight axes (padding × 4 sides + margin × 4 sides)
// each accept either a SpacingTier enum value OR a bounded pixel
// number. Padding is constrained to 0..512 (negative padding is
// invalid CSS — browsers silently clamp to 0); margin is signed
// -512..512 so operators can pull elements up/left to overlap a
// hero, tuck a card under a header, etc. Missing / malformed values
// are dropped silently — operators only see the sides they've set;
// the renderer falls back to the wrapper's natural padding for
// everything else.
const MAX_SPACING_PX = 512
const MIN_MARGIN_PX = -512
function isValidPaddingPx(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_SPACING_PX
}
function isValidMarginPx(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_MARGIN_PX &&
    v <= MAX_SPACING_PX
  )
}
function readPaddingValue(v: unknown): SpacingTier | number | undefined {
  if (isSpacingTier(v)) return v
  if (isValidPaddingPx(v)) return v
  return undefined
}
function readMarginValue(v: unknown): SpacingTier | number | undefined {
  if (isSpacingTier(v)) return v
  if (isValidMarginPx(v)) return v
  return undefined
}
// HTML id / anchor token. Must start with a letter (avoid the
// `id="123"` pitfall — numeric-leading ids break CSS selectors in
// some legacy contexts), then letters/digits/underscore/hyphen.
// Capped at 64 chars to keep the persisted DOM attribute compact.
// Operators editing in the drawer get the same regex from the Zod
// schema below.
const HTML_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
function readHtmlId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  return HTML_ID_RE.test(v) ? v : undefined
}

// Operator-set label. Trimmed; capped at 64 chars. Empty trimmed
// value is treated as unset so an operator who clears the field
// in the drawer doesn't leave a stray "" in meta.
//
// Control characters (U+0000..U+001F, U+007F) are stripped before
// the length cap — operators occasionally paste from rich sources
// (Notion exports, Word documents) that smuggle line separators
// (U+2028/U+2029), bidi-control runs (U+202A..U+202E), or zero-width
// joiners. Newlines in particular break the OutlinePanel single-line
// row layout. Interior runs of whitespace collapse to a single ASCII
// space so a copy-pasted multi-line title doesn't render as a
// tab-padded mess in the drawer header.
//
// Built with the RegExp constructor + \u escape sequences so the
// source file stays free of literal control bytes (which corrupt
// diff tools, copy-paste, and CR/LF line-ending detection).
const LABEL_CONTROL_RE = new RegExp(
  '[\\u0000-\\u001F\\u007F\\u2028\\u2029\\u200B-\\u200D\\uFEFF\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
)
function sanitizeLabel(input: string): string {
  return input
    .replace(LABEL_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
function readLabel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const cleaned = sanitizeLabel(v)
  if (cleaned === '' || cleaned.length > 64) return undefined
  return cleaned
}

// Per-device hide flags. Each axis is a boolean. Anything non-boolean
// (string "true", number 1, etc.) is dropped to keep the persisted
// shape clean. Returns undefined when nothing was set so callers
// don't carry an empty `{}` through every block.
function readVisibilityMeta(v: unknown): VisibilityMeta | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const out: VisibilityMeta = {}
  if (r['hideOnMobile'] === true) out.hideOnMobile = true
  if (r['hideOnTablet'] === true) out.hideOnTablet = true
  if (r['hideOnDesktop'] === true) out.hideOnDesktop = true
  if (
    out.hideOnMobile === undefined &&
    out.hideOnTablet === undefined &&
    out.hideOnDesktop === undefined
  ) {
    return undefined
  }
  return out
}

// Identity for Section + Column — htmlId + label + visibility. Widgets
// reuse the htmlId + visibility halves via readWidgetIdentityMeta.
function readIdentityMeta(r: Record<string, unknown>): IdentityMeta {
  const out: IdentityMeta = {}
  const htmlId = readHtmlId(r['htmlId'])
  if (htmlId !== undefined) out.htmlId = htmlId
  const label = readLabel(r['label'])
  if (label !== undefined) out.label = label
  const visibility = readVisibilityMeta(r['visibility'])
  if (visibility !== undefined) out.visibility = visibility
  return out
}

// Widget identity — no `label` field.
function readWidgetIdentityMeta(r: Record<string, unknown>): {
  htmlId?: string
  visibility?: VisibilityMeta
} {
  const out: { htmlId?: string; visibility?: VisibilityMeta } = {}
  const htmlId = readHtmlId(r['htmlId'])
  if (htmlId !== undefined) out.htmlId = htmlId
  const visibility = readVisibilityMeta(r['visibility'])
  if (visibility !== undefined) out.visibility = visibility
  return out
}

function readSpacingMeta(r: Record<string, unknown>): SpacingMeta {
  const out: SpacingMeta = {}
  const pt = readPaddingValue(r['paddingTop'])
  if (pt !== undefined) out.paddingTop = pt
  const pr = readPaddingValue(r['paddingRight'])
  if (pr !== undefined) out.paddingRight = pr
  const pb = readPaddingValue(r['paddingBottom'])
  if (pb !== undefined) out.paddingBottom = pb
  const pl = readPaddingValue(r['paddingLeft'])
  if (pl !== undefined) out.paddingLeft = pl
  const mt = readMarginValue(r['marginTop'])
  if (mt !== undefined) out.marginTop = mt
  const mr = readMarginValue(r['marginRight'])
  if (mr !== undefined) out.marginRight = mr
  const mb = readMarginValue(r['marginBottom'])
  if (mb !== undefined) out.marginBottom = mb
  const ml = readMarginValue(r['marginLeft'])
  if (ml !== undefined) out.marginLeft = ml
  return out
}

/** Parse + clamp section meta JSON. Unknown / malformed values fall back
 *  to DEFAULT_SECTION_META so the public render is never broken by a
 *  corrupt meta blob. */
export function parseSectionMeta(raw: unknown): SectionMeta {
  if (!raw || typeof raw !== 'object') return DEFAULT_SECTION_META
  const r = raw as Record<string, unknown>
  const cols = r['columns']
  const bg = r['background']
  const pad = r['padding']
  const overlay = r['backgroundOverlay']
  const fit = r['backgroundFit']
  const mh = r['minHeight']
  return {
    columns:
      cols === 1 || cols === 2 || cols === 3 || cols === 4
        ? cols
        : DEFAULT_SECTION_META.columns,
    background:
      typeof bg === 'string' && VALID_BACKGROUNDS.has(bg as SectionBackground)
        ? (bg as SectionBackground)
        : DEFAULT_SECTION_META.background,
    padding:
      typeof pad === 'string' && VALID_PADDINGS.has(pad as SectionPadding)
        ? (pad as SectionPadding)
        : DEFAULT_SECTION_META.padding,
    ...(readSectionBackgroundImage(r['backgroundImage'])
      ? { backgroundImage: readSectionBackgroundImage(r['backgroundImage'])! }
      : {}),
    ...(typeof overlay === 'string' && VALID_OVERLAYS.has(overlay as SectionBackgroundOverlay)
      ? { backgroundOverlay: overlay as SectionBackgroundOverlay }
      : {}),
    ...(typeof fit === 'string' && VALID_FITS.has(fit as SectionBackgroundFit)
      ? { backgroundFit: fit as SectionBackgroundFit }
      : {}),
    ...(typeof mh === 'string' && VALID_MIN_HEIGHTS.has(mh as SectionMinHeight)
      ? { minHeight: mh as SectionMinHeight }
      : {}),
    ...readSpacingMeta(r),
    ...readIdentityMeta(r),
  }
}

/** Parse + clamp column meta JSON. Width must be an integer in [1, 12]. */
export function parseColumnMeta(raw: unknown): ColumnMeta {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: ColumnMeta = {}
  const w = r['width']
  if (typeof w === 'number' && Number.isInteger(w) && w >= 1 && w <= 12) {
    out.width = w
  }
  const bgImg = readSectionBackgroundImage(r['backgroundImage'])
  if (bgImg) out.backgroundImage = bgImg
  const overlay = r['backgroundOverlay']
  if (typeof overlay === 'string' && VALID_OVERLAYS.has(overlay as SectionBackgroundOverlay)) {
    out.backgroundOverlay = overlay as SectionBackgroundOverlay
  }
  const fit = r['backgroundFit']
  if (typeof fit === 'string' && VALID_FITS.has(fit as SectionBackgroundFit)) {
    out.backgroundFit = fit as SectionBackgroundFit
  }
  const mh = r['minHeight']
  if (typeof mh === 'string' && VALID_MIN_HEIGHTS.has(mh as SectionMinHeight)) {
    out.minHeight = mh as SectionMinHeight
  }
  const va = r['verticalAlign']
  if (va === 'center' || va === 'start' || va === 'end') {
    out.verticalAlign = va
  }
  Object.assign(out, readSpacingMeta(r))
  Object.assign(out, readIdentityMeta(r))
  return out
}

/** Parse widget meta JSON. Widgets carry spacing meta + htmlId/visibility
 *  (no columns/background/width/label); a non-object payload returns {}. */
export function parseWidgetMeta(raw: unknown): WidgetMeta {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return {
    ...readSpacingMeta(r),
    ...readWidgetIdentityMeta(r),
  }
}

// ─── Render helpers (consumed by EditableBlockTreeRenderer +
//     BlockTreeRenderer in a follow-up; centralised here so the
//     SectionMeta / ColumnMeta / WidgetMeta types and the helper
//     are co-located).
//
// `visibilityClasses(meta)` returns a Tailwind class string composing
// responsive `hidden` utilities from the meta's visibility flags. Empty
// string when nothing is hidden. Breakpoints follow the project's
// existing Tailwind v4 conventions (sm: ≥640px, lg: ≥1024px):
//   - hideOnMobile  → max-sm:hidden        (hide on <640px)
//   - hideOnTablet  → sm:max-lg:hidden     (hide on 640–1023px)
//   - hideOnDesktop → lg:hidden            (hide on ≥1024px)
// Operators stacking flags get the union (e.g. mobile + desktop hides
// the block except on tablet). All three flags renders nothing —
// the renderer is free to skip the block entirely in that case but
// this helper does not return 'hidden' (defensive: stacking
// max-sm:hidden + sm:max-lg:hidden + lg:hidden is equivalent and
// composes cleanly with the rest of the className).
export function visibilityClasses(
  meta: { visibility?: VisibilityMeta } | null | undefined,
): string {
  const v = meta?.visibility
  if (!v) return ''
  const parts: string[] = []
  if (v.hideOnMobile) parts.push('max-sm:hidden')
  if (v.hideOnTablet) parts.push('sm:max-lg:hidden')
  if (v.hideOnDesktop) parts.push('lg:hidden')
  return parts.join(' ')
}

// `htmlIdForBlock(meta)` returns the operator-set anchor id, or
// undefined when unset / invalid. Consumers spread it onto the
// rendered wrapper as `<section id={htmlIdForBlock(meta)}>` — React
// drops the attribute when the value is undefined, so a missing id
// stays clean (no empty `id=""`).
export function htmlIdForBlock(
  meta: { htmlId?: string } | null | undefined,
): string | undefined {
  return meta?.htmlId
}

// Tailwind class lookups for the section shell. Exported so any
// surface that needs to PREVIEW a section's background/padding/grid
// (the live editor swatches in Chunk C, the OutlinePanel section
// row indicator) reads the SAME table — drift is impossible.

export const SECTION_BACKGROUND_CLASS: Record<SectionBackground, string> = {
  // ─── Legacy palette (kept for unmigrated pages) ─────────────────
  cream: 'bg-cream-50',
  'near-black': 'bg-near-black text-cream-50',
  'copper-tint': 'bg-copper-100/40',
  // ─── Luxury palette ─────────────────────────────────────────────
  // Each token sets the bg + the matching readable foreground so
  // operators don't accidentally create black-on-black sections.
  // bone defaults its foreground to obsidian (it's a soft neutral
  // light surface, not dark). champagne similarly takes obsidian
  // text for legibility on the gold field.
  obsidian: 'bg-obsidian text-ivory',
  ivory: 'bg-ivory text-obsidian',
  champagne: 'bg-champagne text-obsidian',
  bone: 'bg-bone text-obsidian',
  // charcoal: deep off-black (#151719) with white text — operator-
  // selected contrast to the pure obsidian sections.
  charcoal: 'bg-[#151719] text-white',
}

export const SECTION_PADDING_CLASS: Record<SectionPadding, string> = {
  // Zero vertical padding — for hero/cover sections that need to sit
  // flush against the header (no visible gap above the photo). The
  // cover-image widget itself uses w-screen to break out horizontally;
  // 'none' completes the bleed by removing the vertical inset too.
  none: 'py-0',
  // Legacy tiers — Tailwind base scale (kept stable for unmigrated
  // pages). Luxury tiers use the new --spacing-section-* tokens
  // emitted by the luxury @theme block in globals.css.
  sm: 'py-8 sm:py-10',
  md: 'py-16 sm:py-20',
  lg: 'py-24 sm:py-32',
  // Luxury editorial padding — generous, breathes.
  // xl = 160px (24 sm:32 → 32 sm:40 in Tailwind units). 2xl = 192px.
  // Mobile floor is one tier down so phones don't waste screen.
  xl: 'py-section-lg sm:py-section-xl',
  '2xl': 'py-section-xl sm:py-section-2xl',
}

// CSS grid templates per columns-count. Mobile is always single-column;
// the multi-column split kicks in at md (or sm for 4-up so the
// 4-column layout has a sensible mid-breakpoint).
export const SECTION_COLUMNS_CLASS: Record<SectionColumnsCount, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
}

// Human-friendly labels for the EditDrawer style tab (Chunk C).
export const SECTION_BACKGROUND_LABEL: Record<SectionBackground, string> = {
  cream: 'Cream (legacy)',
  'near-black': 'Near black (legacy)',
  'copper-tint': 'Copper tint (legacy)',
  obsidian: 'Obsidian',
  ivory: 'Ivory',
  champagne: 'Champagne',
  bone: 'Bone',
  charcoal: 'Charcoal',
}

export const SECTION_PADDING_LABEL: Record<SectionPadding, string> = {
  none: 'Flush',
  sm: 'Compact',
  md: 'Standard',
  lg: 'Spacious',
  xl: 'Editorial',
  '2xl': 'Cinematic',
}

// NOTE: a previous draft exposed `LUXURY_SECTION_BACKGROUNDS` + an
// `isLuxuryBackground` helper here as a picker-gating mechanism. They
// were never wired into the operator-facing section background picker
// (the picker in ZodForm shows luxury entries first followed by
// "(legacy)"-suffixed legacy entries, which is a clearer UX than
// hiding legacy options entirely — legacy pages still need their
// background editable while they're being migrated). Removed to
// avoid dead-code drift.

// Strict Zod schemas for the API write boundary. parseSectionMeta /
// parseColumnMeta / parseWidgetMeta above are TOLERANT — they clamp
// invalid values so the public render survives a corrupt DB cell. The
// API write path uses these schemas to HARD-REJECT malformed payloads
// (e.g. a probe sending {columns: 99} or extra keys) so corruption
// never enters the database in the first place. `.strict()` rejects
// unknown keys.

// Chunk E: Zod enum for the per-side spacing tiers. Derived from
// SPACING_TIERS so the schema, the parsers, and the editor UI all
// share a single tier list. z.enum requires a literal tuple; the
// `[...SPACING_TIERS]` spread + cast preserves the literal-union
// narrowing while satisfying z.enum's signature.
const SpacingTierEnum = z.enum(
  [...SPACING_TIERS] as [SpacingTier, ...SpacingTier[]],
)

// Each axis accepts either a tier string OR a bounded pixel number.
// Padding is non-negative (0..512) because negative padding is
// invalid CSS — the browser silently clamps to 0 which feels broken.
// Margin is signed (-512..512) so operators can pull elements up/left
// to overlap a hero or tuck a card under a header. ±512 is "more
// than any reasonable layout needs"; rejecting beyond that prevents
// an accidental thousand-pixel margin from breaking the page.
const PaddingValueSchema = z.union([
  SpacingTierEnum,
  z.number().int().min(0).max(512),
])
const MarginValueSchema = z.union([
  SpacingTierEnum,
  z.number().int().min(-512).max(512),
])

// Spacing surface shared by Section, Column, and Widget meta schemas.
// Eight optional axes; an empty payload validates clean. .strict() is
// applied at the consumer schema level so the parent object decides
// what extra keys are allowed.
const SpacingFields = {
  paddingTop: PaddingValueSchema.optional(),
  paddingRight: PaddingValueSchema.optional(),
  paddingBottom: PaddingValueSchema.optional(),
  paddingLeft: PaddingValueSchema.optional(),
  marginTop: MarginValueSchema.optional(),
  marginRight: MarginValueSchema.optional(),
  marginBottom: MarginValueSchema.optional(),
  marginLeft: MarginValueSchema.optional(),
} as const

// Per-device visibility flag schema. `.strict()` rejects unknown keys
// so a probe sending `{hideOnMobile: true, hideOnPhone: true}` (typo)
// gets a 400 instead of silently storing the typo. Empty visibility
// objects validate clean — the renderer just emits no `hidden` classes.
const VisibilitySchema = z
  .object({
    hideOnMobile: z.boolean().optional(),
    hideOnTablet: z.boolean().optional(),
    hideOnDesktop: z.boolean().optional(),
  })
  .strict()
  .optional()

// Identity fields shared between Section + Column meta. Widgets get a
// narrower set (no `label` — widgets are identified by their inline
// content, see IDENTITY_TEXT_KEYS in EditDrawer.tsx).
//
// `htmlId` regex mirrors readHtmlId above: letter-leading, 1..64 ASCII
// chars (letters / digits / underscore / hyphen). The DOM accepts more
// (any non-whitespace), but we restrict to the safe CSS-selector subset
// so operators can paste the id into a `#anchor` link without
// escaping.
//
// `label` is trimmed at the parser layer; the schema caps length at
// 64 to keep audit_log entries readable. .min(1) on the schema would
// reject the canonical "clear the field" gesture (operators send "")
// — instead, allow empty strings here and let readLabel drop them
// from the persisted shape.
// Reserved DOM-id allowlist. Operators picking 'header' / 'footer' /
// 'main' / 'nav' / 'aside' / 'page' / 'app' / 'root' would shadow
// site-level anchors that the layout already emits (the global header
// uses id="header", the page wrapper id="page", etc.) — `<a href="#header">`
// from a section anchor would jump to the chrome instead of the
// operator's intended block. Case-insensitive comparison because DOM
// id matching for fragment navigation is case-sensitive in HTML5 but
// the rejection covers the obvious operator-paste cases regardless of
// keystroke.
const RESERVED_HTML_IDS: ReadonlySet<string> = new Set([
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'page',
  'app',
  'root',
])
const HtmlIdSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'invalid_html_id')
  .max(64)
  .refine(
    (s) => !RESERVED_HTML_IDS.has(s.toLowerCase()),
    'id is reserved — choose another',
  )
  .optional()
// Label is sanitized at parse-time (readLabel above strips control
// characters + collapses interior whitespace). At the Zod write
// boundary we apply the SAME sanitisation via .transform so a probe
// that bypasses the drawer (direct API hit) gets the same clean shape.
// The .transform output is the cleaned string; downstream code reads
// label as a plain max-64 string with no embedded control bytes.
//
// The transform runs FIRST so the max-64 check applies to the cleaned
// length (matches readLabel's parser-side semantics — first sanitize,
// then enforce length). Pre-transform max(64) would reject a 70-char
// raw input that sanitizes to ≤64; post-transform max(64) matches
// readLabel exactly.
const LabelSchema = z
  .string()
  .transform(sanitizeLabel)
  .pipe(z.string().max(64))
  .optional()

const IdentityFields = {
  htmlId: HtmlIdSchema,
  label: LabelSchema,
  visibility: VisibilitySchema,
} as const

// Widget identity: no `label`.
const WidgetIdentityFields = {
  htmlId: HtmlIdSchema,
  visibility: VisibilitySchema,
} as const

// Section meta REQUIRES the three core fields (columns/background/
// padding). All editor surfaces (EditDrawer's section form,
// SpacingToolbar's buildNextMeta) always send the full triple. A
// probe-style PATCH with `meta: {}` would otherwise wipe those
// fields — the renderer would fall back to defaults but the
// persisted row + audit_log entry would record `after: {}`, which
// is forensically meaningless. Per-side spacing fields stay
// optional (operators set them à-la-carte).
export const SectionMetaSchema = z
  .object({
    columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    // Both legacy + luxury palette accepted. The picker UI gates new
    // creation to the luxury palette via SECTION_BACKGROUND_LABEL
    // ordering; the write boundary stays permissive so legacy DB rows
    // pass validation when re-saved during a property change unrelated
    // to background.
    //
    // SCHEMA DRIFT FIX (code-quality audit C-1): runtime `SectionBackground`
    // union + `VALID_BACKGROUNDS` set + `SECTION_BACKGROUND_CLASS` +
    // `SECTION_BACKGROUND_LABEL` all include 'charcoal', but this Zod
    // enum used to omit it — operators picking "Charcoal" in the
    // EditDrawer got a 400 invalid_request even though every renderer
    // accepted the value. The enum is now authoritative and matches
    // `VALID_BACKGROUNDS` exactly.
    background: z.enum([
      'cream',
      'near-black',
      'copper-tint',
      'obsidian',
      'ivory',
      'champagne',
      'bone',
      'charcoal',
    ]),
    padding: z.enum(['none', 'sm', 'md', 'lg', 'xl', '2xl']),
    // Optional cover-image background. media_id is the row in `media`,
    // alt is the screen-reader description (empty string allowed for
    // purely decorative backgrounds). The renderer paints this image
    // beneath the section's content so widgets compose on top.
    backgroundImage: z
      .object({
        media_id: z.number().int().positive(),
        alt: z.string().max(320),
      })
      .optional(),
    backgroundOverlay: z
      .enum(['none', 'darken', 'darken-strong', 'gradient-bottom', 'champagne'])
      .optional(),
    backgroundFit: z
      .enum(['cover', 'contain', 'fill', 'none', 'scale-down'])
      .optional(),
    minHeight: z
      .enum(['none', 'sm', 'md', 'lg', 'xl', 'screen'])
      .optional(),
    ...SpacingFields,
    ...IdentityFields,
  })
  .strict()

export const ColumnMetaSchema = z
  .object({
    width: z.number().int().min(1).max(12).optional(),
    // Mirrors the section-level cover-image fields so a column can
    // also carry its own background photo. Same write-boundary
    // guarantees: media_id positive int, alt ≤ 320 chars.
    backgroundImage: z
      .object({
        media_id: z.number().int().positive(),
        alt: z.string().max(320),
      })
      .optional(),
    backgroundOverlay: z
      .enum(['none', 'darken', 'darken-strong', 'gradient-bottom', 'champagne'])
      .optional(),
    backgroundFit: z
      .enum(['cover', 'contain', 'fill', 'none', 'scale-down'])
      .optional(),
    minHeight: z
      .enum(['none', 'sm', 'md', 'lg', 'xl', 'screen'])
      .optional(),
    ...SpacingFields,
    ...IdentityFields,
  })
  .strict()

// Widget meta: spacing + identity (htmlId + visibility, no label).
// Same .strict() gate so a probe sending an unknown key (e.g. an
// attempt to slip data fields through the meta path) is rejected at
// 400 instead of silently stored.
export const WidgetMetaSchema = z
  .object({ ...SpacingFields, ...WidgetIdentityFields })
  .strict()
