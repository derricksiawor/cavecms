// Shared, framework-agnostic helpers for the content extractors. Like the
// rest of analysis/*, NOTHING here may import `server-only`, node built-ins,
// or DOM globals — the extractors run BOTH in the browser (live editor
// scoring) and on the server (bulk scoring). The markdown + blocks extractors
// are fully isomorphic; the DOM extractor guards its single DOM access behind
// a `typeof` check.

import type { ContentNode, LinkNode, ImageNode } from '../types'

/** The common return shape every extractor produces — exactly the three
 *  body-content fields `AnalysisInput` needs (the editor supplies the rest:
 *  title, metaDescription, slug, keyphrase, …). */
export interface ExtractedContent {
  blocks: ContentNode[]
  links: LinkNode[]
  images: ImageNode[]
}

/** An empty result — returned for empty input so callers never special-case. */
export function emptyExtracted(): ExtractedContent {
  return { blocks: [], links: [], images: [] }
}

/**
 * Decide whether a link is INTERNAL (same-site) per the `AnalysisInput`
 * contract: a link is internal when it is RELATIVE (no scheme + no
 * protocol-relative host) OR when its absolute host equals `siteHost`.
 *
 * Rules (kept deliberately simple + dependency-free so this is identical on
 * client + server — `URL` is available in both, but we avoid throwing on the
 * many non-URL href shapes an operator can author):
 *   - ''                         → internal (in-page / empty anchor)
 *   - '#section', '?q=1'         → internal (same document)
 *   - '/about', 'about', './x'   → internal (relative path)
 *   - 'mailto:', 'tel:', 'sms:'  → NOT internal (no site host to compare)
 *   - 'javascript:', 'data:'     → NOT internal
 *   - '//cdn.example.com/x'      → host = cdn.example.com → compare to siteHost
 *   - 'https://host/x'           → host = host → compare to siteHost
 *
 * Host comparison is case-insensitive and ignores a leading 'www.' on BOTH
 * sides so 'https://www.site.com' matches siteHost 'site.com'.
 */
export function isInternalHref(href: string, siteHost?: string): boolean {
  const raw = href.trim()
  // Empty or pure fragment / query → same document, always internal.
  if (raw === '' || raw.startsWith('#') || raw.startsWith('?')) return true

  // Protocol-relative ('//host/path') — has a host but inherits the scheme.
  if (raw.startsWith('//')) {
    const host = hostOf(`https:${raw}`)
    return host ? sameHost(host, siteHost) : false
  }

  // Scheme-bearing absolute URL? Detect a leading "scheme:" token. Anything
  // matching is treated as absolute; non-http(s) schemes (mailto/tel/…) carry
  // no comparable host, so they are external.
  const scheme = leadingScheme(raw)
  if (scheme) {
    if (scheme === 'http' || scheme === 'https') {
      const host = hostOf(raw)
      return host ? sameHost(host, siteHost) : false
    }
    // mailto:, tel:, sms:, javascript:, data:, etc. — no site host → external.
    return false
  }

  // No scheme, not protocol-relative, not a fragment/query → relative path
  // ('/about', 'about', '../x', 'about.html') → internal.
  return true
}

/** Lowercased URL scheme if `raw` begins with one ("https://x" → "https",
 *  "mailto:a@b" → "mailto"), else null. A scheme is [a-z][a-z0-9+.-]* followed
 *  by ':'. The leading char must be a letter (so "3.14" / "/a:b" aren't
 *  schemes, and a Windows-y "c:/x" path-with-letter is the one false positive
 *  we accept — operators don't author those in web hrefs). */
function leadingScheme(raw: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)
  return m ? m[1]!.toLowerCase() : null
}

/** Parse the host from an absolute URL string, or null when it won't parse.
 *  `URL` exists in every modern runtime (node ≥10, all browsers) so this is
 *  isomorphic. */
function hostOf(absolute: string): string | null {
  try {
    return new URL(absolute).host || null
  } catch {
    return null
  }
}

/** Case-insensitive host equality, ignoring a leading 'www.' on either side.
 *  When `siteHost` is undefined we have nothing to compare against, so an
 *  absolute external-looking host is treated as EXTERNAL (false). */
