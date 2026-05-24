import 'server-only'
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

// Markdown → sanitized HTML pipeline for blog posts.
//
// The pipeline is server-only and deliberately restrictive:
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
// The output is consumed via `dangerouslySetInnerHTML` on the
// `/blog/[slug]` page — the sanitizer is the only trust boundary,
// so changes here must keep the XSS test suite green (see
// tests/unit/markdown.test.ts).
//
// Schema overrides spread defaultSchema first so common
// non-overridden attributes (href on <a>, alt on <img>, etc.) keep
// the upstream filters. Spreading `defaultSchema.attributes` then
// overriding `a` + `img` is intentional: those two tags carry
// URL-bearing attributes and need our anchored regex.

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
    href: [
      ...((defaultSchema.protocols?.href ?? []) as string[]),
      'tel',
    ],
  },
}

export async function renderMarkdown(md: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, SCHEMA)
    .use(rehypeStringify)
    .process(md)
  return String(file)
}
