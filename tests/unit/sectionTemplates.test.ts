import { describe, it, expect } from 'vitest'
import {
  ALL_TEMPLATES,
  MAX_INSTANTIATE_BLOCKS,
  countBlocks,
  findUnknownBlockType,
  getTemplateById,
} from '@/lib/cms/sectionTemplates'
import { parseBlockData, blockSchemas } from '@/lib/cms/block-registry'
import {
  ColumnMetaSchema,
  SectionMetaSchema,
  WidgetMetaSchema,
} from '@/lib/cms/blockMeta'

// Chunk J — round-trip every template's widget data through its
// block-registry Zod schema. Mirrors tests/unit/blockSeeds.test.ts —
// when a widget schema adds a required field, the template entries
// must follow or this test fails at build time. Without this pin, a
// drifted template would 422 silently at the instantiate endpoint
// and the operator would see "Couldn't insert template" with no path
// forward.

describe('sectionTemplates registry', () => {
  it('exports 8 templates', () => {
    expect(ALL_TEMPLATES).toHaveLength(8)
  })

  it('every template has a unique id', () => {
    const ids = ALL_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every template has a non-empty name + description + previewImage', () => {
    for (const t of ALL_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.previewImage.startsWith('/templates/')).toBe(true)
      expect(t.previewImage.endsWith('.svg')).toBe(true)
    }
  })

  it('every template has at least one section + every section at least one column', () => {
    for (const t of ALL_TEMPLATES) {
      expect(t.blocks.length).toBeGreaterThan(0)
      for (const s of t.blocks) {
        expect(s.kind).toBe('section')
        expect(s.columns.length).toBeGreaterThan(0)
        expect(s.columns.length).toBeLessThanOrEqual(4)
        for (const c of s.columns) {
          expect(c.kind).toBe('column')
        }
      }
    }
  })

  it('countBlocks returns section + column + widget total', () => {
    // Pick the heroFeaturesCta template: 3 sections + (1 col + 3 widgets)
    // + (3 cols + 1 widget each = 6) + (1 col + 1 widget) = 3 + 4 + 6 + 2
    // = 15. Better assertion: just verify the function adds correctly.
    for (const t of ALL_TEMPLATES) {
      let manual = 0
      for (const s of t.blocks) {
        manual += 1
        for (const c of s.columns) {
          manual += 1
          manual += c.widgets.length
        }
      }
      expect(countBlocks(t)).toBe(manual)
    }
  })

  it('getTemplateById returns the template for known ids, null for unknown', () => {
    for (const t of ALL_TEMPLATES) {
      expect(getTemplateById(t.id)).toBe(t)
    }
    expect(getTemplateById('does-not-exist')).toBeNull()
  })

  it('findUnknownBlockType returns null when every widget type is registered', () => {
    const known = new Set(Object.keys(blockSchemas))
    for (const t of ALL_TEMPLATES) {
      expect(findUnknownBlockType(t, known)).toBeNull()
    }
  })

  it('every template stays under MAX_INSTANTIATE_BLOCKS', () => {
    // CI pin — a Phase-2 template that fans out past the per-request
    // cap would otherwise 500 at the instantiate endpoint's pre-flight.
    // This test surfaces the violation at build time.
    for (const t of ALL_TEMPLATES) {
      expect(countBlocks(t)).toBeLessThanOrEqual(MAX_INSTANTIATE_BLOCKS)
    }
  })

  it('findUnknownBlockType catches a forged template with an unknown widget', () => {
    const forged = {
      ...ALL_TEMPLATES[0]!,
      blocks: [
        {
          kind: 'section' as const,
          columns: [
            {
              kind: 'column' as const,
              widgets: [
                {
                  kind: 'widget' as const,
                  blockType: 'unknown_widget_type',
                  data: {},
                },
              ],
            },
          ],
        },
      ],
    }
    const known = new Set(Object.keys(blockSchemas))
    expect(findUnknownBlockType(forged, known)).toBe('unknown_widget_type')
  })
})

describe('sectionTemplates round-trip', () => {
  for (const template of ALL_TEMPLATES) {
    describe(`template "${template.id}"`, () => {
      for (const [si, section] of template.blocks.entries()) {
        // Section meta — empty object is acceptable; SectionMetaSchema
        // fills defaults.
        it(`section[${si}].meta parses through SectionMetaSchema`, () => {
          expect(() => SectionMetaSchema.parse(section.meta ?? {})).not.toThrow()
        })
        for (const [ci, col] of section.columns.entries()) {
          it(`section[${si}].column[${ci}].meta parses through ColumnMetaSchema`, () => {
            expect(() => ColumnMetaSchema.parse(col.meta ?? {})).not.toThrow()
          })
          for (const [wi, w] of col.widgets.entries()) {
            it(`section[${si}].column[${ci}].widget[${wi}] (${w.blockType}) parses through parseBlockData`, () => {
              expect(() => parseBlockData(w.blockType, w.data)).not.toThrow()
            })
            if (w.meta !== undefined) {
              it(`section[${si}].column[${ci}].widget[${wi}].meta parses through WidgetMetaSchema`, () => {
                expect(() => WidgetMetaSchema.parse(w.meta)).not.toThrow()
              })
            }
          }
        }
      }
    })
  }
})
