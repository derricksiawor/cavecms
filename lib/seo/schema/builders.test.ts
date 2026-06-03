import { describe, it, expect } from 'vitest'
import { safeJsonForScript } from '@/lib/seo/escape'
import {
  articleLd,
  faqPageLd,
  howToLd,
  productLd,
  softwareApplicationLd,
  webPageLd,
  websiteLd,
  breadcrumbListLd,
  organizationRefLd,
} from './builders'

// Helper: round-trip a JSON-LD object through the production XSS-safe
// serializer and back, asserting it survives byte-clean. Every builder's
// output must be safe to inline via dangerouslySetInnerHTML.
function roundTrip(obj: unknown): unknown {
  const serialized = safeJsonForScript(obj)
  // The serializer escapes `<` → < etc, but JSON.parse reverses
  // those escapes, so a clean object round-trips identically.
  return JSON.parse(serialized)
}

describe('articleLd', () => {
  it('defaults to Article and emits required props', () => {
    const ld = articleLd({
      headline: 'Hello World',
      author: 'Jane Doe',
      datePublished: '2026-01-01T00:00:00.000Z',
    })
    expect(ld['@context']).toBe('https://schema.org')
    expect(ld['@type']).toBe('Article')
    expect(ld.headline).toBe('Hello World')
    expect(ld.author).toEqual({ '@type': 'Person', name: 'Jane Doe' })
    expect(ld.datePublished).toBe('2026-01-01T00:00:00.000Z')
  })

  it('honours the type param (BlogPosting / NewsArticle)', () => {
    expect(
      articleLd({ type: 'BlogPosting', headline: 'h', author: 'a', datePublished: '2026-01-01' })[
        '@type'
      ],
    ).toBe('BlogPosting')
    expect(
      articleLd({ type: 'NewsArticle', headline: 'h', author: 'a', datePublished: '2026-01-01' })[
        '@type'
      ],
    ).toBe('NewsArticle')
  })

  it('converts a Date to ISO 8601', () => {
    const ld = articleLd({
      headline: 'h',
      author: 'a',
      datePublished: new Date('2026-03-04T05:06:07.000Z'),
      dateModified: new Date('2026-03-05T00:00:00.000Z'),
    })
    expect(ld.datePublished).toBe('2026-03-04T05:06:07.000Z')
    expect(ld.dateModified).toBe('2026-03-05T00:00:00.000Z')
  })

  it('wraps mainEntityOfPage as a WebPage @id and publisher as Organization ref', () => {
    const ld = articleLd({
      headline: 'h',
      author: 'a',
      datePublished: '2026-01-01',
      mainEntityOfPage: 'https://x.com/blog/h',
      publisher: { name: 'Acme', logo: '/logo.svg', url: 'https://x.com' },
    })
    expect(ld.mainEntityOfPage).toEqual({
      '@type': 'WebPage',
      '@id': 'https://x.com/blog/h',
    })
    expect(ld.publisher).toEqual({
      '@type': 'Organization',
      name: 'Acme',
      url: 'https://x.com',
      logo: { '@type': 'ImageObject', url: '/logo.svg' },
    })
  })

  it('omits undefined optional fields (no null-y noise)', () => {
    const ld = articleLd({ headline: 'h', author: 'a', datePublished: '2026-01-01' })
    expect('description' in ld).toBe(false)
    expect('dateModified' in ld).toBe(false)
    expect('image' in ld).toBe(false)
    expect('mainEntityOfPage' in ld).toBe(false)
    expect('publisher' in ld).toBe(false)
    // And nothing serializes to null
    expect(safeJsonForScript(ld)).not.toContain('null')
  })

  it('normalises a multi-image array, collapses single to string, drops empties', () => {
    expect(articleLd({ headline: 'h', author: 'a', datePublished: 'd', image: ['/a.jpg', '/b.jpg'] }).image).toEqual(['/a.jpg', '/b.jpg'])
    expect(articleLd({ headline: 'h', author: 'a', datePublished: 'd', image: ['/only.jpg'] }).image).toBe('/only.jpg')
    expect('image' in articleLd({ headline: 'h', author: 'a', datePublished: 'd', image: ['  ', ''] })).toBe(false)
  })

  it('survives safeJsonForScript with a </script> headline', () => {
    const ld = articleLd({
      headline: 'Evil</script><img src=x>',
      author: 'a',
      datePublished: '2026-01-01',
    })
    const serialized = safeJsonForScript(ld)
    expect(serialized).not.toContain('</script')
    expect(serialized).toContain('\\u003c/script')
    const parsed = roundTrip(ld) as Record<string, unknown>
    expect(parsed.headline).toBe('Evil</script><img src=x>')
  })
})

