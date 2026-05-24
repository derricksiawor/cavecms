import { describe, it, expect } from 'vitest'
import {
  parseVideoEmbedUrl,
  buildEmbedSrc,
} from '@/lib/cms/videoHostAllowlist'

// Build control-char strings at runtime via fromCharCode so the source
// file itself contains no literal control bytes (NUL/CR/LF/TAB/DEL).
// Keeps git/diff/grep behaviour predictable.
const CR = String.fromCharCode(0x0d)
const LF = String.fromCharCode(0x0a)
const TAB = String.fromCharCode(0x09)
const NUL = String.fromCharCode(0x00)
const DEL = String.fromCharCode(0x7f)

const YT = 'https://www.youtube.com/embed/dQw4w9WgXcQ'

describe('parseVideoEmbedUrl - happy path', () => {
  it('accepts a canonical YouTube embed URL', () => {
    expect(parseVideoEmbedUrl(YT)).toEqual({
      kind: 'youtube',
      id: 'dQw4w9WgXcQ',
    })
  })

  it('accepts a YouTube embed URL with arbitrary trailing query', () => {
    // Operator may paste with start=42; renderer strips it (builds its
    // own src). The parse boundary still accepts the input.
    expect(parseVideoEmbedUrl(YT + '?start=42')).toEqual({
      kind: 'youtube',
      id: 'dQw4w9WgXcQ',
    })
  })

  it('accepts a canonical Vimeo player URL', () => {
    expect(parseVideoEmbedUrl('https://player.vimeo.com/video/76979871')).toEqual({
      kind: 'vimeo',
      id: '76979871',
    })
  })

  it('accepts a longer-id Vimeo URL', () => {
    expect(
      parseVideoEmbedUrl('https://player.vimeo.com/video/123456789012'),
    ).toEqual({ kind: 'vimeo', id: '123456789012' })
  })
})

