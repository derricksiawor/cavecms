import { describe, it, expect } from 'vitest'
import { sanitizeRichText } from '@/lib/cms/sanitize'

describe('sanitizeRichText', () => {
  it('keeps allowed tags + adds noopener/nofollow/target on anchors', () => {
    const html = sanitizeRichText('<p><a href="https://example.com">x</a></p>')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('target="_blank"')
  })

  it('strips javascript: hrefs', () => {
    const html = sanitizeRichText('<p><a href="javascript:alert(1)">x</a></p>')
    expect(html).not.toContain('javascript:')
  })

  it('strips data: hrefs', () => {
    const html = sanitizeRichText('<p><a href="data:text/html,<x>">y</a></p>')
    expect(html).not.toContain('data:text/html')
  })

  it('strips disallowed tags', () => {
    const html = sanitizeRichText('<script>bad</script><p>ok</p>')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('<p>ok</p>')
  })

  it('strips disallowed attributes (style/onclick)', () => {
    const html = sanitizeRichText(
      '<p style="color:red" onclick="x()">hello</p>',
    )
    expect(html).not.toContain('style=')
    expect(html).not.toContain('onclick')
    expect(html).toContain('hello')
  })

  it('preserves emphasis + lists', () => {
    const html = sanitizeRichText(
      '<p><strong>bold</strong> and <em>italic</em></p><ul><li>a</li></ul>',
    )
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<li>a</li>')
  })

  it('allows mailto: and tel: hrefs', () => {
    const html1 = sanitizeRichText('<p><a href="mailto:x@y.com">x</a></p>')
    const html2 = sanitizeRichText('<p><a href="tel:+233000000000">y</a></p>')
    expect(html1).toContain('href="mailto:x@y.com"')
    expect(html2).toContain('href="tel:+233000000000"')
  })
})
