import { describe, it, expect } from 'vitest'
import { registry } from '@/lib/cms/settings-registry'

const schema = registry['site_header'].schema

function base(navItems: unknown) {
  return {
    brandText: 'Acme',
    logo: null,
    logoMaxHeight: 40,
    theme: 'cream',
    navItems,
    primaryCta: null,
  }
}

describe('site_header navItems with children', () => {
  it('accepts a flat menu (back-compat)', () => {
    const parsed = schema.parse(base([{ label: 'About', href: '/about' }]))
    expect((parsed as { navItems: unknown[] }).navItems).toHaveLength(1)
  })

  it('accepts a parent with children', () => {
    const parsed = schema.parse(
      base([
        { label: 'About', href: '/about', children: [{ label: 'Team', href: '/team' }] },
      ]),
    ) as { navItems: Array<{ children?: unknown[] }> }
    expect(parsed.navItems[0]!.children).toHaveLength(1)
  })

  it('accepts an empty parent href (dropdown-only)', () => {
    expect(() =>
      schema.parse(base([{ label: 'More', href: '', children: [{ label: 'X', href: '/x' }] }])),
    ).not.toThrow()
  })

  it('strips a third nesting level (depth capped at 1 structurally)', () => {
    // Zod strips unknown keys (same mechanism that lets the builder's
    // internal `__id` round-trip without persisting). A stray third-level
    // `children` is silently dropped rather than rejected, so the stored
    // tree can never exceed one level deep.
    const parsed = schema.parse(
      base([
        {
          label: 'About',
          href: '/about',
          children: [
            { label: 'Team', href: '/team', children: [{ label: 'Deep', href: '/d' }] },
          ],
        },
      ]),
    ) as { navItems: Array<{ children?: Array<Record<string, unknown>> }> }
    const child = parsed.navItems[0]!.children![0]!
    expect(child).toMatchObject({ label: 'Team', href: '/team' })
    expect('children' in child).toBe(false)
  })

  it('strips the internal __id key on parse (so it never persists)', () => {
    const parsed = schema.parse(
      base([{ __id: 'x1', label: 'About', href: '/about', children: [{ __id: 'x2', label: 'T', href: '/t' }] }]),
    ) as { navItems: Array<Record<string, unknown> & { children: Array<Record<string, unknown>> }> }
    expect('__id' in parsed.navItems[0]!).toBe(false)
    expect('__id' in parsed.navItems[0]!.children[0]!).toBe(false)
  })

  it('rejects more than 12 children', () => {
    const kids = Array.from({ length: 13 }, (_, i) => ({ label: `c${i}`, href: `/c${i}` }))
    expect(() => schema.parse(base([{ label: 'About', href: '/about', children: kids }]))).toThrow()
  })
})
