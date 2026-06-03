import { describe, it, expect } from 'vitest'
import { extractFromBlocks, flattenBlockTree, type BlockLike } from './blocks'

const b = (blockType: string, data: unknown, position?: number): BlockLike => ({
  blockType,
  data,
  ...(position !== undefined ? { position } : {}),
})

describe('extractFromBlocks', () => {
  it('returns empty for empty / non-array input', () => {
    expect(extractFromBlocks([])).toEqual({ blocks: [], links: [], images: [] })
    // @ts-expect-error — defensive against bad runtime input
    expect(extractFromBlocks(null)).toEqual({ blocks: [], links: [], images: [] })
  })

  it('maps lx_heading to a heading node with the right level', () => {
    const { blocks } = extractFromBlocks([
      b('lx_heading', { text: 'Welcome', level: 'h1' }),
      b('lx_heading', { text: 'Sub', level: 'h3' }),
      b('lx_heading', { text: 'Default level' }), // missing level → h2
    ])
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Welcome' },
      { kind: 'heading', level: 3, text: 'Sub' },
      { kind: 'heading', level: 2, text: 'Default level' },
    ])
  })

  it('maps lx_eyebrow to a paragraph', () => {
    const { blocks } = extractFromBlocks([b('lx_eyebrow', { text: 'Our Story' })])
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Our Story' }])
  })

  it('maps lx_text rich-text HTML into ordered prose + anchors + images', () => {
    const html =
      '<p>First para with <a href="/about" rel="nofollow">a link</a>.</p>' +
      '<ul><li>item one</li><li>item two</li></ul>' +
      '<h3>A subheading</h3>' +
      '<p>Closing thought with <img src="/uploads/x.png" alt="pic"> inline.</p>'
    const { blocks, links, images } = extractFromBlocks(
      [b('lx_text', { body_richtext: html })],
      'example.com',
    )
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'First para with a link.' },
      { kind: 'listitem', text: 'item one' },
      { kind: 'listitem', text: 'item two' },
      { kind: 'heading', level: 3, text: 'A subheading' },
      { kind: 'paragraph', text: 'Closing thought with inline.' },
    ])
    expect(links).toEqual([
      { href: '/about', text: 'a link', internal: true, rel: 'nofollow' },
    ])
    expect(images).toEqual([{ src: '/uploads/x.png', alt: 'pic' }])
  })

  it('treats loose inline HTML (no block tags) as a single paragraph', () => {
    const { blocks } = extractFromBlocks([
      b('lx_text', { body_richtext: 'just <strong>bold</strong> text' }),
    ])
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'just bold text' }])
  })

  it('decodes HTML entities in rich text', () => {
    const { blocks } = extractFromBlocks([
      b('lx_text', { body_richtext: '<p>Tom &amp; Jerry &lt;3 &#169;</p>' }),
    ])
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Tom & Jerry <3 ©' }])
  })

  it('excludes <pre> code from lx_text prose', () => {
    const html = '<p>Before.</p><pre><code>const x = 1</code></pre><p>After.</p>'
    const { blocks } = extractFromBlocks([b('lx_text', { body_richtext: html })])
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Before.' },
      { kind: 'paragraph', text: 'After.' },
    ])
  })

  it('maps lx_action to a link', () => {
    const { blocks, links } = extractFromBlocks(
      [b('lx_action', { label: 'Contact us', href: '/contact' })],
      'example.com',
    )
    expect(blocks).toEqual([])
    expect(links).toEqual([{ href: '/contact', text: 'Contact us', internal: true }])
  })

  it('maps lx_cta_banner heading/body + both CTAs', () => {
    const { blocks, links } = extractFromBlocks(
      [
        b('lx_cta_banner', {
          eyebrow: 'Ready?',
          title: 'Start today',
          body: 'It only takes a minute.',
          primaryCta: { label: 'Sign up', href: '/signup' },
          secondaryCta: { label: 'Learn more', href: 'https://ext.com/x' },
        }),
      ],
      'example.com',
    )
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Ready?' },
      { kind: 'heading', level: 2, text: 'Start today' },
      { kind: 'paragraph', text: 'It only takes a minute.' },
    ])
    expect(links).toEqual([
      { href: '/signup', text: 'Sign up', internal: true },
      { href: 'https://ext.com/x', text: 'Learn more', internal: false },
    ])
  })

  it('maps lx_figure to an image node (synthesized src from media_id, real alt)', () => {
    const { images } = extractFromBlocks([
      b('lx_figure', { image: { media_id: 42, alt: 'A sunset' } }),
    ])
    expect(images).toEqual([{ src: 'media:42', alt: 'A sunset' }])
  })

  it('maps lx_gallery to multiple image nodes', () => {
    const { images } = extractFromBlocks([
      b('lx_gallery', {
        images: [
          { media_id: 1, alt: 'one' },
          { media_id: 2, alt: '' },
        ],
      }),
    ])
    expect(images).toEqual([
      { src: 'media:1', alt: 'one' },
      { src: 'media:2', alt: '' },
    ])
  })

  it('maps lx_quote (rich-text quote) + attribution', () => {
    const { blocks } = extractFromBlocks([
      b('lx_quote', { quote: '<em>Less is more.</em>', attribution: 'Mies' }),
    ])
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Less is more.' },
      { kind: 'paragraph', text: 'Mies' },
    ])
  })

  it('maps lx_icon_list items to headings + bodies', () => {
    const { blocks } = extractFromBlocks([
      b('lx_icon_list', {
        items: [
          { icon: 'phone', headline: 'Call us', body: 'Mon-Fri' },
          { icon: 'mail', headline: 'Email us' },
        ],
      }),
    ])
    expect(blocks).toEqual([
      { kind: 'heading', level: 3, text: 'Call us' },
      { kind: 'paragraph', text: 'Mon-Fri' },
      { kind: 'heading', level: 3, text: 'Email us' },
    ])
  })

  it('maps lx_pricing_table features to list items + CTA link', () => {
    const { blocks, links } = extractFromBlocks(
      [
        b('lx_pricing_table', {
          planName: 'Pro',
          price: '$49',
          features: ['Feature A', 'Feature B'],
          ctaLabel: 'Buy Pro',
          ctaHref: '/buy/pro',
        }),
      ],
      'example.com',
    )
    expect(blocks).toEqual([
      { kind: 'heading', level: 3, text: 'Pro' },
      { kind: 'paragraph', text: '$49' },
      { kind: 'listitem', text: 'Feature A' },
      { kind: 'listitem', text: 'Feature B' },
    ])
    expect(links).toEqual([{ href: '/buy/pro', text: 'Buy Pro', internal: true }])
  })

  it('maps lx_accordion items (title + rich-text body)', () => {
    const { blocks } = extractFromBlocks([
      b('lx_accordion', {
        items: [
          { title: 'Q1', body_richtext: '<p>Answer one.</p>' },
          { title: 'Q2', body_richtext: '<p>Answer two.</p>' },
        ],
      }),
    ])
    expect(blocks).toEqual([
      { kind: 'heading', level: 3, text: 'Q1' },
      { kind: 'paragraph', text: 'Answer one.' },
      { kind: 'heading', level: 3, text: 'Q2' },
      { kind: 'paragraph', text: 'Answer two.' },
    ])
  })

  it('maps contact_form copy', () => {
    const { blocks } = extractFromBlocks([
      b('contact_form', {
        heading: 'Get in touch',
        intro: 'We reply fast.',
        submit_label: 'Send',
        success_headline: 'Thanks!',
      }),
    ])
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Get in touch' },
      { kind: 'paragraph', text: 'We reply fast.' },
      { kind: 'paragraph', text: 'Thanks!' },
    ])
  })

  it('maps lx_cover_image (image + overlay text + cta)', () => {
    const { blocks, links, images } = extractFromBlocks(
      [
        b('lx_cover_image', {
          image: { media_id: 7, alt: 'Hero' },
          eyebrow: 'Welcome',
          title: 'Our Estate',
          body: 'A place to belong.',
          cta: { label: 'Book a tour', href: '/tour' },
        }),
      ],
      'example.com',
    )
    expect(images).toEqual([{ src: 'media:7', alt: 'Hero' }])
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'Welcome' },
      { kind: 'heading', level: 1, text: 'Our Estate' },
      { kind: 'paragraph', text: 'A place to belong.' },
    ])
    expect(links).toEqual([{ href: '/tour', text: 'Book a tour', internal: true }])
  })

  it('maps lx_animated_headline (prefix + words + suffix)', () => {
    const { blocks } = extractFromBlocks([
      b('lx_animated_headline', {
        prefix: 'We build',
        words: ['homes', 'futures'],
        suffix: 'together',
        level: 'h2',
      }),
    ])
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'We build homes futures together' },
    ])
  })

  it('skips unknown block types gracefully (never throws)', () => {
    const { blocks, links, images } = extractFromBlocks([
      b('lx_heading', { text: 'Real', level: 'h2' }),
      b('totally_made_up_block', { whatever: true }),
      b('lx_eyebrow', { text: 'After' }),
    ])
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: 'Real' },
      { kind: 'paragraph', text: 'After' },
    ])
    expect(links).toEqual([])
    expect(images).toEqual([])
  })

  it('skips structural / chrome blocks (space, divider, code, video, map)', () => {
    const { blocks, links, images } = extractFromBlocks([
      b('lx_space', { size: 'section-md' }),
      b('lx_divider', { style: 'solid' }),
      b('lx_code', { code: 'const x = 1', language: 'ts' }),
      b('lx_video', { url: 'https://youtu.be/abcdefghijk' }),
      b('lx_map', { embedUrl: 'https://www.google.com/maps/embed?pb=x' }),
    ])
    expect(blocks).toEqual([])
    expect(links).toEqual([])
    expect(images).toEqual([])
  })

  it('tolerates malformed data shapes without throwing', () => {
    const { blocks } = extractFromBlocks([
      b('lx_heading', null),
      b('lx_heading', 'a string'),
      b('lx_icon_list', { items: 'not an array' }),
      b('lx_heading', { text: 'Survivor', level: 'h2' }),
    ])
    expect(blocks).toEqual([{ kind: 'heading', level: 2, text: 'Survivor' }])
  })

  it('honours explicit position ordering', () => {
    const { blocks } = extractFromBlocks([
      b('lx_eyebrow', { text: 'Third' }, 30),
      b('lx_eyebrow', { text: 'First' }, 10),
      b('lx_eyebrow', { text: 'Second' }, 20),
    ])
    expect(blocks.map((x) => 'text' in x && x.text)).toEqual(['First', 'Second', 'Third'])
  })

  it('walks a nested section/column tree in position order via flattenBlockTree', () => {
    const tree: BlockLike[] = [
      {
        blockType: 'section',
        data: {},
        position: 0,
        children: [
          {
            blockType: 'column',
            data: {},
            position: 0,
            children: [
              b('lx_heading', { text: 'Top', level: 'h1' }, 0),
              b('lx_text', { body_richtext: '<p>Body copy here.</p>' }, 1),
            ],
          },
        ],
      },
      {
        blockType: 'section',
        data: {},
        position: 1,
        children: [b('lx_action', { label: 'Go', href: '/go' }, 0)],
      },
    ]
    const { blocks, links } = flattenBlockTree(tree, 'example.com')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Top' },
      { kind: 'paragraph', text: 'Body copy here.' },
    ])
    expect(links).toEqual([{ href: '/go', text: 'Go', internal: true }])
  })
})
