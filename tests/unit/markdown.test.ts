import { describe, it, expect } from 'vitest'
import { renderMarkdown } from '@/lib/cms/markdown'

describe('renderMarkdown', () => {
  it('strips <script> tags from raw HTML in markdown', async () => {
    const out = await renderMarkdown('<script>alert(1)</script>\n\nhello')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('hello')
  })

  it('strips inline event handlers', async () => {
    const out = await renderMarkdown('<p onclick="alert(1)">x</p>')
    // remarkRehype with allowDangerousHtml=false drops the raw HTML
    // block entirely, so neither the attribute nor the tag survives.
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('alert(1)')
  })

  it('keeps internal /uploads/variants/* images', async () => {
    const out = await renderMarkdown('![ok](/uploads/variants/abc-md.webp)')
    expect(out).toContain('src="/uploads/variants/abc-md.webp"')
  })

  it('keeps internal /uploads/originals/* images', async () => {
    const out = await renderMarkdown('![ok](/uploads/originals/photo.jpg)')
    expect(out).toContain('src="/uploads/originals/photo.jpg"')
  })

  it('strips external image hosts', async () => {
    const out = await renderMarkdown('![bad](https://evil.example/x.png)')
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('https://')
  })

  it('strips javascript: hrefs', async () => {
    const out = await renderMarkdown('[click](javascript:alert(1))')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('alert(1)')
  })

  it('strips data: hrefs', async () => {
    const out = await renderMarkdown('[click](data:text/html,<script>1</script>)')
    expect(out).not.toContain('data:')
    expect(out).not.toContain('<script')
  })

  it('keeps https + mailto + tel hrefs', async () => {
    const https = await renderMarkdown('[x](https://example.com)')
    expect(https).toContain('href="https://example.com"')
    const mailto = await renderMarkdown('[x](mailto:a@b.co)')
    expect(mailto).toContain('href="mailto:a@b.co"')
    const tel = await renderMarkdown('[x](tel:+233000)')
    expect(tel).toContain('href="tel:+233000"')
  })

  it('allows lists, headings, blockquote, inline code', async () => {
    const out = await renderMarkdown(
      '## H2\n\n- a\n- b\n\n> quote\n\n`inline`',
    )
    expect(out).toContain('<h2>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<code>')
  })

  it('drops <iframe> and <style> blocks', async () => {
    const out = await renderMarkdown(
      '<iframe src="//x"></iframe>\n\n<style>body{display:none}</style>\n\nhi',
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<style')
    expect(out).toContain('hi')
  })

  it('drops <table> tags (not in allow-list)', async () => {
    const out = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(out).not.toContain('<table')
    expect(out).not.toContain('<td')
  })

  it('drops image with bare filename (no /uploads prefix)', async () => {
    const out = await renderMarkdown('![x](abc-md.webp)')
    // src attribute must be stripped; the regex requires the
    // /uploads/originals|variants/ prefix.
    expect(out).not.toContain('src="abc-md.webp"')
  })

  it('drops image with traversal in path', async () => {
    const out = await renderMarkdown('![x](/uploads/variants/../../etc/passwd.webp)')
    expect(out).not.toContain('passwd')
  })
})