describe('faqPageLd', () => {
  it('builds FAQPage with mainEntity Question/acceptedAnswer', () => {
    const ld = faqPageLd([
      { question: 'What is X?', answer: 'X is Y.' },
      { question: 'How?', answer: 'Like so.' },
    ])!
    expect(ld['@type']).toBe('FAQPage')
    const main = ld.mainEntity as Array<Record<string, unknown>>
    expect(main).toHaveLength(2)
    expect(main[0]).toEqual({
      '@type': 'Question',
      name: 'What is X?',
      acceptedAnswer: { '@type': 'Answer', text: 'X is Y.' },
    })
    expect(main[1]!.name).toBe('How?')
  })

  it('round-trips representative data through safeJsonForScript', () => {
    const ld = faqPageLd([{ question: 'Q1', answer: 'A1' }])!
    const parsed = roundTrip(ld) as Record<string, unknown>
    const main = (parsed.mainEntity as Array<Record<string, unknown>>)[0]!
    expect((main.acceptedAnswer as Record<string, unknown>).text).toBe('A1')
  })

  it('returns null for an empty item list (invalid empty FAQPage) — Fix 4', () => {
    expect(faqPageLd([])).toBeNull()
  })
})

describe('howToLd', () => {
  it('builds HowTo with positioned HowToStep list', () => {
    const ld = howToLd({
      name: 'Make tea',
      description: 'Steeping guide',
      totalTime: 'PT5M',
      supply: ['tea bag', 'water'],
      tool: ['kettle'],
      steps: [
        { name: 'Boil', text: 'Boil the water.' },
        { name: 'Steep', text: 'Steep 3 min.', url: '/steep', image: '/steep.jpg' },
      ],
    })
    expect(ld['@type']).toBe('HowTo')
    expect(ld.name).toBe('Make tea')
    expect(ld.totalTime).toBe('PT5M')
    expect(ld.supply).toEqual([
      { '@type': 'HowToSupply', name: 'tea bag' },
      { '@type': 'HowToSupply', name: 'water' },
    ])
    expect(ld.tool).toEqual([{ '@type': 'HowToTool', name: 'kettle' }])
    const steps = ld.step as Array<Record<string, unknown>>
    expect(steps[0]).toEqual({ '@type': 'HowToStep', position: 1, name: 'Boil', text: 'Boil the water.' })
    expect(steps[1]!.position).toBe(2)
    expect(steps[1]!.url).toBe('/steep')
  })

  it('omits optional totalTime/supply/tool when absent', () => {
    const ld = howToLd({ name: 'X', steps: [{ name: 's', text: 't' }] })
    expect('totalTime' in ld).toBe(false)
    expect('supply' in ld).toBe(false)
    expect('tool' in ld).toBe(false)
    expect(safeJsonForScript(ld)).not.toContain('null')
  })

  it('drops empty supply/tool arrays entirely', () => {
    const ld = howToLd({ name: 'X', supply: ['  ', ''], tool: [], steps: [{ name: 's', text: 't' }] })
    expect('supply' in ld).toBe(false)
    expect('tool' in ld).toBe(false)
  })
})

