import { describe, it, expect } from 'vitest'
import { safeJsonForScript } from '@/lib/seo/escape'
import {
  schemaForEntity,
  extraSchemaForEntity,
  type EntityCore,
} from './forPage'

const basePage: EntityCore = {
  kind: 'page',
  title: 'About Us',
  description: 'Who we are',
  url: 'https://x.com/about',
}

const basePost: EntityCore = {
  kind: 'post',
  title: 'Hello',
  description: 'first post',
  url: 'https://x.com/blog/hello',
  datePublished: '2026-01-01T00:00:00.000Z',
  author: 'Jane',
}

// No top-level Organization should ever be produced — that's the
// layout's job; this asserts the no-double-emit invariant.
function assertNoTopLevelOrganization(graph: Array<Record<string, unknown>>) {
  for (const node of graph) {
    expect(node['@type']).not.toBe('Organization')
  }
}

describe('schemaForEntity — fallback (no override)', () => {
  it('a page with no override → [WebPage]', () => {
    const g = schemaForEntity({ entity: basePage })
    expect(g).toHaveLength(1)
    expect(g[0]!['@type']).toBe('WebPage')
    expect(g[0]!.name).toBe('About Us')
    expect(g[0]!.url).toBe('https://x.com/about')
  })

  it('uses webPageType when supplied (AboutPage)', () => {
    const g = schemaForEntity({ entity: { ...basePage, webPageType: 'AboutPage' } })
    expect(g[0]!['@type']).toBe('AboutPage')
  })

  it('a post with no override → [Article] defaulting to BlogPosting', () => {
    const g = schemaForEntity({ entity: basePost })
    expect(g[0]!['@type']).toBe('BlogPosting')
    expect(g[0]!.headline).toBe('Hello')
    expect(g[0]!.author).toEqual({ '@type': 'Person', name: 'Jane' })
  })

  it('a project with no override → [WebPage] (project is not inherently a Product)', () => {
    const g = schemaForEntity({ entity: { kind: 'project', title: 'P', url: '/p' } })
    expect(g[0]!['@type']).toBe('WebPage')
  })
})

describe('schemaForEntity — type default from seo_schema', () => {
  it('post articleType=NewsArticle default is honoured', () => {
    const g = schemaForEntity({ entity: basePost, defaults: { articleType: 'NewsArticle' } })
    expect(g[0]!['@type']).toBe('NewsArticle')
  })

  it('post articleType default does NOT override an explicit per-page schemaType', () => {
    const g = schemaForEntity({
      entity: basePost,
      override: { schemaType: 'Article' },
      defaults: { articleType: 'NewsArticle' },
    })
    expect(g[0]!['@type']).toBe('Article')
  })
})

