// Isomorphic markdown → sanitized HTML pipeline — shared by the server
// boundary (lib/cms/markdown.ts, gated with 'server-only') and the
// CLIENT-side `lx_richtext` block renderer. No `server-only` marker
// here, by design and mirroring the sanitize-shared.ts split: the
// `lx_richtext` renderer is dispatched from BOTH the anonymous
// server tree (BlockTreeRenderer, 'server-only') AND the editor canvas
// (EditableBlockTreeRenderer, 'use client'), so the markdown→HTML
// transform it calls must be importable from the client bundle. unified
// + remark/rehype run identically in the browser and on the server.
//
// The pipeline is deliberately restrictive and is the SOLE XSS trust
// boundary for `lx_richtext` (whose `markdown` field is stored as plain
// text — NOT a parse.ts RICHTEXT_FIELD — so it is never DOMPurify'd at
// the write boundary; sanitization happens HERE, at render):
//
//   1. `remarkParse` reads the markdown source.
//   2. `remarkGfm` adds GitHub-flavored markdown features (autolinks,
//      strikethrough). Tables + task lists are parsed but stripped at
//      the sanitize step because the editor surface and CSS don't
//      style them and they expand the XSS surface (td/th can carry
//      style, scope, etc.).
//   3. `remarkRehype({ allowDangerousHtml: false })` converts the
//      markdown AST to an HTML AST WITHOUT passing raw HTML blocks
//      through. A `<script>` in the source never reaches the
//      sanitizer — it's already dropped by the converter.
//   4. `rehypeSanitize(SCHEMA)` applies our allow-list schema:
//        - tagNames: limited to text/structure/code/img/anchor.
//          No <table>, no <iframe>, no <style>, no <svg>.
//        - a.href: regex-gated to http/https/mailto/tel. The
//          rehype-sanitize protocols filter rejects `javascript:`
//          before this regex is consulted.
//        - img.src: anchored regex to /uploads/originals/<name>.ext
//          or /uploads/variants/<name>.ext only. External hosts are
//          dropped silently. Filenames are constrained to the same
//          charset the media-processing pipeline emits, so a
//          legitimate variant URL always passes.
//   5. `rehypeStringify` serializes back to HTML.
//
// The output is consumed via `dangerouslySetInnerHTML` — the sanitizer
// is the only trust boundary, so changes here must keep the XSS test
// suite green (see tests/unit/markdown.test.ts).

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

// Schema type is internal to hast-util-sanitize (not a direct dep);
// derive it from rehypeSanitize's first parameter so a future upgrade
// that changes the option shape produces a compile error here.
type RehypeSanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>
type SanitizeSchema = Exclude<RehypeSanitizeSchema, boolean>

const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    'p',
    'br',
    'strong',
    'em',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'code',
    'pre',
    'h2',
    'h3',
    'h4',
    'img',
    'hr',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Permit `rel` so markdown authors can write `[x](url){rel="nofollow"}`
    // via a future remark extension. `target` is intentionally OMITTED:
    // allowing `target="_blank"` without simultaneously forcing
    // `rel="noopener noreferrer"` opens a window.opener navigation hijack
    // surface. Today remark-rehype with `allowDangerousHtml:false` already
    // strips raw HTML so `target` cannot be reached from markdown syntax —
    // this removal is defense-in-depth against a future schema relaxation.
    a: [['href', /^(?:https?|mailto|tel):/i], 'rel'],
    img: [
      [
        'src',
        /^\/uploads\/(?:originals|variants)\/[A-Za-z0-9._-]{1,80}\.(?:jpe?g|png|webp|avif)$/,
      ],
      'alt',
    ],
  },
  // Extend default href protocol allow-list with `tel:` so mobile
  // visitors get tap-to-call links. The default list includes http,
  // https, irc, ircs, mailto, xmpp — `tel` is the only addition.
  // The regex on `a.href` is a second filter applied AFTER this list
  // (rejecting any protocol the regex doesn't match), so this widens
  // the allowed set only to the intersection of both filters.
  protocols: {
    ...defaultSchema.protocols,
    href: [...((defaultSchema.protocols?.href ?? []) as string[]), 'tel'],
  },
}

// Single processor factory so the async + sync entry points share ONE
// pipeline definition — a change to the plugin chain or the SCHEMA can
// never diverge between the two render paths. Every plugin in this
// chain is synchronous, so `processSync()` is valid; the async
// `process()` path is kept for callers already on it (the /blog/[slug]
// route, the editor preview server action).
function markdownProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeStringify)
}

export async function renderMarkdown(md: string): Promise<string> {
  const file = await markdownProcessor().process(md)
  return String(file)
}

// Synchronous markdown → sanitized HTML. Same pipeline + SCHEMA as
// `renderMarkdown`, run through unified's `processSync()`. Required by
// the `lx_richtext` block renderer: the editor canvas
// (EditableBlockTreeRenderer) is a CLIENT component that calls
// `renderBlock()` synchronously, so an async block renderer throws
// "async Client Component" there — exactly the constraint that keeps
// `LxCode` synchronous. Because every plugin in `markdownProcessor()`
// is synchronous, `processSync()` produces byte-identical output to the
// async path.
export function renderMarkdownSync(md: string): string {
  const file = markdownProcessor().processSync(md)
  return String(file)
}
