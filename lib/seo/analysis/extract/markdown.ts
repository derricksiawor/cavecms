// Markdown → AnalysisInput body extractor. For the BLOG / POST editor, whose
// content is the post's `body_md` source markdown. We parse the SOURCE
// markdown (not the rendered HTML) so the extractor stays pure + isomorphic
// (no remark/unified, which is server-only in this project via
// lib/cms/markdown.ts) and so it works live in the editor as the operator
// types, before any server render.
//
// DIALECT: matched to the project's render pipeline (lib/cms/markdown.ts),
// which is `remark-parse` + `remark-gfm`. The GFM features that affect prose /
// link / image extraction are:
//   - ATX headings  (#..###### → level 1..6)   [CommonMark]
//   - paragraphs                                [CommonMark]
//   - bullet lists  (-, *, +)                   [CommonMark]
//   - ordered lists (1. , 1) )                  [CommonMark]
//   - inline links  [text](url)  + autolinks    [CommonMark + GFM autolink]
//   - inline images ![alt](src)                 [CommonMark]
//   - fenced / indented code blocks (EXCLUDED from prose) [CommonMark]
//   - blockquotes (> ) — unwrapped to prose      [CommonMark]
// GFM tables + task-lists are parsed by remark-gfm but STRIPPED by the
// render sanitizer (lib/cms/markdown.ts SCHEMA has no <table>), so they never
// reach the public page. We mirror that: a task-list item `- [ ] do x` is
// treated as a normal list item with the checkbox marker removed; table
// pipe-rows are treated as ordinary paragraph text (best-effort — they don't
// render, so their SEO weight is incidental).
//
// This is a deliberately lightweight, line-oriented parser. It is NOT a full
// CommonMark implementation (no setext headings, no nested-list depth model, no
// reference-link definitions) — it reliably handles the constructs the SEO
// engine cares about: headings, paragraphs, list items, links (internal vs
// external), and images (with / without alt).

import type { ContentNode, LinkNode, ImageNode } from '../types'
import {
  type ExtractedContent,
  emptyExtracted,
  makeLink,
  makeImage,
  pushParagraph,
  pushHeading,
  pushListItem,
} from './shared'

const ATX_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/
const BULLET_ITEM_RE = /^(\s*)[-*+]\s+(.*)$/
const ORDERED_ITEM_RE = /^(\s*)\d{1,9}[.)]\s+(.*)$/
const BLOCKQUOTE_RE = /^\s{0,3}>\s?(.*)$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/
const TASK_CHECKBOX_RE = /^\[[ xX]\]\s+/

/**
 * Extract `{blocks, links, images}` from a markdown source string.
 *
 * @param md       The post's `body_md` source.
 * @param siteHost Optional canonical site host. A link is `internal` when it is
 *                 relative OR its host === siteHost (see isInternalHref). When
 *                 omitted, only relative links count as internal.
 */
export function extractFromMarkdown(md: string, siteHost?: string): ExtractedContent {
  if (!md || !md.trim()) return emptyExtracted()

  const blocks: ContentNode[] = []
  const links: LinkNode[] = []
  const images: ImageNode[] = []

  // Normalise line endings; split into lines for a single forward pass.
  const lines = md.replace(/\r\n?/g, '\n').split('\n')

  let paragraphBuf: string[] = []

  const flushParagraph = () => {
    if (paragraphBuf.length === 0) return
    const joined = paragraphBuf.join(' ')
    // Inline links/images inside this paragraph are harvested into links/images
    // regardless; the prose node carries the link TEXT (markdown stripped).
    harvestInline(joined, links, images, siteHost)
    pushParagraph(blocks, stripInlineMarkdown(joined))
    paragraphBuf = []
  }

  let inFence = false
  let fenceMarker = ''

  for (const rawLine of lines) {
    const line = rawLine

    // ── Fenced code block: everything between matching fences is code, NOT
    // prose. We skip the content for prose AND for link/image harvesting (code
    // samples routinely contain []() that aren't markdown links). ──
    const fence = FENCE_RE.exec(line)
    if (inFence) {
      if (fence && line.trim().startsWith(fenceMarker)) {
        inFence = false
        fenceMarker = ''
      }
      continue // drop the fenced line entirely
    }
    if (fence) {
      flushParagraph()
      inFence = true
      fenceMarker = fence[1]![0]!.repeat(3) // ``` or ~~~ prefix to match close
      continue
    }

    // ── Indented code block (4+ leading spaces / a tab) — only when NOT
    // continuing a paragraph (a wrapped paragraph line can be indented). We
    // treat a blank-separated indented run as code and skip it. ──
    if (/^( {4}|\t)/.test(line) && paragraphBuf.length === 0) {
      continue
    }

    // ── Blank line: paragraph boundary. ──
    if (line.trim() === '') {
      flushParagraph()
      continue
    }

    // ── ATX heading. ──
    const heading = ATX_HEADING_RE.exec(line)
    if (heading) {
      flushParagraph()
      const level = heading[1]!.length
      const text = heading[2] ?? ''
      harvestInline(text, links, images, siteHost)
      pushHeading(blocks, level, stripInlineMarkdown(text))
      continue
    }

    // ── List item (bullet or ordered). ──
    const bullet = BULLET_ITEM_RE.exec(line)
    const ordered = bullet ? null : ORDERED_ITEM_RE.exec(line)
    const item = bullet ?? ordered
    if (item) {
      flushParagraph()
      let text = item[2] ?? ''
      // GFM task-list checkbox marker — strip "[ ] " / "[x] ".
      text = text.replace(TASK_CHECKBOX_RE, '')
      harvestInline(text, links, images, siteHost)
      pushListItem(blocks, stripInlineMarkdown(text))
      continue
    }

    // ── Blockquote: unwrap the '>' and treat the inner text as prose. We feed
    // it into the paragraph buffer so a multi-line quote coalesces. ──
    const quote = BLOCKQUOTE_RE.exec(line)
    if (quote) {
      paragraphBuf.push(quote[1] ?? '')
      continue
    }

    // ── Thematic break (---, ***, ___) — no prose content. ──
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      continue
    }

    // ── Otherwise: ordinary paragraph text (accumulate; soft-wrapped lines
    // join with a space). ──
    paragraphBuf.push(line.trim())
  }

  flushParagraph()

  return { blocks, links, images }
}