describe('parseVideoEmbedUrl - rejection matrix', () => {
  // Adversarial inputs. Every entry MUST return null. Labels describe
  // the attack class so a regression names the failure clearly.
  const REJECT: Array<[string, unknown]> = [
    ['null input', null],
    ['undefined input', undefined],
    ['number input', 42],
    ['object input', { url: YT }],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['url with leading whitespace', ' ' + YT],
    ['url with trailing whitespace', YT + ' '],
    ['url over 500 chars', 'https://www.youtube.com/embed/' + 'a'.repeat(600)],

    // Wrong schemes
    ['http scheme (not https)', 'http://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['file: scheme', 'file:///etc/passwd'],
    ['blob: scheme', 'blob:https://www.youtube.com/abc'],
    ['vbscript: scheme', 'vbscript:msgbox(1)'],

    // Missing scheme / malformed
    ['protocol-relative', '//www.youtube.com/embed/dQw4w9WgXcQ'],
    ['bare path', '/embed/dQw4w9WgXcQ'],
    ['plain text', 'youtube.com/embed/dQw4w9WgXcQ'],
    ['malformed URL', 'https://[not-a-url'],

    // Userinfo smuggling
    [
      'userinfo smuggle (evil.com@youtube.com)',
      'https://evil.com@www.youtube.com/embed/dQw4w9WgXcQ',
    ],
    [
      'userinfo smuggle (password component)',
      'https://user:pass@www.youtube.com/embed/dQw4w9WgXcQ',
    ],

    // Host collisions
    [
      'host suffix collision (youtube.com.evil.com)',
      'https://www.youtube.com.evil.com/embed/dQw4w9WgXcQ',
    ],
    [
      'host prefix collision (evil-youtube.com)',
      'https://evil-youtube.com/embed/dQw4w9WgXcQ',
    ],
    ['youtube without www subdomain', 'https://youtube.com/embed/dQw4w9WgXcQ'],
    ['youtube on m. mobile subdomain', 'https://m.youtube.com/embed/dQw4w9WgXcQ'],

    // Wrong YouTube paths
    [
      'youtube watch URL (not embed)',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ],
    ['youtube shortened URL', 'https://youtu.be/dQw4w9WgXcQ'],
    ['youtube channel URL', 'https://www.youtube.com/channel/UCxxx'],
    [
      'youtube-nocookie embed URL (we accept the regular host only)',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],

    // Vimeo variants
    ['vimeo non-player host', 'https://vimeo.com/76979871'],
    [
      'vimeo on non-player subdomain with /video path',
      'https://vimeo.com/video/76979871',
    ],

    // IDN / homoglyph
    [
      'punycode/IDN homoglyph',
      'https://www.xn--youtube-xxxxx.com/embed/dQw4w9WgXcQ',
    ],

    // Encoding / smuggling chars (built via fromCharCode above)
    [
      'percent-encoded slash in path',
      'https://www.youtube.com%2fevil.com/embed/dQw4w9WgXcQ',
    ],
    [
      'backslash in URL',
      'https://www.youtube.com\\.evil.com/embed/dQw4w9WgXcQ',
    ],
    ['embedded CR (0x0D)', YT + CR + 'Location: evil'],
    ['embedded LF (0x0A)', YT + LF + 'Location: evil'],
    ['embedded TAB (0x09)', 'https://www.youtube.com' + TAB + '/embed/dQw4w9WgXcQ'],
    ['embedded NUL (0x00)', YT + NUL],
    ['embedded DEL (0x7F)', YT + DEL],

    // Explicit port + hash
    ['explicit port', 'https://www.youtube.com:8080/embed/dQw4w9WgXcQ'],
    ['hash fragment', 'https://www.youtube.com/embed/dQw4w9WgXcQ#fragment'],

    // YouTube id grammar
    ['short YouTube id (under 11 chars)', 'https://www.youtube.com/embed/short'],
    [
      'long YouTube id (over 11 chars)',
      'https://www.youtube.com/embed/aaaaaaaaaaaaa',
    ],
    [
      'YouTube id with illegal char (!)',
      'https://www.youtube.com/embed/dQw4w9WgXc!',
    ],
    ['YouTube path with trailing slash', YT + '/'],
    ['YouTube path with extra segment', YT + '/extra'],

    // Vimeo id grammar
    ['Vimeo path with non-numeric id', 'https://player.vimeo.com/video/abc123'],
    ['Vimeo path with id too short', 'https://player.vimeo.com/video/123'],
    [
      'Vimeo with extra path segment',
      'https://player.vimeo.com/video/76979871/extra',
    ],

    // FQDN trailing-dot - WHATWG parses this as a distinct host
    // string ("www.youtube.com." != "www.youtube.com") so the
    // exact-equality host gate rejects naturally. Pin the behaviour
    // so a future host-suffix matcher rewrite can't silently accept.
    ['trailing-dot FQDN', 'https://www.youtube.com./embed/dQw4w9WgXcQ'],
  ]

  it.each(REJECT)('rejects: %s', (_label, input) => {
    expect(parseVideoEmbedUrl(input)).toBeNull()
  })
})

describe('parseVideoEmbedUrl - WHATWG normalisation acceptances', () => {
  // WHATWG URL normalises scheme + host to lowercase. The gate
  // operates on the normalised form, so these inputs are ACCEPTED.
  // Pin the behaviour so a future hand-rolled "scheme must be
  // exactly 'https:'" check can't silently break case-insensitive
  // inputs that real operators paste from mobile keyboards.
  it('accepts mixed-case https scheme', () => {
    expect(
      parseVideoEmbedUrl('HTTPS://www.youtube.com/embed/dQw4w9WgXcQ'),
    ).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' })
  })

  it('accepts uppercase host', () => {
    expect(
      parseVideoEmbedUrl('https://WWW.YOUTUBE.COM/embed/dQw4w9WgXcQ'),
    ).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' })
  })
})

describe('buildEmbedSrc', () => {
  it('constructs a youtube-nocookie embed src from { kind, id }', () => {
    const src = buildEmbedSrc({ kind: 'youtube', id: 'dQw4w9WgXcQ' })
    expect(src).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?modestbranding=1&rel=0',
    )
  })

  it('constructs a vimeo player src from { kind, id }', () => {
    const src = buildEmbedSrc({ kind: 'vimeo', id: '76979871' })
    expect(src).toBe(
      'https://player.vimeo.com/video/76979871?byline=0&title=0&portrait=0',
    )
  })

  it('never echoes operator-supplied query: parsed input that included extra params is not in the output', () => {
    const parsed = parseVideoEmbedUrl(
      YT + '?evil=1&xss=%3Cscript%3E',
    )
    expect(parsed).not.toBeNull()
    const src = buildEmbedSrc(parsed!)
    expect(src).not.toContain('evil=1')
    expect(src).not.toContain('xss=')
    expect(src).not.toContain('%3C')
  })
})
