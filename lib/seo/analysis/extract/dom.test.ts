// NOTE on environment: the project's vitest runs in the `node` environment
// (vitest.config.ts → test.environment === 'node'), so there is no jsdom /
// real DOM available here. `extractFromDom` is written against a small DOM
// duck-type (tagName / children / textContent / getAttribute), so we exercise
// it with a minimal hand-rolled element stub that implements exactly that
// surface. This is a happy-path + key-edge-case test of the walk logic; full
// real-DOM coverage belongs in a browser/jsdom suite if one is later added.

import { describe, it, expect } from 'vitest'
import { extractFromDom } from './dom'

// ─── tiny DOM stub ───────────────────────────────────────────────────────────
interface StubEl {
  tagName: string
  children: StubEl[]
  textContent: string
  attrs: Record<string, string>
  getAttribute(name: string): string | null
}

function el(
  tag: string,
  opts: { text?: string; attrs?: Record<string, string>; children?: StubEl[] } = {},
): StubEl {
  const children = opts.children ?? []
  // textContent mirrors the DOM: concatenation of descendant text. For a leaf
  // with explicit text we use that; for a container we join children's text.
  const ownText = opts.text ?? ''
  const text = ownText || children.map((c) => c.textContent).join(' ')
  const attrs = opts.attrs ?? {}
  return {
    tagName: tag,
    children,
    textContent: text,
    attrs,
    getAttribute: (name: string) => (name in attrs ? attrs[name]! : null),
  }
}

describe('extractFromDom', () => {
  it('returns empty for non-element input', () => {
    expect(extractFromDom(null)).toEqual({ blocks: [], links: [], images: [] })
    expect(extractFromDom(undefined)).toEqual({ blocks: [], links: [], images: [] })
    expect(extractFromDom({})).toEqual({ blocks: [], links: [], images: [] })
    expect(extractFromDom('string')).toEqual({ blocks: [], links: [], images: [] })
  })

  it('walks headings, paragraphs, and list items in document order', () => {
    const root = el('DIV', {
      children: [
        el('H1', { text: 'Title' }),
        el('P', { text: 'Intro paragraph.' }),
        el('UL', {
          children: [el('LI', { text: 'one' }), el('LI', { text: 'two' })],
        }),
        el('H2', { text: 'Section' }),
      ],
    })
    const { blocks } = extractFromDom(root, 'example.com')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'Intro paragraph.' },
      { kind: 'listitem', text: 'one' },
      { kind: 'listitem', text: 'two' },
      { kind: 'heading', level: 2, text: 'Section' },
    ])
  })

  it('extracts links with internal/external classification + rel', () => {
    const root = el('DIV', {
      children: [
        el('P', {
          children: [
            el('A', { text: 'about', attrs: { href: '/about' } }),
            el('A', {
              text: 'ext',
              attrs: { href: 'https://other.com/x', rel: 'NOFOLLOW' },
            }),
          ],
        }),
      ],
    })
    const { links } = extractFromDom(root, 'example.com')
    expect(links).toEqual([
      { href: '/about', text: 'about', internal: true },
      { href: 'https://other.com/x', text: 'ext', internal: false, rel: 'nofollow' },
    ])
  })

  it('extracts images with alt (and empty alt)', () => {
    const root = el('DIV', {
      children: [
        el('IMG', { attrs: { src: '/a.png', alt: 'A' } }),
        el('IMG', { attrs: { src: '/b.png' } }),
      ],
    })
    const { images } = extractFromDom(root)
    expect(images).toEqual([
      { src: '/a.png', alt: 'A' },
      { src: '/b.png', alt: '' },
    ])
  })

  it('does NOT double-record nested prose inside a prose block', () => {
    // A <p> containing an inline <strong> — textContent of <p> is the whole
    // sentence; we must record it ONCE, not also descend to re-emit.
    const root = el('DIV', {
      children: [
        el('P', {
          children: [el('STRONG', { text: 'bold start' })],
          text: 'bold start and the rest',
        }),
      ],
    })
    const { blocks } = extractFromDom(root)
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'bold start and the rest' }])
  })

  it('still harvests a link nested inside a prose paragraph', () => {
    const root = el('P', {
      text: 'See our guide for details.',
      children: [el('A', { text: 'guide', attrs: { href: '/guide' } })],
    })
    const { blocks, links } = extractFromDom(root, 'example.com')
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'See our guide for details.' }])
    expect(links).toEqual([{ href: '/guide', text: 'guide', internal: true }])
  })

  it('skips script/style/nav/aside subtrees', () => {
    const root = el('DIV', {
      children: [
        el('NAV', { children: [el('A', { text: 'home', attrs: { href: '/' } })] }),
        el('SCRIPT', { text: 'var x = 1' }),
        el('STYLE', { text: '.a{}' }),
        el('ASIDE', { children: [el('P', { text: 'sidebar' })] }),
        el('P', { text: 'real content' }),
      ],
    })
    const { blocks, links } = extractFromDom(root, 'example.com')
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'real content' }])
    expect(links).toEqual([]) // the nav link was skipped
  })

  it('handles a realistic article fragment end to end', () => {
    const root = el('ARTICLE', {
      children: [
        el('H1', { text: 'Guide' }),
        el('P', {
          text: 'Intro with a link inside.',
          children: [el('A', { text: 'link', attrs: { href: '/places' } })],
        }),
        el('FIGURE', {
          children: [el('IMG', { attrs: { src: '/uploads/x.webp', alt: 'photo' } })],
        }),
        el('UL', { children: [el('LI', { text: 'point a' })] }),
      ],
    })
    const { blocks, links, images } = extractFromDom(root, 'example.com')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Guide' },
      { kind: 'paragraph', text: 'Intro with a link inside.' },
      { kind: 'listitem', text: 'point a' },
    ])
    expect(links).toEqual([{ href: '/places', text: 'link', internal: true }])
    expect(images).toEqual([{ src: '/uploads/x.webp', alt: 'photo' }])
  })
})