describe('schemaForEntity — per-page override wins', () => {
  it('override schemaType=Product on a page produces Product fed by schemaData', () => {
    const g = schemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'Product',
        schemaData: {
          name: 'Pro Plan',
          offers: { price: 49, priceCurrency: 'usd', availability: 'InStock' },
          aggregateRating: { ratingValue: 4.8, reviewCount: 50 },
        },
      },
    })
    expect(g[0]!['@type']).toBe('Product')
    expect(g[0]!.name).toBe('Pro Plan')
    expect((g[0]!.offers as Record<string, unknown>).priceCurrency).toBe('USD')
    expect((g[0]!.offers as Record<string, unknown>).availability).toBe('https://schema.org/InStock')
  })

  it('override schemaType=FAQPage only emits FAQ when items present; falls back to WebPage otherwise', () => {
    const withItems = schemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'FAQPage',
        schemaData: { items: [{ question: 'Q', answer: 'A' }] },
      },
    })
    expect(withItems[0]!['@type']).toBe('FAQPage')
    expect((withItems[0]!.mainEntity as unknown[])).toHaveLength(1)

    const noItems = schemaForEntity({
      entity: basePage,
      override: { schemaType: 'FAQPage', schemaData: {} },
    })
    // FAQ with zero usable items is meaningless → fall back to WebPage.
    expect(noItems[0]!['@type']).toBe('WebPage')
  })

  it('FAQ accepts both {items} and {faqs} + {q,a} aliases', () => {
    const g = schemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'FAQPage',
        schemaData: { faqs: [{ q: 'Question?', a: 'Answer.' }] },
      },
    })
    expect(g[0]!['@type']).toBe('FAQPage')
    const main = (g[0]!.mainEntity as Array<Record<string, unknown>>)[0]!
    expect(main.name).toBe('Question?')
  })

  it('override schemaType=HowTo only emits HowTo when steps present', () => {
    const withSteps = schemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'HowTo',
        schemaData: { name: 'Setup', steps: [{ name: 'Install', text: 'Run npx.' }] },
      },
    })
    expect(withSteps[0]!['@type']).toBe('HowTo')
    expect((withSteps[0]!.step as unknown[])).toHaveLength(1)

    const noSteps = schemaForEntity({
      entity: basePage,
      override: { schemaType: 'HowTo', schemaData: {} },
    })
    expect(noSteps[0]!['@type']).toBe('WebPage')
  })

  it('override schemaType=SoftwareApplication produces SoftwareApplication', () => {
    const g = schemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'SoftwareApplication',
        schemaData: {
          name: 'CaveCMS',
          applicationCategory: 'WebApplication',
          operatingSystem: 'Web',
        },
      },
    })
    expect(g[0]!['@type']).toBe('SoftwareApplication')
    expect(g[0]!.operatingSystem).toBe('Web')
  })

  it('override falls back to entity intrinsic fields when schemaData omits them', () => {
    const g = schemaForEntity({
      entity: { ...basePost, image: '/hero.jpg', publisher: { name: 'Acme', logo: '/l.svg' } },
      override: { schemaType: 'Article', schemaData: {} },
    })
    expect(g[0]!.headline).toBe('Hello') // from entity.title
    expect(g[0]!.image).toBe('/hero.jpg') // from entity.image
    expect((g[0]!.publisher as Record<string, unknown>).name).toBe('Acme')
    expect(g[0]!.mainEntityOfPage).toEqual({ '@type': 'WebPage', '@id': 'https://x.com/blog/hello' })
  })

  it('override schemaType=WebPage explicitly produces WebPage', () => {
    const g = schemaForEntity({ entity: basePost, override: { schemaType: 'WebPage' } })
    expect(g[0]!['@type']).toBe('WebPage')
  })
})

describe('schemaForEntity — breadcrumbs', () => {
  const crumbs = [
    { name: 'Home', url: '/' },
    { name: 'Blog', url: '/blog' },
    { name: 'Post', url: '/blog/hello' },
  ]

  it('appends a BreadcrumbList when ≥2 crumbs and enabled (default)', () => {
    const g = schemaForEntity({ entity: basePost, breadcrumbs: crumbs })
    expect(g).toHaveLength(2)
    expect(g[1]!['@type']).toBe('BreadcrumbList')
    const items = g[1]!.itemListElement as Array<Record<string, unknown>>
    expect(items.map((i) => i.position)).toEqual([1, 2, 3])
  })

  it('order is [primary, BreadcrumbList]', () => {
    const g = schemaForEntity({ entity: basePost, breadcrumbs: crumbs })
    expect(g[0]!['@type']).toBe('BlogPosting')
    expect(g[1]!['@type']).toBe('BreadcrumbList')
  })

  it('skips breadcrumbs when breadcrumbsEnabled is false', () => {
    const g = schemaForEntity({
      entity: basePost,
      breadcrumbs: crumbs,
      defaults: { breadcrumbsEnabled: false },
    })
    expect(g).toHaveLength(1)
  })

  it('skips a single-crumb (or empty) trail as noise', () => {
    expect(schemaForEntity({ entity: basePost, breadcrumbs: [{ name: 'Home', url: '/' }] })).toHaveLength(1)
    expect(schemaForEntity({ entity: basePost, breadcrumbs: [] })).toHaveLength(1)
  })
})

describe('schemaForEntity — no Organization double-emit', () => {
  it('never emits a top-level Organization, even with entityType=Organization default', () => {
    const variants = [
      schemaForEntity({ entity: basePage, defaults: { entityType: 'Organization' } }),
      schemaForEntity({ entity: basePost, defaults: { entityType: 'Organization', articleType: 'Article' } }),
      schemaForEntity({
        entity: basePage,
        override: { schemaType: 'Product', schemaData: { name: 'X' } },
        defaults: { entityType: 'Organization' },
      }),
    ]
    for (const g of variants) assertNoTopLevelOrganization(g as Array<Record<string, unknown>>)
  })

  it('Article publisher ref is a nested Organization ref (no @context), not a graph node', () => {
    const g = schemaForEntity({
      entity: { ...basePost, publisher: { name: 'Acme' } },
    })
    const publisher = g[0]!.publisher as Record<string, unknown>
    expect(publisher['@type']).toBe('Organization')
    expect('@context' in publisher).toBe(false)
  })
})

