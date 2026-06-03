import { describe, it, expect } from 'vitest'
import { extractFromMarkdown } from './markdown'

describe('extractFromMarkdown', () => {
  it('returns empty for empty / whitespace input', () => {
    expect(extractFromMarkdown('')).toEqual({ blocks: [], links: [], images: [] })
    expect(extractFromMarkdown('   \n  \n')).toEqual({
      blocks: [],
      links: [],
      images: [],
    })
  })

  it('parses ATX headings at every level (#..######)', () => {
    const md = `# H1
## H2
### H3
#### H4
##### H5
###### H6`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'H1' },
      { kind: 'heading', level: 2, text: 'H2' },
      { kind: 'heading', level: 3, text: 'H3' },
      { kind: 'heading', level: 4, text: 'H4' },
      { kind: 'heading', level: 5, text: 'H5' },
      { kind: 'heading', level: 6, text: 'H6' },
    ])
  })

  it('strips trailing closing hashes from ATX headings', () => {
    const { blocks } = extractFromMarkdown('## Title ##')
    expect(blocks).toEqual([{ kind: 'heading', level: 2, text: 'Title' }])
  })

  it('does not treat 7 hashes as a heading', () => {
    const { blocks } = extractFromMarkdown('####### not a heading')
    expect(blocks).toEqual([{ kind: 'paragraph', text: '####### not a heading' }])
  })

  it('coalesces soft-wrapped paragraph lines and splits on blank lines', () => {
    const md = `First line
second line.

Second paragraph.`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'First line second line.' },
      { kind: 'paragraph', text: 'Second paragraph.' },
    ])
  })

  it('parses bullet lists with -, *, and +', () => {
    const md = `- one
* two
+ three`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'listitem', text: 'one' },
      { kind: 'listitem', text: 'two' },
      { kind: 'listitem', text: 'three' },
    ])
  })

  it('parses ordered lists (1. and 1))', () => {
    const md = `1. first
2) second`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'listitem', text: 'first' },
      { kind: 'listitem', text: 'second' },
    ])
  })

  it('parses nested / indented list items as list items', () => {
    const md = `- parent
  - child
  - child two`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'listitem', text: 'parent' },
      { kind: 'listitem', text: 'child' },
      { kind: 'listitem', text: 'child two' },
    ])
  })

  it('strips GFM task-list checkboxes from items', () => {
    const md = `- [ ] todo
- [x] done`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'listitem', text: 'todo' },
      { kind: 'listitem', text: 'done' },
    ])
  })

  it('classifies internal vs external links by host', () => {
    const md = `See [about](/about) and [home](https://example.com/) and [ext](https://other.com/x).`
    const { links } = extractFromMarkdown(md, 'example.com')
    expect(links).toEqual([
      { href: '/about', text: 'about', internal: true },
      { href: 'https://example.com/', text: 'home', internal: true },
      { href: 'https://other.com/x', text: 'ext', internal: false },
    ])
  })

  it('treats www-prefixed same host as internal', () => {
    const { links } = extractFromMarkdown('[x](https://www.example.com/p)', 'example.com')
    expect(links[0]!.internal).toBe(true)
  })

  it('mailto / tel links are external (no site host)', () => {
    const { links } = extractFromMarkdown('[mail](mailto:a@b.com) [call](tel:+123)', 'example.com')
    expect(links.map((l) => l.internal)).toEqual([false, false])
  })

  it('relative links are internal even without siteHost', () => {
    const { links } = extractFromMarkdown('[a](about) [b](/deep/path) [c](#frag)')
    expect(links.map((l) => l.internal)).toEqual([true, true, true])
  })

  it('parses images with and without alt', () => {
    const md = `![a cat](/uploads/cat.png)

![](/uploads/noalt.png)`
    const { images } = extractFromMarkdown(md)
    expect(images).toEqual([
      { src: '/uploads/cat.png', alt: 'a cat' },
      { src: '/uploads/noalt.png', alt: '' },
    ])
  })

  it('does not mistake an image for a link', () => {
    const { links, images } = extractFromMarkdown('![alt](/img.png)')
    expect(links).toEqual([])
    expect(images).toEqual([{ src: '/img.png', alt: 'alt' }])
  })

  it('keeps link text (markdown-stripped) in the prose node', () => {
    const { blocks } = extractFromMarkdown('Read [our **guide**](/guide) now.')
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Read our guide now.' }])
  })

  it('excludes fenced code blocks from prose AND from link harvesting', () => {
    const md = `Intro paragraph.

\`\`\`js
const x = [1](2)
const link = "[not a link](nope)"
\`\`\`

Outro paragraph.`
    const { blocks, links } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Intro paragraph.' },
      { kind: 'paragraph', text: 'Outro paragraph.' },
    ])
    expect(links).toEqual([])
  })

  it('excludes tilde-fenced code blocks too', () => {
    const md = `Before.

~~~
code [x](y)
~~~

After.`
    const { blocks, links } = extractFromMarkdown(md)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'paragraph'])
    expect(links).toEqual([])
  })

  it('excludes indented code blocks from prose', () => {
    const md = `Para one.

    indented code line

Para two.`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Para one.' },
      { kind: 'paragraph', text: 'Para two.' },
    ])
  })

  it('strips inline code, bold, italic, strikethrough from prose', () => {
    const { blocks } = extractFromMarkdown(
      'Use `npm` to **install** the _package_ and ~~remove~~ it.',
    )
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Use npm to install the package and remove it.' },
    ])
  })

  it('unwraps blockquotes into prose', () => {
    const md = `> Quoted wisdom
> across two lines.`
    const { blocks } = extractFromMarkdown(md)
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Quoted wisdom across two lines.' },
    ])
  })

  it('captures autolinks <https://...> and <mailto:...>', () => {
    const { links } = extractFromMarkdown('Visit <https://example.com/x> or <mailto:a@b.com>.', 'example.com')
    expect(links).toEqual([
      { href: 'https://example.com/x', text: 'https://example.com/x', internal: true },
      { href: 'mailto:a@b.com', text: 'mailto:a@b.com', internal: false },
    ])
  })

  it('harvests a link that lives inside a heading', () => {
    const { blocks, links } = extractFromMarkdown('## See [docs](/docs)', 'example.com')
    expect(blocks).toEqual([{ kind: 'heading', level: 2, text: 'See docs' }])
    expect(links).toEqual([{ href: '/docs', text: 'docs', internal: true }])
  })

  it('handles angle-bracket-wrapped link destinations', () => {
    const { links } = extractFromMarkdown('[x](<https://example.com/a b>)', 'example.com')
    expect(links).toEqual([
      { href: 'https://example.com/a b', text: 'x', internal: true },
    ])
  })

  it('ignores link titles in the destination', () => {
    const { links } = extractFromMarkdown('[x](/p "the title")')
    expect(links).toEqual([{ href: '/p', text: 'x', internal: true }])
  })

  it('handles a realistic blog post end to end', () => {
    const md = `# Coastal Living Guide

An intro paragraph about the coast with a [local link](/places) inside.

## Why the coast

- fresh air
- great food

Check the [map](https://maps.example.com) externally.

![Sunset over the bay](/uploads/originals/sunset.webp)`
    const { blocks, links, images } = extractFromMarkdown(md, 'example.com')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Coastal Living Guide' },
      { kind: 'paragraph', text: 'An intro paragraph about the coast with a local link inside.' },
      { kind: 'heading', level: 2, text: 'Why the coast' },
      { kind: 'listitem', text: 'fresh air' },
      { kind: 'listitem', text: 'great food' },
      { kind: 'paragraph', text: 'Check the map externally.' },
    ])
    expect(links).toEqual([
      { href: '/places', text: 'local link', internal: true },
      { href: 'https://maps.example.com', text: 'map', internal: false },
    ])
    expect(images).toEqual([
      { src: '/uploads/originals/sunset.webp', alt: 'Sunset over the bay' },
    ])
  })
})
