// Single source of truth for which fields of a widget block are
// inline-editable on the public-page editor surface. Pure value — no
// `server-only` marker so both the server-side render dispatcher
// (BlockTreeRenderer / renderBlock) and the client-side InlineEditable
// component import it without crossing a runtime boundary.
//
// Adding a new inline-editable field:
//   1. Add an entry here (block type → InlineEditableField[]).
//      Each entry can be a top-level scalar, a nested path
//      ('image.alt'), or an array-indexed path ('items[].title').
//   2. Update the matching `components/blocks/<Type>/render.tsx` to
//      accept the `inlineEdit` prop and wrap each editable field in
//      <InlineEditable />. The consumer uses `getFieldValue` /
//      `setFieldValue` / `iteratePathInstances` to read & write the
//      path against the persisted data.
//   3. Confirm the Zod schema in `lib/cms/block-registry.ts` exposes
//      the field at the referenced path.
//
// `richtext` fields are sanitized via DOMPurify on both client (UX
// pre-pass) and server (authority at the write boundary). `text`
// fields carry no HTML — pasted formatting is stripped to text inside
// InlineEditable, the server still validates via Zod's max(...) cap.
// `url` fields validate as href (CTA_HREF_RE on the server). `alt`
// fields are plain text but render via a dedicated affordance (the
// caption / alt editor) rather than the default text overlay.

/** Field affordance type. Drives how InlineEditable surfaces the field
 *  on the canvas:
 *    - 'text'     → plain-text overlay, strip-to-text on paste.
 *    - 'plain'    → back-compat alias of 'text'. The legacy renderer
 *                   call-sites (Heading, Button, Quote, Cta, …) pass
 *                   kind="plain"; the union keeps both literals so
 *                   InlineEditable can treat them identically without
 *                   a coordinated rename across 17 widget renderers.
 *                   New entries in INLINE_EDITABLE_FIELDS use 'text'.
 *    - 'richtext' → DOMPurify allowlist; multi-line, preserves <strong>
 *                   / <em> / <a> / list / paragraph formatting.
 *    - 'url'      → small inline href editor; pre-validated against the
 *                   server's CTA_HREF_RE on commit.
 *    - 'alt'      → alt-text editor; tooltip-style overlay, single
 *                   line, no rich formatting. */
export type InlineEditKind = 'text' | 'plain' | 'richtext' | 'url' | 'alt'

export interface InlineEditableField {
  /** Dotted path with optional `[]` markers for array iteration.
   *  Examples:
   *    'text'           → top-level scalar
   *    'image.alt'      → nested scalar
   *    'items[].title'  → repeat for each item in the items[] array;
   *                       the consumer iterates via iteratePathInstances. */
  path: string
  /** Affordance — drives the InlineEditable activation UX (see above). */
  type: InlineEditKind
  /** Placeholder text shown when the field is empty + activated. */
  placeholder?: string
  /** Soft client-side cap — surface a "shorten this" hint. The server's
   *  Zod schema is the authoritative gate. */
  maxLength?: number
}

/**
 * Block-type → inline-editable fields. Each entry is an ordered array
 * — the operator's natural reading order on the canvas (heading first,
 * subtitle second, body third).
 *
 * Coverage rationale:
 *   - Every text-bearing scalar an operator would click to edit on
 *     the canvas is surfaced here. Alt-text, link labels, captions,
 *     counter labels — all inline.
 *   - URL fields are inline-editable for primary CTAs (the canonical
 *     "the button you click on" surface). Secondary URLs (open-in-new
 *     flag, social profile URLs which need platform-specific format)
 *     stay in the drawer where form validation has more breathing room.
 *   - Array-indexed paths (`items[].field`) iterate per-item — the
 *     consumer (InlineEditable / EditableBlock) iterates the array
 *     and renders one editable overlay per row. See
 *     `iteratePathInstances` below.
 *   - Pure enum / numeric / structural fields (alignment, variant,
 *     size, count) stay drawer-only — typing into the canvas to
 *     change an enum value would be a worse UX than a select.
 */
