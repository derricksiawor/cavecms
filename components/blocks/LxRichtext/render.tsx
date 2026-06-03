import clsx from 'clsx'
import { MotionTarget } from '@/components/motion/MotionTarget'
import { renderMarkdownSync } from '@/lib/cms/markdown-shared'
import type { BlockData } from '@/lib/cms/block-registry'
import { isColorToken, resolveColorValue } from '@/lib/cms/designTokens'

// Rich text (markdown) — the home of a full post body on the block
// engine (spec §4.6). `data.markdown` is the markdown SOURCE (plain
// text, NOT a parse.ts RICHTEXT_FIELD); it is transformed to sanitized
// HTML HERE, at render, via `renderMarkdownSync` — whose rehype-sanitize
// allowlist is the sole XSS trust boundary.
//
// SYNCHRONOUS by design (mirrors LxCode): the editor canvas
// (EditableBlockTreeRenderer) renders blocks in a CLIENT tree, where an
// async component throws "async Client Component". `renderMarkdownSync`
// runs the same pipeline as the async `renderMarkdown` via unified's
// `processSync()` (every plugin is synchronous), so server + client
// canvas + SSR all emit identical HTML with no async boundary.
//
// `renderMarkdownSync` is imported from markdown-SHARED (no `server-only`
// marker) precisely so this renderer is safe in the client bundle the
// editor canvas pulls `renderBlock` into.
//
// No `prose` plugin — prose injects underlined links, blockquote borders,
// and horizontal-rule defaults that contradict the global "no borders"
// rule. The `cms-richtext` class (globals.css) styles the emitted
// headings / lists / blockquote / code / images directly to the luxury
// editorial register.

const TONE_TOKEN_CLASS: Record<string, string> = {
  obsidian: 'text-obsidian',
  ivory: 'text-ivory',
  'warm-stone': 'text-warm-stone',
}

const MAX_WIDTH_CLASS: Record<BlockData<'lx_richtext'>['maxWidth'], string> = {
  narrow: 'max-w-[45ch] mx-auto',
  medium: 'max-w-[60ch] mx-auto',
  wide: 'max-w-[72ch] mx-auto',
  full: 'max-w-none',
}

export function LxRichtext({
  data,
  outerClass,
}: {
  data: BlockData<'lx_richtext'>
  outerClass?: string
}) {
  const tone = data.tone
  const toneClass = isColorToken(tone) ? TONE_TOKEN_CLASS[tone] : undefined
  const toneStyle = !isColorToken(tone)
    ? { color: resolveColorValue(tone) }
    : undefined

  const className = clsx(
    'cms-richtext font-sans leading-relaxed',
    MAX_WIDTH_CLASS[data.maxWidth],
    toneClass,
  )

  // Empty body renders nothing on the public page (a post saved with no
  // body yet). The editor canvas shows the block shell + the EditDrawer
  // markdown field, so an operator can still select + fill it.
  if (!data.markdown) {
    return null
  }

  const html = renderMarkdownSync(data.markdown)

  const content = (
    <div
      className={className}
      style={toneStyle}
      // html is the output of renderMarkdownSync's rehype-sanitize
      // pipeline — the sole XSS trust boundary for this block. The
      // markdown source is stored as plain text and never trusted as
      // HTML before this transform.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )

  if (data.animation === 'none') {
    return <div className={outerClass}>{content}</div>
  }
  return (
    <div className={outerClass}>
      <MotionTarget preset={data.animation}>{content}</MotionTarget>
    </div>
  )
}
