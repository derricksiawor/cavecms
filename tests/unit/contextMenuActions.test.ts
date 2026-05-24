import { describe, it, expect } from 'vitest'
import {
  MENU_ITEMS_BY_KIND,
  type MenuItem,
} from '@/lib/cms/contextMenuActions'

// Chunk H — pin the registry shape. A regression that drops a kind,
// duplicates an id, or wires a non-function handler surfaces here
// instead of in production with a silent "Edit" item that does nothing.

const KINDS = ['section', 'column', 'widget'] as const

describe('contextMenuActions — registry shape', () => {
  it('exposes a non-empty action list for every BlockKind', () => {
    for (const k of KINDS) {
      const list = MENU_ITEMS_BY_KIND[k]
      expect(list, `missing entries for kind=${k}`).toBeDefined()
      expect(list.length, `empty action list for kind=${k}`).toBeGreaterThan(0)
    }
  })

  it('every MenuItem has a unique id within its kind', () => {
    for (const k of KINDS) {
      const ids = MENU_ITEMS_BY_KIND[k].map((it) => it.id)
      expect(
        new Set(ids).size,
        `duplicate id within kind=${k}: ${ids.join(', ')}`,
      ).toBe(ids.length)
    }
  })

  it('every MenuItem id is namespaced with its kind prefix', () => {
    // Convention: `${kind}.${verb}` (e.g. 'widget.delete'). Catches
    // copy-paste between kind blocks that forgets to rename the id —
    // the React key would still be unique within its kind but the
    // global registry would have ambiguous fingerprints in analytics
    // / audit / future keyboard-shortcut routing.
    for (const k of KINDS) {
      for (const it of MENU_ITEMS_BY_KIND[k]) {
        expect(
          it.id.startsWith(`${k}.`),
          `id "${it.id}" must start with "${k}."`,
        ).toBe(true)
      }
    }
  })

  it('every MenuItem has a non-empty label and a function handler', () => {
    for (const k of KINDS) {
      for (const it of MENU_ITEMS_BY_KIND[k]) {
        expect(typeof it.label === 'string' && it.label.length > 0).toBe(true)
        expect(typeof it.handler).toBe('function')
      }
    }
  })

  it('disabled predicate (when defined) is a function', () => {
    for (const k of KINDS) {
      for (const it of MENU_ITEMS_BY_KIND[k]) {
        if (it.disabled !== undefined) {
          expect(typeof it.disabled).toBe('function')
        }
      }
    }
  })

  it('destructive items always carry a kbdHint and sit at the bottom of their kind', () => {
    // Convention: the Delete verb is the LAST item in every kind's
    // registry AND it carries the ⌫ kbdHint. A regression that moves
    // it mid-list breaks the "press End to focus the destructive
    // action" muscle-memory pattern operators learn from other builders.
    for (const k of KINDS) {
      const list = MENU_ITEMS_BY_KIND[k]
      const destructiveIdx = list.findIndex((it) => it.destructive === true)
      expect(destructiveIdx, `kind=${k} has no destructive item`).toBeGreaterThanOrEqual(0)
      expect(
        destructiveIdx,
        `kind=${k} destructive item is not last`,
      ).toBe(list.length - 1)
      const destructive = list[destructiveIdx] as MenuItem
      expect(destructive.kbdHint).toBe('⌫')
    }
  })

  it('separatorAbove is never set on the FIRST item (would render a leading hairline)', () => {
    for (const k of KINDS) {
      const first = MENU_ITEMS_BY_KIND[k][0]
      expect(
        first?.separatorAbove,
        `kind=${k} first item has separatorAbove set — render would emit a stray hairline above the menu's first row`,
      ).not.toBe(true)
    }
  })
})
