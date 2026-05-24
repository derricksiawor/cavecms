import { describe, it, expect } from 'vitest'
import { safeJsonForScript } from '@/lib/seo/escape'

describe('safeJsonForScript', () => {
  it('round-trips ordinary JSON content', () => {
    const out = safeJsonForScript({ a: 1, b: 'two' })
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'two' })
  })

  it('escapes </script> so it cannot terminate the script tag', () => {
    const out = safeJsonForScript({ name: 'Bad</script><img src=x onerror=alert(1)>' })
    expect(out).not.toContain('</script')
    // The literal `<` must be encoded as a JSON < escape.
    expect(out).toContain('\\u003c/script')
  })

  it('escapes HTML comment close --> so it cannot terminate a wrapping comment', () => {
    const out = safeJsonForScript({ note: 'a-->b' })
    expect(out).not.toMatch(/-->/)
    expect(out).toContain('--\\u003e')
  })

  it('escapes U+2028 line separator', () => {
    const sep = String.fromCharCode(0x2028)
    const out = safeJsonForScript({ s: `a${sep}b` })
    expect(out).not.toContain(sep)
    expect(out).toContain('\\u2028')
  })

  it('escapes U+2029 paragraph separator', () => {
    const sep = String.fromCharCode(0x2029)
    const out = safeJsonForScript({ s: `x${sep}y` })
    expect(out).not.toContain(sep)
    expect(out).toContain('\\u2029')
  })

  it('preserves valid JSON parseability after all escapes', () => {
    const sep28 = String.fromCharCode(0x2028)
    const sep29 = String.fromCharCode(0x2029)
    const out = safeJsonForScript({
      name: 'Bad</script>',
      mid: `a${sep28}b${sep29}c`,
      end: 'comment-->',
    })
    const parsed = JSON.parse(out) as Record<string, string>
    // JSON.parse should round-trip the escapes back to the original chars.
    expect(parsed.name).toBe('Bad</script>')
    expect(parsed.mid).toBe(`a${sep28}b${sep29}c`)
    expect(parsed.end).toBe('comment-->')
  })
})
