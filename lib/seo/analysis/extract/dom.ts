// Rendered-DOM → AnalysisInput body extractor. The UNIVERSAL FALLBACK: given a
// rendered preview element (e.g. the live editor's preview iframe body, or any
// server-rendered page fragment), walk it in document order and emit the same
// `{blocks, links, images}` shape the markdown + blocks extractors produce.
//
// This is the ONLY extractor that touches the DOM. The analysis layer is
// otherwise strictly isomorphic, so this module is BROWSER-ONLY: every DOM
// access is guarded so importing it on the server is harmless (the guard
// returns an empty result rather than throwing on a missing `Node`). Callers on
// the server use the markdown / blocks extractors instead; this one is reached
// only in a browser preview context where a real `HTMLElement` exists.
//
// Walk rules:
//   - h1..h6           → heading node (level from tag)
//   - p                → paragraph node
//   - li               → listitem node
//   - blockquote       → paragraph node (its text)
//   - a[href]          → link node (internal by relative/host; rel from attr)
//   - img              → image node (alt)
//   - script,style,nav,aside,template,noscript,head → SKIPPED (chrome / non-prose)
//
// To avoid double-counting, a node's text is emitted by the NEAREST enclosing
// block element: once we record a <p>/<li>/<h2>/blockquote, we do NOT also
// descend into it to emit child paragraphs (its inner text is already captured).
// Links + images inside a recorded block ARE still harvested (they're separate
// concerns from prose text).

import type { ContentNode, LinkNode, ImageNode } from '../types'
import {
  type ExtractedContent,
  emptyExtracted,
  makeLink,
  makeImage,
  pushParagraph,
  pushHeading,
  pushListItem,
  collapseWs,
} from './shared'

// Tags whose subtree is chrome / non-prose and must be skipped entirely.
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NAV',
  'ASIDE',
  'TEMPLATE',
  'NOSCRIPT',
  'HEAD',
  'SVG',
])

const HEADING_TAGS: Record<string, number> = {
  H1: 1,
  H2: 2,
  H3: 3,
  H4: 4,
  H5: 5,
  H6: 6,
}

// Block-level prose tags whose TEXT is recorded as one node (and not re-walked
// for nested prose). list items + headings + paragraphs + blockquotes.
const PROSE_BLOCK_TAGS = new Set([
  'P',
  'LI',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
])

/**
 * Extract `{blocks, links, images}` from a rendered DOM element.
 *
 * @param el       Root element to walk (its descendants in document order).
 * @param siteHost Canonical host for internal/external link classification.
 *                 When omitted, only relative hrefs are internal — and when the
 *                 element lives in a real document, `a.href` resolves to an
 *                 absolute URL, so pass siteHost (e.g. `location.host`) to get
 *                 correct same-site classification in that case.
 */
export function extractFromDom(el: unknown, siteHost?: string): ExtractedContent {
  // Browser-only guard: no DOM (server bundle / non-browser) → empty result.
  if (typeof globalThis === 'undefined') return emptyExtracted()
  if (!isElementLike(el)) return emptyExtracted()

  const blocks: ContentNode[] = []
  const links: LinkNode[] = []
  const images: ImageNode[] = []

  walk(el, blocks, links, images, siteHost, false)

  return { blocks, links, images }
}

/**
 * Recursive document-order walk.
 *
 * @param insideProseBlock true when an ancestor is already a recorded prose
 *        block — suppresses recording nested prose text twice, but links/images
 *        are still harvested.
 */
function walk(
  node: ElementLike,
  blocks: ContentNode[],
  links: LinkNode[],
  images: ImageNode[],
  siteHost: string | undefined,
  insideProseBlock: boolean,
): void {
  const tag = node.tagName ? node.tagName.toUpperCase() : ''

  if (SKIP_TAGS.has(tag)) return

  // Links + images are harvested wherever they appear (even inside a prose
  // block, since they're separate from the prose text node).
  if (tag === 'A') {
    const href = getAttr(node, 'href')
    if (href !== null) {
      links.push(makeLink(href, textOf(node), siteHost, getAttr(node, 'rel')))
    }
  } else if (tag === 'IMG') {
    const src = getAttr(node, 'src')
    if (src !== null) images.push(makeImage(src, getAttr(node, 'alt')))
    return // <img> has no element children to walk
  }

  let nowInsideProse = insideProseBlock

  // Record prose text for the NEAREST enclosing prose block, once.
  if (!insideProseBlock && PROSE_BLOCK_TAGS.has(tag)) {
    const text = textOf(node)
    if (collapseWs(text)) {
      if (tag in HEADING_TAGS) {
        pushHeading(blocks, HEADING_TAGS[tag]!, text)
      } else if (tag === 'LI') {
        pushListItem(blocks, text)
      } else {
        // P, BLOCKQUOTE
        pushParagraph(blocks, text)
      }
    }
    nowInsideProse = true
  }

  // Descend into element children in document order to keep harvesting links +
  // images (and prose for non-prose containers like <div>/<section>).
  const children = node.children
  if (children && typeof children.length === 'number') {
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (isElementLike(child)) {
        walk(child, blocks, links, images, siteHost, nowInsideProse)
      }
    }
  }
}

// ─── DOM duck-typing (so a tiny stub passes the same code path in tests) ─────

interface ElementLike {
  tagName?: string
  children?: ArrayLike<unknown>
  textContent?: string | null
  getAttribute?: (name: string) => string | null
}

function isElementLike(v: unknown): v is ElementLike {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as ElementLike).tagName === 'string'
  )
}

function getAttr(node: ElementLike, name: string): string | null {
  if (typeof node.getAttribute !== 'function') return null
  const v = node.getAttribute(name)
  return v === undefined ? null : v
}

function textOf(node: ElementLike): string {
  return typeof node.textContent === 'string' ? node.textContent : ''
}