describe('productLd', () => {
  it('builds Product with brand + Offer + AggregateRating', () => {
    const ld = productLd({
      name: 'Widget',
      description: 'A fine widget',
      image: '/w.jpg',
      brand: 'Acme',
      offers: { price: 19.99, priceCurrency: 'usd', availability: 'InStock', url: '/buy' },
      aggregateRating: { ratingValue: 4.5, reviewCount: 120 },
    })
    expect(ld['@type']).toBe('Product')
    expect(ld.brand).toEqual({ '@type': 'Brand', name: 'Acme' })
    expect(ld.offers).toEqual({
      '@type': 'Offer',
      price: '19.99',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url: '/buy',
    })
    expect(ld.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.5,
      reviewCount: 120,
    })
  })

  it('omits aggregateRating + offers when absent', () => {
    const ld = productLd({ name: 'Bare' })
    expect('offers' in ld).toBe(false)
    expect('aggregateRating' in ld).toBe(false)
    expect('brand' in ld).toBe(false)
    expect(safeJsonForScript(ld)).not.toContain('null')
  })

  it('passes a full availability URL through untouched', () => {
    const ld = productLd({
      name: 'X',
      offers: { price: 1, priceCurrency: 'EUR', availability: 'https://schema.org/PreOrder' },
    })
    expect((ld.offers as Record<string, unknown>).availability).toBe('https://schema.org/PreOrder')
  })

  it('tightens the availability URL test — "httptypo://x" is normalised, not passed through (Fix 7)', () => {
    const ld = productLd({
      name: 'X',
      offers: { price: 1, priceCurrency: 'USD', availability: 'httptypo://x' },
    })
    // The bogus scheme is treated as a bare token → normalised under schema.org.
    expect((ld.offers as Record<string, unknown>).availability).toBe(
      'https://schema.org/httptypo://x',
    )
  })

  it('does NOT throw on malformed offers (offers: 5) — just omits (Fix 6)', () => {
    let ld!: Record<string, unknown>
    expect(() => {
      ld = productLd({ name: 'X', offers: 5 as never })
    }).not.toThrow()
    expect('offers' in ld).toBe(false)
  })

  it('omits an offer missing price or currency (Fix 6)', () => {
    const noCurrency = productLd({ name: 'X', offers: { price: 9 } as never })
    expect('offers' in noCurrency).toBe(false)
    const noPrice = productLd({ name: 'X', offers: { priceCurrency: 'USD' } as never })
    expect('offers' in noPrice).toBe(false)
  })

  it('omits a malformed aggregateRating (no ratingValue) without throwing (Fix 6)', () => {
    let ld!: Record<string, unknown>
    expect(() => {
      ld = productLd({ name: 'X', aggregateRating: { reviewCount: 3 } as never })
    }).not.toThrow()
    expect('aggregateRating' in ld).toBe(false)
  })

  it('round-trips through safeJsonForScript', () => {
    const ld = productLd({
      name: 'Widget',
      offers: { price: '9.00', priceCurrency: 'GBP', availability: 'OutOfStock' },
      aggregateRating: { ratingValue: '3.8', ratingCount: 7 },
    })
    const parsed = roundTrip(ld) as Record<string, unknown>
    expect((parsed.offers as Record<string, unknown>).availability).toBe('https://schema.org/OutOfStock')
    expect((parsed.aggregateRating as Record<string, unknown>).ratingCount).toBe(7)
  })
})

describe('softwareApplicationLd', () => {
  it('builds SoftwareApplication with category + OS + offers + rating', () => {
    const ld = softwareApplicationLd({
      name: 'CaveCMS',
      applicationCategory: 'WebApplication',
      operatingSystem: 'Web',
      offers: { price: 0, priceCurrency: 'USD' },
      aggregateRating: { ratingValue: 5, reviewCount: 3 },
    })
    expect(ld['@type']).toBe('SoftwareApplication')
    expect(ld.applicationCategory).toBe('WebApplication')
    expect(ld.operatingSystem).toBe('Web')
    expect((ld.offers as Record<string, unknown>).price).toBe('0')
    expect((ld.aggregateRating as Record<string, unknown>).ratingValue).toBe(5)
  })

  it('omits optional fields when absent and round-trips clean', () => {
    const ld = softwareApplicationLd({ name: 'App' })
    expect('applicationCategory' in ld).toBe(false)
    expect('operatingSystem' in ld).toBe(false)
    expect('offers' in ld).toBe(false)
    expect('aggregateRating' in ld).toBe(false)
    expect(roundTrip(ld)).toEqual({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'App' })
  })
})

