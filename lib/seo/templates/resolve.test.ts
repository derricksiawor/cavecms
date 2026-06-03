import { describe, it, expect } from 'vitest'
import { resolveTemplate, stripUnknownVariables } from './resolve'
import { TEMPLATE_VARIABLES, VARIABLE_GROUPS } from './variables'
import type { TemplateContext } from './types'

// A fully-populated context so every variable has a non-empty value to
// resolve against. Individual tests override fields to exercise empties.
const fullCtx: TemplateContext = {
  siteName: 'Acme Co',
  siteDesc: 'We make things',
  separator: '–',
  title: 'Hello World',
  excerpt: 'A short summary',
  date: 'Jan 1, 2024',
  modified: 'Feb 2, 2024',
  currentYear: '2024',
  currentDate: 'Mar 3, 2024',
  page: { current: 2, total: 5 },
  focusKeyphrase: 'widgets',
  category: 'Guides',
  searchPhrase: 'how to',
  ptSingle: 'Project',
  ptPlural: 'Projects',
  orgName: 'Acme Organisation',
  authorName: 'Jane Doe',
}

describe('individual variable resolution', () => {
  const cases: Array<[string, string]> = [
    ['%sitename%', 'Acme Co'],
    ['%sitedesc%', 'We make things'],
    ['%title%', 'Hello World'],
    ['%excerpt%', 'A short summary'],
    ['%focuskw%', 'widgets'],
    ['%currentyear%', '2024'],
    ['%currentdate%', 'Mar 3, 2024'],
    ['%date%', 'Jan 1, 2024'],
    ['%modified%', 'Feb 2, 2024'],
    ['%page%', 'Page 2 of 5'],
    ['%pagenumber%', '2'],
    ['%pagetotal%', '5'],
    ['%searchphrase%', 'how to'],
    ['%pt_single%', 'Project'],
    ['%pt_plural%', 'Projects'],
    ['%category%', 'Guides'],
    ['%name%', 'Jane Doe'],
    ['%org_name%', 'Acme Organisation'],
  ]

  for (const [token, expected] of cases) {
    it(`resolves ${token} → "${expected}"`, () => {
      expect(resolveTemplate(token, fullCtx)).toBe(expected)
    })
  }

  it('%currentyear% falls back to the live year when ctx omits it', () => {
    const { currentYear: _omit, ...rest } = fullCtx
    const out = resolveTemplate('%currentyear%', rest as TemplateContext)
    expect(out).toBe(String(new Date().getFullYear()))
  })

  it('a template that resolves to only the separator strips to empty', () => {
    // A standalone %sep% (or a template where every content variable was
    // empty) leaves an orphan glyph — the dangling-separator cleanup
    // removes it entirely, matching Yoast/Rank Math (a <title> of just
    // "–" is never desirable).
    expect(resolveTemplate('%sep%', fullCtx)).toBe('')
  })

  it('is case-insensitive on token names', () => {
    expect(resolveTemplate('%TITLE% %Sep% %SiteName%', fullCtx)).toBe(
      'Hello World – Acme Co',
    )
  })
})

describe('%page% pagination semantics', () => {
  it('renders "Page X of Y" when total > 1', () => {
    expect(
      resolveTemplate('%page%', { ...fullCtx, page: { current: 3, total: 7 } }),
    ).toBe('Page 3 of 7')
  })

  it('strips to empty when total === 1', () => {
    expect(
      resolveTemplate('%title% %page%', {
        ...fullCtx,
        page: { current: 1, total: 1 },
      }),
    ).toBe('Hello World')
  })

  it('strips to empty when total === 0', () => {
    expect(
      resolveTemplate('%title%%page%', {
        ...fullCtx,
        page: { current: 0, total: 0 },
      }),
    ).toBe('Hello World')
  })

  it('strips to empty when page is absent entirely', () => {
    const { page: _omit, ...rest } = fullCtx
    expect(resolveTemplate('%title% %page%', rest as TemplateContext)).toBe(
      'Hello World',
    )
  })
})

describe('unknown / malformed tokens', () => {
  it('strips a well-formed but unknown token', () => {
    expect(resolveTemplate('Foo %bogus% Bar', fullCtx)).toBe('Foo Bar')
  })

  it('strips the args form of an unknown token', () => {
    expect(resolveTemplate('Foo %bogus(1,2)% Bar', fullCtx)).toBe('Foo Bar')
  })

  it('gracefully strips the args form of a KNOWN token (args ignored)', () => {
    // No variable implements args yet — the args are dropped and the base
    // token resolves rather than leaving raw `%date(...)%` in output.
    expect(resolveTemplate('%date(M j)%', fullCtx)).toBe('Jan 1, 2024')
  })

  it('never leaves a raw %x% in output', () => {
    // No literal %sep% here — the unknown token just vanishes and the
    // surrounding whitespace collapses, leaving the two real values
    // space-joined with no separator to clean.
    const out = resolveTemplate('%title% %unknownthing% %sitename%', fullCtx)
    expect(out).not.toMatch(/%[a-z0-9_]+%/i)
    expect(out).toBe('Hello World Acme Co')
  })

  it('strips an unknown token sitting between separators cleanly', () => {
    // With real separators around the unknown token, the dangling-sep
    // cleanup collapses the orphaned glyph.
    const out = resolveTemplate(
      '%title% %sep% %unknownthing% %sep% %sitename%',
      fullCtx,
    )
    expect(out).toBe('Hello World – Acme Co')
  })

  it('leaves a lone / unbalanced percent untouched', () => {
    expect(resolveTemplate('50% off', fullCtx)).toBe('50% off')
  })
})