export const INLINE_EDITABLE_FIELDS: Readonly<
  Record<string, readonly InlineEditableField[]>
> = Object.freeze({
  // ─── Legacy text-bearing widgets ────────────────────────────────
  text: [{ path: 'body_richtext', type: 'richtext', placeholder: 'Write something…' }],
  quote: [
    { path: 'quote', type: 'text', placeholder: 'Quote' },
    { path: 'attribution', type: 'text', placeholder: 'Attribution' },
    { path: 'attribution_title', type: 'text', placeholder: 'Role / title' },
  ],
  cta: [
    { path: 'title', type: 'text', placeholder: 'Headline' },
    { path: 'body', type: 'text', placeholder: 'Supporting copy' },
    { path: 'cta.text', type: 'text', placeholder: 'Button label' },
    { path: 'cta.href', type: 'url', placeholder: '/contact' },
  ],
  heading: [{ path: 'text', type: 'text', placeholder: 'Heading' }],
  button: [
    { path: 'text', type: 'text', placeholder: 'Button label' },
    { path: 'href', type: 'url', placeholder: '/contact' },
  ],
  icon_box: [
    { path: 'headline', type: 'text', placeholder: 'Headline' },
    { path: 'body', type: 'text', placeholder: 'Supporting copy' },
    { path: 'link.href', type: 'url', placeholder: '/services' },
  ],
  // Accordion + Tabs items — array-indexed. Title is plain text, body
  // is rich text. The body_richtext for each item flows through the
  // RICHTEXT_FIELDS sanitizer in parse.ts.
  accordion: [
    { path: 'items[].title', type: 'text', placeholder: 'Item title' },
    { path: 'items[].body_richtext', type: 'richtext', placeholder: 'Item body' },
  ],
  tabs: [
    { path: 'items[].label', type: 'text', placeholder: 'Tab label' },
    { path: 'items[].body_richtext', type: 'richtext', placeholder: 'Tab body' },
  ],
  // IconList items — only the label is inline-editable; the icon
  // picker lives in the drawer (operators don't type icon kebab-names
  // into the canvas).
  icon_list: [{ path: 'items[].label', type: 'text', placeholder: 'List item' }],
  // ─── Chunk G — Elementor-parity rich widgets ────────────────────
  testimonial: [
    { path: 'quote', type: 'text', placeholder: 'Testimonial' },
    { path: 'attribution', type: 'text', placeholder: 'Attribution' },
    { path: 'role', type: 'text', placeholder: 'Role / title' },
  ],
  alert: [
    { path: 'title', type: 'text', placeholder: 'Alert title' },
    { path: 'body_richtext', type: 'richtext', placeholder: 'Alert body' },
  ],
  // Counter / Stats Row items — value is numeric (drawer), but every
  // text-bearing field on each tile edits inline.
  stats_row: [
    { path: 'items[].label', type: 'text', placeholder: 'Label' },
    { path: 'items[].prefix', type: 'text', placeholder: 'Prefix' },
    { path: 'items[].suffix', type: 'text', placeholder: 'Suffix' },
    { path: 'items[].helper_text', type: 'text', placeholder: 'Helper text' },
  ],
  star_rating: [{ path: 'label', type: 'text', placeholder: 'Rating label' }],
  video_embed: [{ path: 'caption', type: 'text', placeholder: 'Caption' }],
  contact_form: [
    { path: 'heading', type: 'text', placeholder: 'Form heading' },
    { path: 'intro', type: 'text', placeholder: 'Intro' },
    { path: 'submit_label', type: 'text', placeholder: 'Send' },
    { path: 'success_headline', type: 'text', placeholder: 'Thanks!' },
    { path: 'success_body', type: 'text', placeholder: 'Confirmation copy' },
  ],
  eyebrow: [{ path: 'text', type: 'text', placeholder: 'Kicker' }],
  channel_card: [
    { path: 'label', type: 'text', placeholder: 'Label' },
    { path: 'body', type: 'text', placeholder: 'Body' },
    { path: 'action.text', type: 'text', placeholder: 'Action label' },
    { path: 'action.href', type: 'url', placeholder: '/contact' },
  ],
  // ─── Image / Gallery — alt text + captions inline ───────────────
  image: [
    { path: 'image.alt', type: 'alt', placeholder: 'Describe this image' },
    { path: 'caption', type: 'text', placeholder: 'Caption' },
  ],
  gallery: [
    { path: 'images[].alt', type: 'alt', placeholder: 'Describe this image' },
    { path: 'images[].caption', type: 'text', placeholder: 'Caption' },
  ],
  // ─── Luxury redesign — lx_* widget primitives ───────────────────
  lx_heading: [{ path: 'text', type: 'text', placeholder: 'Heading' }],
  lx_text: [
    { path: 'body_richtext', type: 'richtext', placeholder: 'Write something…' },
  ],
  lx_eyebrow: [{ path: 'text', type: 'text', placeholder: 'Kicker' }],
  lx_action: [
    { path: 'label', type: 'text', placeholder: 'Button label' },
    { path: 'href', type: 'url', placeholder: '/contact' },
  ],
  lx_figure: [
    { path: 'image.alt', type: 'alt', placeholder: 'Describe this image' },
    { path: 'caption', type: 'text', placeholder: 'Caption' },
  ],
  lx_image_pair: [
    { path: 'leftImage.alt', type: 'alt', placeholder: 'Describe the left image' },
    { path: 'rightImage.alt', type: 'alt', placeholder: 'Describe the right image' },
  ],
  lx_cover_image: [
    { path: 'image.alt', type: 'alt', placeholder: 'Describe this cover image' },
  ],
  lx_map: [{ path: 'caption', type: 'text', placeholder: 'Caption' }],
  // ─── Luxury composites ──────────────────────────────────────────
  lx_channel_card: [
    { path: 'label', type: 'text', placeholder: 'Label' },
    { path: 'value', type: 'text', placeholder: 'Value' },
    { path: 'description', type: 'text', placeholder: 'Description' },
    { path: 'href', type: 'url', placeholder: 'mailto:hello@example.com' },
  ],
  lx_stat: [
    { path: 'label', type: 'text', placeholder: 'Label' },
    { path: 'prefix', type: 'text', placeholder: 'Prefix' },
    { path: 'suffix', type: 'text', placeholder: 'Suffix' },
  ],
  lx_quote: [
    { path: 'quote', type: 'text', placeholder: 'Quote' },
    { path: 'attribution', type: 'text', placeholder: 'Attribution' },
  ],
})