describe('webPageLd', () => {
  it('builds WebPage with inLanguage default and url', () => {
    const ld = webPageLd({ name: 'About', description: 'about us', url: 'https://x.com/about' })
    expect(ld['@type']).toBe('WebPage')
    expect(ld.inLanguage).toBe('en')
    expect(ld.url).toBe('https://x.com/about')
  })

  it('honours an overriding @type (AboutPage) — aligns with page-jsonld.ts', () => {
    const ld = webPageLd({ type: 'AboutPage', name: 'About' })
    expect(ld['@type']).toBe('AboutPage')
  })

  it('omits url + description when absent', () => {
    const ld = webPageLd({ name: 'Bare' })
    expect('url' in ld).toBe(false)
    expect('description' in ld).toBe(false)
  })
})

describe('websiteLd', () => {
  it('builds a bare WebSite with no potentialAction by default', () => {
    const ld = websiteLd({ name: 'My Site', url: 'https://x.com' })
    expect(ld['@type']).toBe('WebSite')
    expect('potentialAction' in ld).toBe(false)
  })

  it('emits a SearchAction sitelinks-searchbox when enabled', () => {
    const ld = websiteLd({
      name: 'My Site',
      url: 'https://x.com',
      searchUrlTemplate: 'https://x.com/search?q={search_term_string}',
    })
    expect(ld.potentialAction).toEqual({
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: 'https://x.com/search?q={search_term_string}',
      },
      'query-input': 'required name=search_term_string',
    })
  })

  it('round-trips with the {search_term_string} placeholder intact', () => {
    const ld = websiteLd({
      name: 'S',
      searchUrlTemplate: 'https://x.com/s?q={search_term_string}',
    })
    const parsed = roundTrip(ld) as Record<string, unknown>
    const pa = parsed.potentialAction as Record<string, unknown>
    expect((pa.target as Record<string, unknown>).urlTemplate).toContain('{search_term_string}')
  })
})

describe('breadcrumbListLd', () => {
  it('emits 1-indexed sequential ListItem positions', () => {
    const ld = breadcrumbListLd([
      { name: 'Home', url: '/' },
      { name: 'Blog', url: '/blog' },
      { name: 'Post', url: '/blog/post' },
    ])!
    expect(ld['@type']).toBe('BreadcrumbList')
    const items = ld.itemListElement as Array<Record<string, unknown>>
    expect(items.map((i) => i.position)).toEqual([1, 2, 3])
    expect(items[0]).toEqual({ '@type': 'ListItem', position: 1, name: 'Home', item: '/' })
    expect(items[2]!.item).toBe('/blog/post')
  })

  it('matches the legacy breadcrumbLd output shape (canonical rename)', () => {
    // Asserts the rename is byte-compatible with lib/seo/jsonLd.ts:breadcrumbLd.
    const ld = breadcrumbListLd([{ name: 'A', url: '/a' }, { name: 'B', url: '/b' }])
    expect(ld).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'A', item: '/a' },
        { '@type': 'ListItem', position: 2, name: 'B', item: '/b' },
      ],
    })
  })

  it('returns null for an empty trail (invalid empty BreadcrumbList) — Fix 4', () => {
    expect(breadcrumbListLd([])).toBeNull()
  })

  it('returns null for a single-item trail (a breadcrumb of one is noise) — Fix 4', () => {
    expect(breadcrumbListLd([{ name: 'Home', url: '/' }])).toBeNull()
  })

  it('returns a valid list for 2+ items — Fix 4', () => {
    const ld = breadcrumbListLd([
      { name: 'Home', url: '/' },
      { name: 'Blog', url: '/blog' },
    ])
    expect(ld).not.toBeNull()
    expect(ld!['@type']).toBe('BreadcrumbList')
    expect((ld!.itemListElement as unknown[]).length).toBe(2)
  })
})

describe('organizationRefLd', () => {
  it('wraps logo as an ImageObject and omits url/logo when absent', () => {
    expect(organizationRefLd({ name: 'Acme' })).toEqual({ '@type': 'Organization', name: 'Acme' })
    expect(organizationRefLd({ name: 'Acme', logo: '/l.svg' }).logo).toEqual({
      '@type': 'ImageObject',
      url: '/l.svg',
    })
  })

  it('is NOT a standalone graph node (no @context — it is a ref)', () => {
    // Publisher/brand refs must NOT carry @context; only top-level graph
    // nodes do. This guards against accidental Organization double-emit.
    expect('@context' in organizationRefLd({ name: 'Acme' })).toBe(false)
  })
})