// ─── Inline harvesting ──────────────────────────────────────────────────────

const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const LINK_RE = /\[([^\]]+)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const AUTOLINK_RE = /<((?:https?:\/\/|mailto:)[^>\s]+)>/g

/**
 * Pull inline images + links out of a markdown fragment and append LinkNodes /
 * ImageNodes. The order matters: images first (so an image's `![...]` isn't
 * mis-read as a link's `[...]`), then links, then bare autolinks.
 */
function harvestInline(
  fragment: string,
  links: LinkNode[],
  images: ImageNode[],
  siteHost?: string,
): void {
  // Images.
  for (const m of fragment.matchAll(IMAGE_RE)) {
    const alt = m[1] ?? ''
    const src = unwrapAngle(m[2] ?? '')
    if (src) images.push(makeImage(src, alt))
  }

  // Links — but skip any '[' that is actually the start of an image '!['.
  for (const m of fragment.matchAll(LINK_RE)) {
    const at = m.index ?? 0
    if (at > 0 && fragment[at - 1] === '!') continue // it's an image, already taken
    const text = m[1] ?? ''
    const href = unwrapAngle(m[2] ?? '')
    if (href) links.push(makeLink(href, stripInlineMarkdown(text), siteHost))
  }

  // GFM/CommonMark autolinks: <https://x> and <mailto:a@b>.
  for (const m of fragment.matchAll(AUTOLINK_RE)) {
    const href = m[1] ?? ''
    if (href) links.push(makeLink(href, href, siteHost))
  }
}

/** Strip a CommonMark angle-bracket-wrapped destination `<url>` → `url`. */
function unwrapAngle(dest: string): string {
  const d = dest.trim()
  if (d.startsWith('<') && d.endsWith('>')) return d.slice(1, -1).trim()
  return d
}

/**
 * Reduce inline markdown to its visible PROSE text for a ContentNode's `text`
 * field:
 *   - images  ![alt](src)        → ''    (alt is the img attribute, NOT visible
 *                                          prose; CommonMark renders it inside
 *                                          <img alt>, so it adds no readable
 *                                          words — the image is captured in
 *                                          `images` separately)
 *   - links   [text](url)        → text
 *   - autolinks <https://x>      → x
 *   - emphasis **b** *i* _i_ `c` → unwrapped
 * This keeps word counts + keyphrase matching aligned with what a reader sees,
 * NOT the raw markup. (The links/images themselves are captured separately.)
 */
function stripInlineMarkdown(s: string): string {
  let out = s
  // Images contribute no visible prose text (alt lives on the <img> element).
  out = out.replace(IMAGE_RE, () => '')
  // Links → link text.
  out = out.replace(LINK_RE, (_m, text: string) => text ?? '')
  // Autolinks → bare URL/mail.
  out = out.replace(AUTOLINK_RE, (_m, url: string) => url ?? '')
  // Inline code `code` → code.
  out = out.replace(/`+([^`]*)`+/g, (_m, code: string) => code ?? '')
  // Bold / italic / strikethrough markers.
  out = out.replace(/(\*\*|__)(.*?)\1/g, (_m, _w, inner: string) => inner ?? '')
  out = out.replace(/(\*|_)(.*?)\1/g, (_m, _w, inner: string) => inner ?? '')
  out = out.replace(/~~(.*?)~~/g, (_m, inner: string) => inner ?? '')
  return out
}