/** Returns the ordered list of inline-editable fields for a block
 *  type, or an empty array when the type has no inline-editable
 *  surfaces. Empty array (rather than null) so callers can
 *  `for (const f of getInlineEditableFields(t))` without a guard. */
export function getInlineEditableFields(
  blockType: string,
): readonly InlineEditableField[] {
  return INLINE_EDITABLE_FIELDS[blockType] ?? []
}

/** Convenience: does this block type have ANY inline-editable field?
 *  Used by EditableBlockTreeRenderer to decide whether to mint an
 *  InlineEditContext for the block. */
export function isInlineEditableBlock(blockType: string): boolean {
  if (!(blockType in INLINE_EDITABLE_FIELDS)) return false
  const fields = INLINE_EDITABLE_FIELDS[blockType]
  return fields !== undefined && fields.length > 0
}

// ─── Path traversal helpers ─────────────────────────────────────────
// Paths are dotted with `[]` markers for arrays:
//   'text'             → ['text']
//   'image.alt'        → ['image', 'alt']
//   'items[].title'    → ['items', '[]', 'title']
//
// Array-indexed paths require an explicit index at call-time
// (consumers iterate via iteratePathInstances). `getFieldValue` /
// `setFieldValue` on an array-indexed path WITHOUT an index throws —
// the consumer would otherwise silently read undefined and assume the
// field is empty.

