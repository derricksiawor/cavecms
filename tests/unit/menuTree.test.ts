import { describe, it, expect } from 'vitest'
import {
  normalizeFromValue,
  denormalizeToValue,
  indentParent,
  outdentChild,
  type MenuConfig,
  type MenuNode,
} from '@/lib/cms/menuTree'

const HEADER: MenuConfig = {
  parentHrefKey: 'href',
  childrenKey: 'children',
  childLabelKey: 'label',
  childHrefKey: 'href',
  maxItems: 6,
  maxChildren: 12,
}
const FOOTER: MenuConfig = {
  childrenKey: 'links',
  childLabelKey: 'text',
  childHrefKey: 'href',
  maxItems: 6,
  maxChildren: 20,
}

describe('menuTree — normalize/denormalize', () => {
  it('round-trips a header value (label/href/children)', () => {
    const value = [
      { label: 'About', href: '/about', children: [{ label: 'Team', href: '/team' }] },
      { label: 'Contact', href: '/contact' },
    ]
    const nodes = normalizeFromValue(value, HEADER)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]!.label).toBe('About')
    expect(nodes[0]!.href).toBe('/about')
    expect(nodes[0]!.children[0]!.label).toBe('Team')
    expect(nodes[0]!.children[0]!.href).toBe('/team')

    const back = denormalizeToValue(nodes, HEADER)
    expect(back[0]).toMatchObject({
      label: 'About',
      href: '/about',
      children: [{ label: 'Team', href: '/team' }],
    })
    expect(back[1]).toMatchObject({ label: 'Contact', href: '/contact', children: [] })
  })

  it('round-trips a footer value (text/links, no parent href)', () => {
    const value = [{ label: 'Company', links: [{ text: 'Careers', href: '/careers' }] }]
    const nodes = normalizeFromValue(value, FOOTER)
    expect(nodes[0]!.label).toBe('Company')
    expect(nodes[0]!.href).toBeUndefined()
    expect(nodes[0]!.children[0]!.label).toBe('Careers')
    expect(nodes[0]!.children[0]!.href).toBe('/careers')

    const back = denormalizeToValue(nodes, FOOTER)
    expect(back[0]).toMatchObject({ label: 'Company', links: [{ text: 'Careers', href: '/careers' }] })
    expect('href' in (back[0] as object)).toBe(false)
  })

  it('preserves __id across re-normalize so rows stay stable while typing', () => {
    const value = [{ label: 'A', href: '/a' }]
    const once = denormalizeToValue(normalizeFromValue(value, HEADER), HEADER)
    const id1 = (once[0] as { __id: string }).__id
    const twice = denormalizeToValue(normalizeFromValue(once, HEADER), HEADER)
    const id2 = (twice[0] as { __id: string }).__id
    expect(id1).toBe(id2)
  })
})

describe('menuTree — indent/outdent', () => {
  const tree = (): MenuNode[] => [
    { id: 'a', label: 'A', href: '/a', children: [] },
    { id: 'b', label: 'B', href: '/b', children: [] },
  ]

  it('indents a childless top-level node under the previous one', () => {
    const next = indentParent(tree(), 'b', HEADER)
    expect(next).toHaveLength(1)
    expect(next[0]!.id).toBe('a')
    expect(next[0]!.children.map((c) => c.id)).toEqual(['b'])
    expect(next[0]!.children[0]!.label).toBe('B')
    expect(next[0]!.children[0]!.href).toBe('/b')
  })

  it('refuses to indent the first node (no preceding sibling)', () => {
    const next = indentParent(tree(), 'a', HEADER)
    expect(next).toHaveLength(2)
  })

  it('refuses to indent a node that has children (would create depth 2)', () => {
    const t: MenuNode[] = [
      { id: 'a', label: 'A', href: '/a', children: [] },
      { id: 'b', label: 'B', href: '/b', children: [{ id: 'b1', label: 'B1', href: '/b1' }] },
    ]
    expect(indentParent(t, 'b', HEADER)).toEqual(t)
  })

  it('outdents a child to a top-level node right after its parent', () => {
    const t: MenuNode[] = [
      { id: 'a', label: 'A', href: '/a', children: [{ id: 'a1', label: 'A1', href: '/a1' }] },
      { id: 'c', label: 'C', href: '/c', children: [] },
    ]
    const next = outdentChild(t, 'a', 'a1', HEADER)
    expect(next.map((n) => n.id)).toEqual(['a', 'a1', 'c'])
    expect(next[0]!.children).toHaveLength(0)
    expect(next[1]!.label).toBe('A1')
    expect(next[1]!.href).toBe('/a1')
  })

  it('outdent in footer drops the href (column is a heading, no link)', () => {
    const t: MenuNode[] = [
      { id: 'a', label: 'Company', children: [{ id: 'a1', label: 'Careers', href: '/careers' }] },
    ]
    const next = outdentChild(t, 'a', 'a1', FOOTER)
    expect(next.map((n) => n.id)).toEqual(['a', 'a1'])
    expect(next[1]!.label).toBe('Careers')
    expect(next[1]!.href).toBeUndefined()
  })

  it('respects maxChildren on indent and maxItems on outdent', () => {
    const tight: MenuConfig = { ...HEADER, maxChildren: 0 }
    expect(indentParent(tree(), 'b', tight)).toEqual(tree())

    const fullTop: MenuConfig = { ...HEADER, maxItems: 1 }
    const t: MenuNode[] = [
      { id: 'a', label: 'A', href: '/a', children: [{ id: 'a1', label: 'A1', href: '/a1' }] },
    ]
    expect(outdentChild(t, 'a', 'a1', fullTop)).toEqual(t)
  })
})