describe('schemaForEntity — malformed operator schemaData is tolerated (Fix 6)', () => {
  it('Product with offers:5 + aggregateRating:"x" does not throw, just omits them', () => {
    let g!: Array<Record<string, unknown>>
    expect(() => {
      g = schemaForEntity({
        entity: basePage,
        override: {
          schemaType: 'Product',
          schemaData: {
            name: 'Plan',
            offers: 5,
            aggregateRating: 'x',
            image: 42, // bogus → omitted, no entity image either
          },
        },
      }) as Array<Record<string, unknown>>
    }).not.toThrow()
    expect(g[0]!['@type']).toBe('Product')
    expect('offers' in g[0]!).toBe(false)
    expect('aggregateRating' in g[0]!).toBe(false)
    expect('image' in g[0]!).toBe(false)
  })

  it('HowTo with supply:"x" (non-array) does not throw and omits supply', () => {
    let g!: Array<Record<string, unknown>>
    expect(() => {
      g = schemaForEntity({
        entity: basePage,
        override: {
          schemaType: 'HowTo',
          schemaData: {
            name: 'Setup',
            supply: 'x', // non-array → omitted
            tool: [42, ''], // no usable strings → omitted
            steps: [{ name: 'Install', text: 'Run it.' }],
          },
        },
      }) as Array<Record<string, unknown>>
    }).not.toThrow()
    expect(g[0]!['@type']).toBe('HowTo')
    expect('supply' in g[0]!).toBe(false)
    expect('tool' in g[0]!).toBe(false)
  })

  it('Article with publisher:5 + datePublished:99 falls back to entity/defaults, no throw', () => {
    let g!: Array<Record<string, unknown>>
    expect(() => {
      g = schemaForEntity({
        entity: { ...basePost, publisher: { name: 'Acme' } },
        override: {
          schemaType: 'Article',
          schemaData: { publisher: 5, datePublished: 99, image: { bad: true } },
        },
      }) as Array<Record<string, unknown>>
    }).not.toThrow()
    expect(g[0]!['@type']).toBe('Article')
    // publisher fell back to the entity's valid ref
    expect((g[0]!.publisher as Record<string, unknown>).name).toBe('Acme')
    // datePublished fell back to the entity's ISO date
    expect(g[0]!.datePublished).toBe('2026-01-01T00:00:00.000Z')
  })
})