type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'array' }

function splitPath(path: string): PathSegment[] {
  if (path === '') return []
  const segments: PathSegment[] = []
  for (const part of path.split('.')) {
    if (part === '') continue
    // Each part may itself end with `[]` to denote array iteration —
    // e.g. 'items[]' splits to one 'items' key + one array marker.
    let remainder = part
    let arrayDepth = 0
    while (remainder.endsWith('[]')) {
      arrayDepth += 1
      remainder = remainder.slice(0, -2)
    }
    if (remainder.length > 0) {
      segments.push({ kind: 'key', key: remainder })
    }
    for (let i = 0; i < arrayDepth; i += 1) {
      segments.push({ kind: 'array' })
    }
  }
  return segments
}

/** Read the value at `path` from `data`. For array-indexed paths
 *  ('items[].title'), pass `indices` with one entry per `[]` in path
 *  order. Returns undefined when any segment is missing.
 *
 *  Examples:
 *    getFieldValue({text: 'hi'}, 'text')                       // 'hi'
 *    getFieldValue({image:{alt:'foo'}}, 'image.alt')           // 'foo'
 *    getFieldValue({items:[{t:'a'},{t:'b'}]}, 'items[].t', [1])// 'b' */
export function getFieldValue(
  data: unknown,
  path: string,
  indices: readonly number[] = [],
): unknown {
  const segments = splitPath(path)
  let cursor: unknown = data
  let arrayCursor = 0
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined
    if (seg.kind === 'key') {
      if (typeof cursor !== 'object') return undefined
      cursor = (cursor as Record<string, unknown>)[seg.key]
    } else {
      if (!Array.isArray(cursor)) return undefined
      const idx = indices[arrayCursor]
      arrayCursor += 1
      if (typeof idx !== 'number' || idx < 0 || idx >= cursor.length) {
        return undefined
      }
      cursor = cursor[idx]
    }
  }
  return cursor
}

/** Return a NEW data object with `value` written at `path`. Pure —
 *  the input is not mutated (clones nested containers along the
 *  path). For array-indexed paths, `indices` selects which element
 *  to update. Missing intermediate containers are created (objects
 *  for key segments, arrays for `[]` segments).
 *
 *  Returns the original `data` unchanged when path is malformed or
 *  an array index is out of range — the consumer's commit step
 *  surfaces a 422 from the Zod gate in that case anyway. */