describe('whitespace collapse', () => {
  it('collapses multiple internal spaces to one', () => {
    expect(resolveTemplate('Foo     Bar', fullCtx)).toBe('Foo Bar')
  })

  it('trims leading/trailing whitespace', () => {
    expect(resolveTemplate('   %title%   ', fullCtx)).toBe('Hello World')
  })

  it('collapses newlines/tabs introduced around tokens', () => {
    expect(resolveTemplate('%title%\n\t%sitename%', fullCtx)).toBe(
      'Hello World Acme Co',
    )
  })
})

describe('dangling separator cleanup', () => {
  const ctx = { ...fullCtx }

  it('removes a leading separator left by an empty leading variable', () => {
    // %title% empty → " – Acme Co" → "Acme Co"
    expect(
      resolveTemplate('%title% %sep% %sitename%', { ...ctx, title: '' }),
    ).toBe('Acme Co')
  })

  it('removes a trailing separator left by an empty trailing variable', () => {
    expect(
      resolveTemplate('%sitename% %sep% %title%', { ...ctx, title: '' }),
    ).toBe('Acme Co')
  })

  it('collapses a doubled separator left by an empty middle variable', () => {
    // "Foo – %empty% – Bar" → "Foo –  – Bar" → "Foo – Bar"
    expect(
      resolveTemplate('%sitename% %sep% %title% %sep% %sitedesc%', {
        ...ctx,
        title: '',
      }),
    ).toBe('Acme Co – We make things')
  })

  it('matches the literal "Foo  –  – Bar" → "Foo – Bar" example', () => {
    expect(resolveTemplate('Foo  –  – Bar', ctx)).toBe('Foo – Bar')
  })

  it('matches the literal " – Bar" → "Bar" example', () => {
    expect(resolveTemplate(' – Bar', ctx)).toBe('Bar')
  })

  it('collapses three-or-more consecutive separators', () => {
    expect(resolveTemplate('A – – – B', ctx)).toBe('A – B')
  })

  it('works with a multi-char / regex-special separator', () => {
    const pipeCtx = { ...ctx, separator: '|' }
    expect(
      resolveTemplate('%title% %sep% %sitename%', { ...pipeCtx, title: '' }),
    ).toBe('Acme Co')
    expect(resolveTemplate('A | | B', pipeCtx)).toBe('A | B')
  })

  it('does NOT touch a separator that is also legitimate content', () => {
    // Both sides present → the single separator stays.
    expect(resolveTemplate('%title% %sep% %sitename%', ctx)).toBe(
      'Hello World – Acme Co',
    )
  })
})

