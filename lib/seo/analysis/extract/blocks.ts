// content_blocks tree → AnalysisInput body extractor. For the PAGE editor,
// whose content is a tree of registered CMS blocks (section → column → widget;
// see lib/cms/block-registry.ts). Each block is a `{blockType, data}` row; this
// module maps the KNOWN text-bearing block types into ordered ContentNodes,
// pulls links out of action / button / CTA blocks (and any rich-text anchors),
// and pulls images out of figure / gallery / hero blocks (media alt).
//
// PURITY: this stays isomorphic — it does NOT import the server-only Zod
// registry. Instead it accepts a tolerant `BlockLike = {blockType, data:
// unknown}` and reads each known block's fields defensively (every access is
// guarded; an unexpected shape yields nothing rather than throwing). Unknown
// block types are skipped gracefully. This means a registry change can't crash
// scoring — at worst a brand-new block type contributes no text until it's
// taught here.
//
// MEDIA: MediaRef blocks store `{media_id, alt}` — there is NO resolvable src
// in a pure module (src resolution needs the DB/media pipeline). The SEO
// "image alt" check only inspects `alt`, so we synthesize a stable placeholder
// `src` (`media:<id>`) and carry the real `alt`. That's exactly what the
// analysis engine consumes.
//
// ORDER: callers pass blocks ALREADY in render order (position-sorted, tree-
// flattened). We preserve input order. A convenience `flattenBlockTree` is
// exported for callers holding a nested {children} tree.

import type { ContentNode, LinkNode, ImageNode } from '../types'
import {
  type ExtractedContent,
  emptyExtracted,
  collapseWs,
  makeLink,
  makeImage,
  pushParagraph,
  pushHeading,
  pushListItem,
  htmlToContentNodes,
  htmlToPlainText,
  extractAnchorsFromHtml,
  extractImagesFromHtml,
} from './shared'

/** Tolerant input row. `data` is whatever the block stored — read defensively. */
export interface BlockLike {
  blockType: string
  data: unknown
  /** Optional explicit position; when present, callers needn't pre-sort. */
  position?: number
  /** Optional nested children (section/column wrappers). When present,
   *  flattenBlockTree walks them in position order. */
  children?: BlockLike[]
}

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
}

/**
 * Extract `{blocks, links, images}` from a flat list of CMS blocks.
 *
 * @param input    Blocks in render order (or carrying `position`).
 * @param siteHost Canonical site host for internal/external link classification.
 */
export function extractFromBlocks(input: BlockLike[], siteHost?: string): ExtractedContent {
  if (!Array.isArray(input) || input.length === 0) return emptyExtracted()

  const ordered = sortByPosition(input)

  const blocks: ContentNode[] = []
  const links: LinkNode[] = []
  const images: ImageNode[] = []

  for (const block of ordered) {
    if (!block || typeof block.blockType !== 'string') continue
    try {
      mapBlock(block.blockType, asRecord(block.data), blocks, links, images, siteHost)
    } catch {
      // Defensive: a malformed block never breaks the whole extraction.
      continue
    }
  }

  return { blocks, links, images }
}

/**
 * Flatten a nested block tree (sections → columns → widgets) into a single
 * position-ordered list, then run {@link extractFromBlocks}. Pure convenience
 * for callers holding the raw tree shape.
 */
export function flattenBlockTree(tree: BlockLike[], siteHost?: string): ExtractedContent {
  const flat: BlockLike[] = []
  const walk = (nodes: BlockLike[]) => {
    for (const n of sortByPosition(nodes)) {
      if (!n) continue
      flat.push(n)
      if (Array.isArray(n.children) && n.children.length) walk(n.children)
    }
  }
  walk(tree)
  return extractFromBlocks(flat, siteHost)
}

// ─── per-block-type mapping ──────────────────────────────────────────────────