export function setFieldValue(
  data: unknown,
  path: string,
  value: unknown,
  indices: readonly number[] = [],
): unknown {
  const segments = splitPath(path)
  if (segments.length === 0) return data
  const startsObject = segments[0]?.kind === 'key'
  let rootIsValid: boolean
  if (startsObject) {
    rootIsValid = data !== null && typeof data === 'object' && !Array.isArray(data)
  } else {
    rootIsValid = Array.isArray(data)
  }
  // Construct a fresh root only when the existing one is incompatible
  // (e.g. null / primitive); otherwise shallow-clone so unrelated
  // siblings stay reference-identical.
  let root: unknown
  if (rootIsValid) {
    root = startsObject
      ? { ...(data as Record<string, unknown>) }
      : [...(data as unknown[])]
  } else {
    root = startsObject ? {} : []
  }
  let cursor: unknown = root
  let arrayCursor = 0
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!
    const isLast = i === segments.length - 1
    if (seg.kind === 'key') {
      const obj = cursor as Record<string, unknown>
      if (isLast) {
        obj[seg.key] = value
      } else {
        const existing = obj[seg.key]
        const next = segments[i + 1]
        const expectArray = next?.kind === 'array'
        const isCompatible = expectArray
          ? Array.isArray(existing)
          : existing !== null &&
            typeof existing === 'object' &&
            !Array.isArray(existing)
        const cloned: unknown = isCompatible
          ? expectArray
            ? [...(existing as unknown[])]
            : { ...(existing as Record<string, unknown>) }
          : expectArray
            ? []
            : {}
        obj[seg.key] = cloned
        cursor = cloned
      }
    } else {
      // Array segment — `cursor` is already an array (cloned above).
      const arr = cursor as unknown[]
      const idx = indices[arrayCursor]
      arrayCursor += 1
      if (typeof idx !== 'number' || idx < 0 || idx >= arr.length) {
        // Out-of-range index: bail out, return original data. Caller
        // gets a no-op (consistent with the read-path which returns
        // undefined for the same case).
        //
        // Surface a structured warning so the operator-side effect
        // (silent save with no change) leaves a forensic trail —
        // pre-warn, an editor would type, hit save, see "Saved" and
        // their edit would vanish with no signal.
        if (typeof console !== 'undefined') {
          console.warn(
            JSON.stringify({
              level: 'warn',
              msg: 'setFieldValue_index_out_of_range',
              path,
              index: idx,
              arrayLength: arr.length,
            }),
          )
        }
        return data
      }
      if (isLast) {
        arr[idx] = value
      } else {
        const existing = arr[idx]
        const next = segments[i + 1]
        const expectArray = next?.kind === 'array'
        const isCompatible = expectArray
          ? Array.isArray(existing)
          : existing !== null &&
            typeof existing === 'object' &&
            !Array.isArray(existing)
        const cloned: unknown = isCompatible
          ? expectArray
            ? [...(existing as unknown[])]
            : { ...(existing as Record<string, unknown>) }
          : expectArray
            ? []
            : {}
        arr[idx] = cloned
        cursor = cloned
      }
    }
  }
  return root
}

/** For array-indexed paths ('items[].title'), enumerate one instance
 *  per element of the array. Returns the resolved value + the
 *  indices needed to write it back via setFieldValue. Non-array
 *  paths return a single instance with empty indices (so the
 *  consumer can treat them uniformly).
 *
 *  Paths with multiple `[]` markers (rare — e.g. nested item lists)
 *  enumerate the cartesian product in row-major order. */
export interface PathInstance {
  /** Indices for `[]` segments, in path order. */
  indices: number[]
  /** Resolved value at this instance, or undefined when missing. */
  value: unknown
}
export function iteratePathInstances(
  data: unknown,
  path: string,
): PathInstance[] {
  const segments = splitPath(path)
  const arrayPositions: number[] = []
  segments.forEach((seg, i) => {
    if (seg.kind === 'array') arrayPositions.push(i)
  })
  if (arrayPositions.length === 0) {
    return [{ indices: [], value: getFieldValue(data, path) }]
  }
  // Recursive expansion. At each `[]` segment, walk the current array's
  // length and enumerate.
  const out: PathInstance[] = []
  const walk = (
    cursor: unknown,
    segIdx: number,
    chosen: number[],
  ): void => {
    if (cursor === null || cursor === undefined) return
    if (segIdx >= segments.length) {
      out.push({ indices: chosen.slice(), value: cursor })
      return
    }
    const seg = segments[segIdx]!
    if (seg.kind === 'key') {
      if (typeof cursor !== 'object') return
      const next = (cursor as Record<string, unknown>)[seg.key]
      walk(next, segIdx + 1, chosen)
    } else {
      if (!Array.isArray(cursor)) return
      for (let i = 0; i < cursor.length; i += 1) {
        chosen.push(i)
        walk(cursor[i], segIdx + 1, chosen)
        chosen.pop()
      }
    }
  }
  walk(data, 0, [])
  return out
}

/**
 * Carried through `renderBlock` to every inline-editable widget render.
 * Server-side BlockTreeRenderer composes one of these per editable
 * widget; the client-side InlineEditable component reads it back out
 * via props. JSON-serializable shape — no functions, no React nodes —
 * so it crosses the server→client boundary cleanly.
 */
export interface InlineEditContext {
  blockId: number
  blockVersion: number
  pageId: number
  pageVersion: number
}