function sameHost(host: string, siteHost?: string): boolean {
  if (!siteHost) return false
  return normalizeHost(host) === normalizeHost(siteHost)
}

function normalizeHost(h: string): string {
  const lower = h.trim().toLowerCase()
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

/** Push a paragraph node only when it has visible text (after trim). Keeps
 *  every extractor from emitting empty paragraphs that would skew word counts
 *  and the intro-paragraph check. */
export function pushParagraph(out: ContentNode[], text: string): void {
  const t = collapseWs(text)
  if (t) out.push({ kind: 'paragraph', text: t })
}

/** Push a heading node (clamping level into 1–6) only when it has text. */
export function pushHeading(out: ContentNode[], level: number, text: string): void {
  const t = collapseWs(text)
  if (!t) return
  const lvl = Math.min(6, Math.max(1, Math.round(level) || 1))
  out.push({ kind: 'heading', level: lvl, text: t })
}

/** Push a list-item node only when it has text. */
export function pushListItem(out: ContentNode[], text: string): void {
  const t = collapseWs(text)
  if (t) out.push({ kind: 'listitem', text: t })
}

/** Collapse all internal whitespace runs to single spaces and trim. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Build a LinkNode, resolving `internal` from the href + siteHost.
 * `rel` is lowercased + trimmed when present, dropped when blank.
 */
export function makeLink(
  href: string,
  text: string,
  siteHost?: string,
  rel?: string | null,
): LinkNode {
  const node: LinkNode = {
    href,
    text: collapseWs(text),
    internal: isInternalHref(href, siteHost),
  }
  const r = (rel ?? '').trim().toLowerCase()
  if (r) node.rel = r
  return node
}

/** Build an ImageNode; alt defaults to '' (the contract requires the key,
 *  and the seo "image alt" check treats '' as "missing alt"). */
export function makeImage(src: string, alt?: string | null): ImageNode {
  return { src, alt: (alt ?? '').trim() }
}

// ─── Minimal isomorphic HTML helpers (for the blocks extractor's rich-text) ──
// content_blocks rich-text fields (body_richtext, quote, …) store sanitized
// HTML — a SMALL allow-list (p, br, strong, em, a, ul, ol, li, blockquote,
// code, pre, h2–h4, img, hr). We need prose text + anchor links + images out
// of that HTML WITHOUT a DOM (this runs on the server during bulk scoring and
// in the browser, but we never want to depend on `document`). A tiny tag-aware
// scanner is enough for this constrained, already-sanitized subset; it is NOT
// a general HTML parser and is never fed untrusted markup (the sanitizer ran
// first at the write boundary).

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
}

/** Decode the handful of HTML entities the sanitizer emits, plus numeric
 *  (&#160; / &#xA0;) forms. Unknown entities pass through verbatim. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return whole
        }
      }
      return whole
    }
    const mapped = NAMED_ENTITIES[body.toLowerCase()]
    return mapped !== undefined ? mapped : whole
  })
}

// Block-level / line-breaking tags whose boundary should become whitespace
// when flattening to plain text (so "<p>a</p><p>b</p>" → "a b", not "ab").
// Inline tags (a, strong, em, code, span, …) must NOT inject a space, so
// "<a>a link</a>." flattens to "a link." not "a link ." (the boundary between
// the anchor text and the trailing period has no space).
const BLOCK_BREAK_TAG_RE =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|blockquote|pre|tr|td|th|section|article|header|footer|figure|figcaption)\b[^>]*>/gi

/** Strip every HTML tag and decode entities → plain text, whitespace-collapsed.
 *  Block-level tag boundaries become spaces; inline tag boundaries vanish so
 *  punctuation hugging an inline element stays attached. Used where we only
 *  need the prose of a rich-text field (e.g. quote text). */
export function htmlToPlainText(html: string): string {
  const spaced = html.replace(BLOCK_BREAK_TAG_RE, ' ')
  const stripped = spaced.replace(/<[^>]*>/g, '')
  return collapseWs(decodeEntities(stripped))
}

/** Extract `<a href>` anchors from a rich-text HTML string as LinkNodes.
 *  Reads the href + rel attributes and the anchor's inner text (tags stripped).
 *  Malformed / href-less anchors are skipped. */