function mapBlock(
  type: string,
  d: Record<string, unknown>,
  blocks: ContentNode[],
  links: LinkNode[],
  images: ImageNode[],
  siteHost?: string,
): void {
  switch (type) {
    // ── Headings ──────────────────────────────────────────────────────────
    case 'lx_heading': {
      const level = HEADING_LEVELS[str(d.level)] ?? 2
      pushHeading(blocks, level, str(d.text))
      return
    }
    case 'lx_animated_headline': {
      const level = HEADING_LEVELS[str(d.level)] ?? 2
      const words = arr(d.words).map(str).filter(Boolean)
      const text = [str(d.prefix), words.join(' '), str(d.suffix)]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ')
      pushHeading(blocks, level, text)
      return
    }

    // ── Eyebrow / kicker (label, renders as <p>) ────────────────────────────
    case 'lx_eyebrow':
      pushParagraph(blocks, str(d.text))
      return

    // ── Rich-text body — HTML prose + anchors + images ──────────────────────
    case 'lx_text': {
      const html = str(d.body_richtext)
      for (const node of htmlToContentNodes(html)) blocks.push(node)
      for (const l of extractAnchorsFromHtml(html, siteHost)) links.push(l)
      for (const img of extractImagesFromHtml(html)) images.push(img)
      return
    }

    // ── Quote / testimonial (quote field is rich-text HTML) ─────────────────
    case 'lx_quote': {
      pushParagraph(blocks, htmlToPlainText(str(d.quote)))
      pushParagraphIfText(blocks, str(d.attribution))
      return
    }
    case 'lx_testimonial': {
      pushParagraph(blocks, str(d.quote))
      pushParagraphIfText(blocks, str(d.attribution))
      pushParagraphIfText(blocks, str(d.attribution_title))
      mediaImage(images, d.portrait)
      return
    }
    case 'lx_testimonial_carousel': {
      for (const it of arr(d.items)) {
        const r = asRecord(it)
        pushParagraph(blocks, str(r.quote))
        pushParagraphIfText(blocks, str(r.attribution))
        pushParagraphIfText(blocks, str(r.attribution_title))
        mediaImage(images, r.portrait)
      }
      return
    }

    // ── CTA action / banner ─────────────────────────────────────────────────
    case 'lx_action': {
      ctaLink(links, str(d.label), str(d.href), siteHost)
      return
    }
    case 'lx_cta_banner': {
      pushParagraphIfText(blocks, str(d.eyebrow))
      pushHeading(blocks, 2, str(d.title))
      pushParagraphIfText(blocks, str(d.body))
      cta(links, d.primaryCta, siteHost)
      cta(links, d.secondaryCta, siteHost)
      return
    }

    // ── Channel card (label / value / description + optional href) ──────────
    case 'lx_channel_card': {
      pushParagraphIfText(blocks, str(d.label))
      pushParagraphIfText(blocks, str(d.value))
      pushParagraphIfText(blocks, str(d.description))
      ctaLink(links, str(d.value) || str(d.label), str(d.href), siteHost)
      return
    }

    // ── Stat (number + label) ───────────────────────────────────────────────
    case 'lx_stat': {
      const num = d.value === undefined || d.value === null ? '' : String(d.value)
      const text = collapseWs(`${str(d.prefix)}${num}${str(d.suffix)} ${str(d.label)}`)
      pushParagraph(blocks, text)
      return
    }

    // ── Icon box / icon list ────────────────────────────────────────────────
    case 'lx_icon_box': {
      pushHeading(blocks, 3, str(d.headline))
      pushParagraphIfText(blocks, str(d.body))
      const link = asRecord(d.link)
      ctaLink(links, str(d.headline), str(link.href), siteHost)
      return
    }
    case 'lx_icon_list': {
      for (const it of arr(d.items)) {
        const r = asRecord(it)
        pushHeading(blocks, 3, str(r.headline))
        pushParagraphIfText(blocks, str(r.body))
      }
      return
    }

    // ── Accordion / tabs (title + rich-text body) ───────────────────────────
    case 'lx_accordion':
    case 'lx_tabs': {
      const itemsKey = type === 'lx_accordion' ? d.items : d.tabs
      for (const it of arr(itemsKey)) {
        const r = asRecord(it)
        pushHeading(blocks, 3, str(r.title) || str(r.label))
        const html = str(r.body_richtext)
        for (const node of htmlToContentNodes(html)) blocks.push(node)
        for (const l of extractAnchorsFromHtml(html, siteHost)) links.push(l)
        for (const img of extractImagesFromHtml(html)) images.push(img)
      }
      return
    }

    // ── Contact form copy ───────────────────────────────────────────────────
    case 'contact_form': {
      pushHeading(blocks, 2, str(d.heading))
      pushParagraphIfText(blocks, str(d.intro))
      pushParagraphIfText(blocks, str(d.success_headline))
      pushParagraphIfText(blocks, str(d.success_body))
      return
    }
    case 'lx_inquiry_form':
    case 'lx_brochure_form': {
      pushHeadingIfText(blocks, 2, str(d.heading))
      const richtext = str(d.body_richtext) || str(d.gate_message_richtext)
      if (richtext) {
        for (const node of htmlToContentNodes(richtext)) blocks.push(node)
        for (const l of extractAnchorsFromHtml(richtext, siteHost)) links.push(l)
      }
      return
    }

    // ── Pricing table / list ────────────────────────────────────────────────
    case 'lx_pricing_table': {
      pushHeading(blocks, 3, str(d.planName))
      pushParagraphIfText(blocks, str(d.price))
      pushParagraphIfText(blocks, str(d.description))
      for (const f of arr(d.features)) pushListItem(blocks, str(f))
      ctaLink(links, str(d.ctaLabel) || str(d.planName), str(d.ctaHref), siteHost)
      return
    }
    case 'lx_pricing_list': {
      for (const it of arr(d.items)) {
        const r = asRecord(it)
        pushListItem(blocks, collapseWs(`${str(r.title)} ${str(r.price)}`))
        pushParagraphIfText(blocks, str(r.description))
      }
      return
    }

    // ── Reviews ─────────────────────────────────────────────────────────────
    case 'lx_reviews': {
      for (const it of arr(d.items)) {
        const r = asRecord(it)
        pushParagraphIfText(blocks, str(r.author))
        pushParagraphIfText(blocks, str(r.text))
        pushParagraphIfText(blocks, str(r.role))
        mediaImage(images, r.avatar)
      }
      return
    }

    // ── Timeline / progress / comparison ────────────────────────────────────
    case 'lx_timeline': {
      for (const it of arr(d.events)) {
        const r = asRecord(it)
        pushHeading(blocks, 3, str(r.title))
        pushParagraphIfText(blocks, str(r.date))
        pushParagraphIfText(blocks, str(r.body))
        mediaImage(images, r.image)
      }
      return
    }
    case 'lx_progress_tracker': {
      for (const it of arr(d.steps)) {
        const r = asRecord(it)
        pushHeading(blocks, 3, str(r.title))
        pushParagraphIfText(blocks, str(r.description))
      }
      return
    }
    case 'lx_comparison_table': {
      for (const c of arr(d.columns)) pushParagraphIfText(blocks, str(c))
      for (const row of arr(d.rows)) {
        const r = asRecord(row)
        const cells = [str(r.feature), str(r.c1), str(r.c2), str(r.c3), str(r.c4)]
          .filter(Boolean)
          .join(' ')
        pushParagraphIfText(blocks, cells)
      }
      return
    }

    // ── Flip box / hotspot (text + image) ───────────────────────────────────
    case 'lx_flip_box': {
      pushHeading(blocks, 3, str(d.frontHeadline))
      pushParagraphIfText(blocks, str(d.frontBody))
      pushHeadingIfText(blocks, 3, str(d.backHeadline))
      pushParagraphIfText(blocks, str(d.backBody))
      ctaLink(links, str(d.backCtaLabel) || str(d.backHeadline), str(d.backCtaHref), siteHost)
      mediaImage(images, d.frontImage)
      return
    }
    case 'lx_hotspot': {
      mediaImage(images, d.image)
      for (const it of arr(d.markers)) {
        const r = asRecord(it)
        pushParagraphIfText(blocks, str(r.label))
        pushParagraphIfText(blocks, str(r.body))
      }
      return
    }

    // ── Cover image (image + optional text overlay + optional CTA) ──────────
    case 'lx_cover_image': {
      mediaImage(images, d.image)
      pushParagraphIfText(blocks, str(d.eyebrow))
      pushHeadingIfText(blocks, 1, str(d.title))
      pushParagraphIfText(blocks, str(d.body))
      cta(links, d.cta, siteHost)
      return
    }

    // ── Figure / image-pair / gallery / carousel / before-after — images ────
    case 'lx_figure': {
      mediaImage(images, d.image)
      pushParagraphIfText(blocks, str(d.caption))
      return
    }
    case 'lx_image_pair': {
      mediaImage(images, d.leftImage)
      mediaImage(images, d.rightImage)
      return
    }
    case 'lx_gallery': {
      for (const it of arr(d.images)) {
        mediaImage(images, it)
        pushParagraphIfText(blocks, str(asRecord(it).caption))
      }
      return
    }
    case 'lx_carousel': {
      for (const it of arr(d.slides)) {
        const r = asRecord(it)
        mediaImage(images, r.image)
        pushParagraphIfText(blocks, str(r.caption))
        ctaLink(links, str(r.caption), str(r.href), siteHost)
      }
      return
    }
    case 'lx_before_after': {
      mediaImage(images, d.before)
      mediaImage(images, d.after)
      pushParagraphIfText(blocks, str(d.beforeLabel))
      pushParagraphIfText(blocks, str(d.afterLabel))
      return
    }

    // ── Marquee (text mode carries prose) ───────────────────────────────────
    case 'lx_marquee': {
      pushParagraphIfText(blocks, str(d.text))
      for (const logo of arr(d.logos)) mediaImage(images, logo)
      return
    }

    // ── Social icons + table-of-contents + share — links / labels ───────────
    case 'lx_social_icons': {
      for (const it of arr(d.items)) {
        const r = asRecord(it)
        ctaLink(links, str(r.platform), str(r.href), siteHost)
      }
      return
    }
    case 'lx_toc': {
      pushParagraphIfText(blocks, str(d.title))
      for (const it of arr(d.items)) {
        const r = asRecord(it)
        ctaLink(links, str(r.label), `#${str(r.anchor)}`, siteHost)
      }
      return
    }

    // ── Code block — language-tagged code is NOT prose; skip text but the
    // block exists. (Mirrors markdown extractor dropping fenced code.) ──────
    case 'lx_code':
      return

    // ── Spacers / dividers / structural / media-less utility — no content.
    // lx_space, lx_divider, lx_menu_anchor, lx_star_rating, lx_progress,
    // lx_countdown, lx_video, lx_map, lx_embed, lx_featured_projects, lx_posts
    // contribute no editable prose/links/images to the SEO body (they're
    // dynamic, embed, or pure-chrome). Skip gracefully. ──────────────────────
    default:
      return
  }
}

