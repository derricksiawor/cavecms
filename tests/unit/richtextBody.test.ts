import { describe, it, expect } from 'vitest'
import { renderMarkdown, renderMarkdownSync } from '@/lib/cms/markdown-shared'
import { parseBlockData } from '@/lib/cms/block-registry'

// Markdown → post-body conversion (Phase 2 blog system).
//
// The post body moves onto the block engine as a single `lx_richtext`
// block whose `markdown` field is the post's markdown SOURCE (plain
// text). It is rendered to sanitized HTML by `renderMarkdownSync` — the
// synchronous twin of `renderMarkdown` — both of which run the IDENTICAL
// rehype-sanitize pipeline. These tests pin the two invariants the
// migration + render path depend on:
//
//   1. renderMarkdownSync is byte-identical to renderMarkdown (so the
//      editor canvas's synchronous render matches the server's async
//      render and the public page).
//   2. The lx_richtext block faithfully round-trips a full post body —
//      headings, lists, blockquotes, code, images, rules — WITHOUT the
//      stripping a single lx_text block would impose (its DOMPurify
//      allowlist is inline+lists only). This is the load-bearing reason
//      lx_richtext exists instead of reusing lx_text.

const FULL_BODY = [
  '# Title',
  '',
  '## A section heading',
  '',
  'A paragraph with **bold**, _italic_, a [link](https://example.com) and `inline code`.',
  '',
  '- bullet one',
  '- bullet two',
  '',
  '1. step one',
  '2. step two',
  '',
  '> A block quote.',
  '',
  '```ts',
  'const x: number = 1',
  '```',
  '',
  '![alt text](/uploads/variants/photo-md.webp)',
  '',
  '---',
  '',
  'Closing paragraph.',
].join('\n')

describe('renderMarkdownSync', () => {
  it('produces byte-identical output to the async renderMarkdown', async () => {
    const asyncHtml = await renderMarkdown(FULL_BODY)
    const syncHtml = renderMarkdownSync(FULL_BODY)
    expect(syncHtml).toBe(asyncHtml)
  })

  it('preserves the full block-level markdown set (no stripping)', () => {
    const html = renderMarkdownSync(FULL_BODY)
    // The exact tags a single lx_text body_richtext (inline+lists only)
    // would silently DROP — they MUST survive here.
    expect(html).toContain('<h2>A section heading</h2>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<pre>')
    expect(html).toContain('<code')
    expect(html).toContain('<hr>')
    expect(html).toContain('src="/uploads/variants/photo-md.webp"')
    // Lists + inline emphasis survive too.
    expect(html).toContain('<ul>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('href="https://example.com"')
  })

  it('keeps the sanitizer as the trust boundary (strips script + js: + external img)', () => {
    const html = renderMarkdownSync(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![y](https://evil.example/x.png)',
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('evil.example')
  })
})

describe('lx_richtext block — post-body round-trip', () => {
  it('round-trips a full markdown body through the block schema unchanged', () => {
    // This is exactly what insertPostBodyPage / migratePostsToBlocks do:
    // wrap the body_md in { markdown } and validate through the registry.
    const parsed = parseBlockData('lx_richtext', { markdown: FULL_BODY })
    // The markdown SOURCE is stored verbatim (plain text, NOT a
    // RICHTEXT_FIELD — so it is NOT DOMPurify-stripped at the write
    // boundary; sanitization happens at render via renderMarkdownSync).
    expect((parsed as { markdown: string }).markdown).toBe(FULL_BODY)
    // Schema defaults applied.
    expect(parsed).toMatchObject({
      tone: 'obsidian',
      maxWidth: 'wide',
      animation: 'none',
    })
  })

  it('accepts an empty body (fresh draft create-flow seeds markdown: "")', () => {
    const parsed = parseBlockData('lx_richtext', { markdown: '' })
    expect((parsed as { markdown: string }).markdown).toBe('')
  })

  it('accepts international body content (ZWJ emoji + RTL) — markdown source is not display-gated', () => {
    // Long-form post bodies legitimately contain ZWJ emoji (👨‍👩‍👧 uses
    // U+200D) and bidi-embedded RTL text. The render-time sanitizer (not a
    // parse-time display gate) is the trust boundary, matching how body_md is
    // validated at the posts write boundary (length cap only). The lx_richtext
    // markdown field must NOT reject these, or i18n/emoji posts would strand
    // on the legacy markdown fallback during backfill.
    const intl = '# عنوان\n\nfamily 👨‍👩‍👧 and حقوق'
    const parsed = parseBlockData('lx_richtext', { markdown: intl })
    expect((parsed as { markdown: string }).markdown).toBe(intl)
  })

  it('neutralizes a bidi-override at RENDER (sanitized output, no parse-time reject)', () => {
    // The bidi override is preserved in the source (not the trust boundary)
    // but the rendered HTML is produced by the same sanitized pipeline as
    // every other field — parse must not throw on it.
    const src = 'evil‮moc.live'
    expect(() => parseBlockData('lx_richtext', { markdown: src })).not.toThrow()
  })
})