export function extractAnchorsFromHtml(
  html: string,
  siteHost?: string,
): LinkNode[] {
  const links: LinkNode[] = []
  // Match <a ...>...</a>. The sanitizer forbids nested anchors, so a
  // non-greedy inner capture is safe for this constrained input.
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  for (const m of html.matchAll(anchorRe)) {
    const attrs = m[1] ?? ''
    const inner = m[2] ?? ''
    const href = attrValue(attrs, 'href')
    if (href === null) continue
    const rel = attrValue(attrs, 'rel')
    links.push(makeLink(decodeEntities(href), htmlToPlainText(inner), siteHost, rel))
  }
  return links
}

/** Extract `<img>` images from a rich-text HTML string as ImageNodes. */
export function extractImagesFromHtml(html: string): ImageNode[] {
  const images: ImageNode[] = []
  const imgRe = /<img\b([^>]*)\/?>/gi
  for (const m of html.matchAll(imgRe)) {
    const attrs = m[1] ?? ''
    const src = attrValue(attrs, 'src')
    if (src === null) continue
    const alt = attrValue(attrs, 'alt')
    images.push(makeImage(decodeEntities(src), alt === null ? '' : decodeEntities(alt)))
  }
  return images
}

/** Read a single attribute value from a tag's attribute string. Handles
 *  double-quoted, single-quoted, and unquoted forms. Returns '' for a valueless
 *  boolean attribute, and null when the attribute is absent. */
function attrValue(attrs: string, name: string): string | null {
  // name = "value" | name = 'value' | name = value | name (boolean)
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*(?:=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`,
    'i',
  )
  const m = re.exec(attrs)
  if (!m) return null
  if (m[1] !== undefined) return m[1]
  if (m[2] !== undefined) return m[2]
  if (m[3] !== undefined) return m[3]
  return '' // present but no value (boolean attribute)
}

/**
 * Split a rich-text HTML string (lx_text body_richtext) into ordered
 * ContentNode prose: each <p>, <li>, <blockquote>, and <h2>–<h4> becomes its
 * own node; loose text outside any block tag becomes a trailing paragraph.
 * <pre>/<code> blocks are EXCLUDED from prose (code is not readable prose and
 * would skew word/sentence stats — mirrors how the markdown extractor drops
 * fenced code). Anchors + images are handled separately (extractAnchorsFromHtml
 * / extractImagesFromHtml); here we only care about text structure.
 */
export function htmlToContentNodes(html: string): ContentNode[] {
  const out: ContentNode[] = []
  // Drop <pre>…</pre> (fenced/code) entirely before splitting prose.
  const noPre = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, ' ')

  // Pull out block-level prose elements in document order.
  const blockRe =
    /<(p|li|blockquote|h2|h3|h4|h5|h6)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let lastIndex = 0
  let consumedAny = false
  for (const m of noPre.matchAll(blockRe)) {
    consumedAny = true
    const tag = (m[1] ?? '').toLowerCase()
    const text = htmlToPlainText(stripInlineCode(m[2] ?? ''))
    if (tag === 'li') {
      pushListItem(out, text)
    } else if (tag[0] === 'h') {
      pushHeading(out, Number(tag.slice(1)), text)
    } else {
      // p, blockquote
      pushParagraph(out, text)
    }
    lastIndex = (m.index ?? 0) + m[0].length
  }

  // If NO block element matched, the field may be loose inline HTML
  // ("just <strong>bold</strong> text") — treat the whole thing as one
  // paragraph. If blocks DID match, any trailing loose text after the last
  // block becomes a final paragraph.
  if (!consumedAny) {
    pushParagraph(out, htmlToPlainText(stripInlineCode(noPre)))
  } else {
    const tail = htmlToPlainText(stripInlineCode(noPre.slice(lastIndex)))
    if (tail) pushParagraph(out, tail)
  }
  return out
}

/** Replace inline <code>…</code> spans with their text content (inline code is
 *  part of the surrounding sentence, unlike block <pre>). */
function stripInlineCode(html: string): string {
  return html.replace(/<\/?code\b[^>]*>/gi, '')
}