// ─── small defensive accessors ───────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Coerce a field to a trimmed string; non-strings → ''. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function sortByPosition(list: BlockLike[]): BlockLike[] {
  // Stable sort by `position` when present; rows without it keep input order.
  const withIdx = list.map((b, i) => ({ b, i }))
  withIdx.sort((a, z) => {
    const pa = typeof a.b?.position === 'number' ? a.b.position : a.i
    const pz = typeof z.b?.position === 'number' ? z.b.position : z.i
    return pa - pz || a.i - z.i
  })
  return withIdx.map((x) => x.b)
}

function pushParagraphIfText(out: ContentNode[], text: string): void {
  if (text.trim()) pushParagraph(out, text)
}

function pushHeadingIfText(out: ContentNode[], level: number, text: string): void {
  if (text.trim()) pushHeading(out, level, text)
}

/** Build a CTA link from a flat label+href pair (skips empty hrefs). */
function ctaLink(out: LinkNode[], label: string, href: string, siteHost?: string): void {
  if (!href.trim()) return
  out.push(makeLink(href, label || href, siteHost))
}

/** Build a CTA link from a `{label, href}` object (lx_cta_banner / cover cta). */
function cta(out: LinkNode[], obj: unknown, siteHost?: string): void {
  const r = asRecord(obj)
  ctaLink(out, str(r.label), str(r.href), siteHost)
}

/**
 * Append an ImageNode for a MediaRef-shaped value (`{media_id, alt}`). The src
 * is synthesized from media_id (`media:<id>`) since a pure module can't resolve
 * the real upload path; alt is carried verbatim (what the SEO image-alt check
 * reads). Missing media_id → src `media:?` so the node still counts as "an
 * image present" for the has-images check.
 */
function mediaImage(out: ImageNode[], ref: unknown): void {
  const r = asRecord(ref)
  if (r.media_id === undefined && r.alt === undefined) return
  const id = typeof r.media_id === 'number' ? r.media_id : '?'
  out.push(makeImage(`media:${id}`, str(r.alt)))
}