describe('separator-as-content-char preservation (period/!/?/) glyphs)', () => {
  // The cleanup must NEVER strip a separator occurrence that abuts a
  // non-space content character — only WHITESPACE-FLANKED (or edge-with-
  // inner-whitespace) separators are dangling. This guards operators whose
  // %sep% glyph is itself a sentence/content character.

  it('sep "." does NOT eat the period of "Acme Inc."', () => {
    // "Acme Inc." with sep "." — the trailing period abuts "c" on its left,
    // so it is content, not a dangling separator. Must be preserved.
    const dotCtx: TemplateContext = {
      siteName: 'Acme Inc.',
      siteDesc: '',
      separator: '.',
      title: '',
    }
    expect(resolveTemplate('%sitename%', dotCtx)).toBe('Acme Inc.')
  })

  it('sep "." preserves a value that legitimately ends in the sep char', () => {
    const dotCtx: TemplateContext = {
      siteName: 'Co',
      siteDesc: '',
      separator: '.',
      title: 'Acme Inc.',
    }
    // "Acme Inc. . Co" would be the naive template; here the template has a
    // single template-authored sep between two real values. The trailing
    // period of "Inc." abuts content and survives; the space-flanked sep
    // between the two values stays as the real separator.
    expect(resolveTemplate('%title% %sep% %sitename%', dotCtx)).toBe(
      'Acme Inc. . Co',
    )
  })

  it('sep "." still strips a genuinely dangling (space-flanked, edge) period', () => {
    // Empty trailing value leaves "Foo ." — space before the period, string
    // end after → dangling → stripped to "Foo".
    const dotCtx: TemplateContext = {
      siteName: 'Foo',
      siteDesc: '',
      separator: '.',
      title: '',
    }
    expect(resolveTemplate('%sitename% %sep% %title%', dotCtx)).toBe('Foo')
  })

  it('sep ")" does NOT eat the paren of "Widgets (Pro)"', () => {
    const parenCtx: TemplateContext = {
      siteName: 'Widgets (Pro)',
      siteDesc: '',
      separator: ')',
      title: '',
    }
    expect(resolveTemplate('%sitename%', parenCtx)).toBe('Widgets (Pro)')
  })

  it('sep "!" does NOT eat the bang of "Sale!"', () => {
    const bangCtx: TemplateContext = {
      siteName: 'Sale!',
      siteDesc: '',
      separator: '!',
      title: '',
    }
    expect(resolveTemplate('%sitename%', bangCtx)).toBe('Sale!')
  })

  it('sep "?" does NOT eat the question mark of "Why? Guide"', () => {
    const qCtx: TemplateContext = {
      siteName: 'Why? Guide',
      siteDesc: '',
      separator: '?',
      title: '',
    }
    expect(resolveTemplate('%sitename%', qCtx)).toBe('Why? Guide')
  })

  it('sep "|" dangling-trailing is still stripped (regression guard)', () => {
    const pipeCtx: TemplateContext = {
      siteName: 'Brand',
      siteDesc: '',
      separator: '|',
      title: '',
    }
    expect(resolveTemplate('%sitename% %sep% %title%', pipeCtx)).toBe('Brand')
  })

  it('sep "–" double-collapse still works (regression guard)', () => {
    expect(resolveTemplate('A – – – B', { ...fullCtx, separator: '–' })).toBe(
      'A – B',
    )
  })
})

describe('actual seo_titles registry default templates', () => {
  const base: TemplateContext = {
    siteName: 'Acme Co',
    siteDesc: 'We make things',
    separator: '–',
  }

  it('home title: %sitename%', () => {
    expect(resolveTemplate('%sitename%', base)).toBe('Acme Co')
  })

  it('home description: %sitedesc%', () => {
    expect(resolveTemplate('%sitedesc%', base)).toBe('We make things')
  })

  it('page/post/project title: %title% %sep% %sitename%', () => {
    expect(
      resolveTemplate('%title% %sep% %sitename%', {
        ...base,
        title: 'About Us',
      }),
    ).toBe('About Us – Acme Co')
  })

  it('page/post description: %excerpt% (present)', () => {
    expect(
      resolveTemplate('%excerpt%', { ...base, excerpt: 'Who we are' }),
    ).toBe('Who we are')
  })

  it('page/post description: %excerpt% (empty → empty string)', () => {
    expect(resolveTemplate('%excerpt%', base)).toBe('')
  })

  it('blogIndex/projectsIndex title resolves with an index title', () => {
    expect(
      resolveTemplate('%title% %sep% %sitename%', {
        ...base,
        title: 'Blog',
      }),
    ).toBe('Blog – Acme Co')
  })

  it('search title: literal "Search %sep% %sitename%"', () => {
    expect(resolveTemplate('Search %sep% %sitename%', base)).toBe(
      'Search – Acme Co',
    )
  })

  it('notFound title: literal "Page not found %sep% %sitename%"', () => {
    expect(resolveTemplate('Page not found %sep% %sitename%', base)).toBe(
      'Page not found – Acme Co',
    )
  })

  it('a missing %title% collapses the page-title template cleanly', () => {
    // Defensive: an index page with no title set still yields a clean
    // "Acme Co" rather than "– Acme Co".
    expect(resolveTemplate('%title% %sep% %sitename%', base)).toBe('Acme Co')
  })
})

describe('variable registry shape', () => {
  it('every variable has a token, label, group and resolver', () => {
    for (const v of TEMPLATE_VARIABLES) {
      expect(v.token).toMatch(/^%[a-z0-9_]+%$/)
      expect(typeof v.label).toBe('string')
      expect(v.label.length).toBeGreaterThan(0)
      expect(typeof v.resolve).toBe('function')
    }
  })

  it('tokens are unique', () => {
    const tokens = TEMPLATE_VARIABLES.map((v) => v.token)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('VARIABLE_GROUPS partitions every variable exactly once', () => {
    const grouped = Object.values(VARIABLE_GROUPS).flat()
    expect(grouped.length).toBe(TEMPLATE_VARIABLES.length)
    expect(new Set(grouped.map((v) => v.token)).size).toBe(
      TEMPLATE_VARIABLES.length,
    )
  })
})

describe('stripUnknownVariables (exported helper)', () => {
  it('replaces tokens without the whitespace/separator cleanup pass', () => {
    // Raw replacement leaves the doubled spacing — proves the cleanup
    // lives in resolveTemplate, not the replacement helper.
    expect(
      stripUnknownVariables('%title% %sep% %sitename%', {
        ...fullCtx,
        title: '',
      }),
    ).toBe(' – Acme Co')
  })
})
