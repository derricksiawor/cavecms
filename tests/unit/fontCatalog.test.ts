import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  FONT_CATALOG,
  FONT_CATALOG_ORDER,
  TYPOGRAPHY_ROLES_DEFAULT,
  isFontCatalogKey,
} from '@/lib/typography/catalog'

// Guards the ONLY structural gap in the font system: lib/typography/loadFonts.ts
// (the static @fontsource side-effect imports) and lib/typography/catalog.ts (the
// manifest) are hand-synced. If they drift — a catalog entry with no import, or an
// import with no entry — a font silently falls back with NO build/runtime error.
// This test fails loudly on any drift.

const loadFontsSrc = readFileSync(
  fileURLToPath(new URL('../../lib/typography/loadFonts.ts', import.meta.url)),
  'utf8',
)

// Every `@fontsource/x` or `@fontsource-variable/x` import → the slug `x`,
// which IS the catalog key.
const importedKeys = new Set(
  [...loadFontsSrc.matchAll(/@fontsource(?:-variable)?\/([a-z0-9-]+)/g)].map((m) => m[1]!),
)

describe('font catalog ↔ loadFonts sync', () => {
  it('every catalog font is imported in loadFonts.ts (no silent fallback)', () => {
    const missing = FONT_CATALOG_ORDER.filter((key) => !importedKeys.has(key))
    expect(missing, `catalog fonts with no @fontsource import: ${missing.join(', ')}`).toEqual([])
  })

  it('every loadFonts import has a catalog entry (no orphan import)', () => {
    const orphans = [...importedKeys].filter((key) => !isFontCatalogKey(key))
    expect(orphans, `imports with no catalog entry: ${orphans.join(', ')}`).toEqual([])
  })
})

describe('font catalog integrity', () => {
  it('FONT_CATALOG_ORDER and FONT_CATALOG hold the same keys', () => {
    expect([...FONT_CATALOG_ORDER].sort()).toEqual(Object.keys(FONT_CATALOG).sort())
  })

  it('each entry has a cssFamily and exactly one of weightRange | staticWeight', () => {
    for (const key of FONT_CATALOG_ORDER) {
      const f = FONT_CATALOG[key]!
      expect(f.cssFamily.length, `${key} cssFamily`).toBeGreaterThan(0)
      const hasRange = f.weightRange !== null
      const hasStatic = typeof f.staticWeight === 'number'
      expect(hasRange || hasStatic, `${key} must declare a weight range or a static weight`).toBe(true)
      if (hasRange) {
        expect(f.weightRange![0]).toBeLessThanOrEqual(f.weightRange![1])
      }
    }
  })

  it('the shipped role defaults point at real catalog fonts', () => {
    expect(isFontCatalogKey(TYPOGRAPHY_ROLES_DEFAULT.display)).toBe(true)
    expect(isFontCatalogKey(TYPOGRAPHY_ROLES_DEFAULT.body)).toBe(true)
  })
})