// ─────────────────────────────────────────────────────────────────────
// extraSchemaForEntity — ADDITIONS-ONLY contract (JSON-LD double-emission
// fix). The per-page routes already emit a legacy PRIMARY node
// (blogPostingLd / residenceLd / jsonLdForPage); this helper must add ONLY
// (a) the explicit per-page override shape (when schemaType set) and (b)
// the BreadcrumbList — and NEVER a default WebPage/Article primary.
// ─────────────────────────────────────────────────────────────────────
describe('extraSchemaForEntity — additions-only (no default primary)', () => {
  const crumbs = [
    { name: 'Home', url: '/' },
    { name: 'Blog', url: '/blog' },
    { name: 'Post', url: '/blog/hello' },
  ]

  it('schemaType UNSET → NO WebPage/Article, returns []', () => {
    expect(extraSchemaForEntity({ entity: basePage })).toEqual([])
    // A post would normally default to BlogPosting in schemaForEntity —
    // the additions-only path must NOT emit that primary.
    expect(extraSchemaForEntity({ entity: basePost })).toEqual([])
  })

  it('schemaType UNSET, entity-kind default DOES NOT leak in', () => {
    // Even with an articleType default set, no primary is produced.
    const g = extraSchemaForEntity({
      entity: basePost,
      defaults: { articleType: 'NewsArticle' },
    })
    expect(g).toEqual([])
  })

  it('schemaType UNSET + ≥2 crumbs → ONLY the BreadcrumbList', () => {
    const g = extraSchemaForEntity({ entity: basePost, breadcrumbs: crumbs })
    expect(g).toHaveLength(1)
    expect(g[0]!['@type']).toBe('BreadcrumbList')
  })

  it('schemaType UNSET + single-crumb (or empty) trail → []', () => {
    expect(
      extraSchemaForEntity({ entity: basePost, breadcrumbs: [{ name: 'Home', url: '/' }] }),
    ).toEqual([])
    expect(extraSchemaForEntity({ entity: basePost, breadcrumbs: [] })).toEqual([])
  })

  it('schemaType SET → emits the OVERRIDE shape (not a default), order [override, breadcrumbs]', () => {
    const g = extraSchemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'FAQPage',
        schemaData: { items: [{ question: 'Q', answer: 'A' }] },
      },
      breadcrumbs: crumbs,
    })
    expect(g).toHaveLength(2)
    expect(g[0]!['@type']).toBe('FAQPage')
    expect(g[1]!['@type']).toBe('BreadcrumbList')
  })

  it('schemaType=Product override emits Product fed by schemaData, no default WebPage', () => {
    const g = extraSchemaForEntity({
      entity: basePage,
      override: {
        schemaType: 'Product',
        schemaData: { name: 'Pro Plan', offers: { price: 49, priceCurrency: 'usd' } },
      },
    })
    expect(g).toHaveLength(1)
    expect(g[0]!['@type']).toBe('Product')
    expect(g[0]!.name).toBe('Pro Plan')
  })

  it('schemaType=Article on a post emits the override Article (not the BlogPosting default)', () => {
    const g = extraSchemaForEntity({
      entity: basePost,
      override: { schemaType: 'Article' },
    })
    expect(g).toHaveLength(1)
    expect(g[0]!['@type']).toBe('Article')
  })

  it('breadcrumbsEnabled=false suppresses the breadcrumb even with an override', () => {
    const g = extraSchemaForEntity({
      entity: basePage,
      override: { schemaType: 'WebPage' },
      breadcrumbs: crumbs,
      defaults: { breadcrumbsEnabled: false },
    })
    expect(g).toHaveLength(1)
    expect(g[0]!['@type']).toBe('WebPage')
  })

  it('never emits a top-level Organization', () => {
    assertNoTopLevelOrganization(
      extraSchemaForEntity({
        entity: basePost,
        override: { schemaType: 'Article' },
        defaults: { entityType: 'Organization' },
        breadcrumbs: crumbs,
      }) as Array<Record<string, unknown>>,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Fix 3 — FAQ/HowTo schemaData arrays are SLICED to a max so the emitted
// JSON-LD can't balloon when an operator (or a tampered cell) supplies an
// oversized array. The editor caps at 50; the renderer enforces the same.
// ─────────────────────────────────────────────────────────────────────
describe('forPage — FAQ/HowTo node is bounded (Fix 3)', () => {
  it('FAQPage emits at most 50 mainEntity questions', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      question: `Q${i}`,
      answer: `A${i}`,
    }))
    const g = schemaForEntity({
      entity: basePage,
      override: { schemaType: 'FAQPage', schemaData: { items } },
    })
    expect(g[0]!['@type']).toBe('FAQPage')
    expect((g[0]!.mainEntity as unknown[])).toHaveLength(50)
  })

  it('HowTo emits at most 50 steps', () => {
    const steps = Array.from({ length: 120 }, (_, i) => ({
      name: `Step ${i}`,
      text: `Do ${i}`,
    }))
    const g = schemaForEntity({
      entity: basePage,
      override: { schemaType: 'HowTo', schemaData: { name: 'Big', steps } },
    })
    expect(g[0]!['@type']).toBe('HowTo')
    expect((g[0]!.step as unknown[])).toHaveLength(50)
  })

  it('the additions-only path is bounded too', () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      question: `Q${i}`,
      answer: `A${i}`,
    }))
    const g = extraSchemaForEntity({
      entity: basePage,
      override: { schemaType: 'FAQPage', schemaData: { items } },
    })
    expect((g[0]!.mainEntity as unknown[])).toHaveLength(50)
  })
})

describe('schemaForEntity — survives safeJsonForScript', () => {
  it('the whole emitted graph serializes XSS-safe and round-trips', () => {
    const g = schemaForEntity({
      entity: { ...basePost, title: 'Bad</script>', description: 'x-->y' },
      override: {
        schemaType: 'FAQPage',
        schemaData: { items: [{ question: 'Is </script> safe?', answer: 'Yes.' }] },
      },
      breadcrumbs: [
        { name: 'Home', url: '/' },
        { name: 'Bad</script>', url: '/x' },
      ],
    })
    const serialized = safeJsonForScript(g)
    expect(serialized).not.toContain('</script')
    expect(serialized).not.toMatch(/-->/)
    const parsed = JSON.parse(serialized) as Array<Record<string, unknown>>
    expect(parsed[0]!['@type']).toBe('FAQPage')
    expect(parsed[1]!['@type']).toBe('BreadcrumbList')
  })
})
