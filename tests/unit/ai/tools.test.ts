import { describe, it, expect } from 'vitest'
import {
  TOOL_DECLARATIONS,
  TOOL_NAMES,
  isToolName,
  InspectBlockInputSchema,
  ProposeBlockEditInputSchema,
  ProposeBlockInsertInputSchema,
  ProposeBlockDeleteInputSchema,
  ProposeBlockReorderInputSchema,
  MAX_CHAT_CHANGESET_OPS,
} from '@/lib/ai/tools'

// PR 4 — Gemini function-declaration surface for the Page Assistant
// chatbot. These tests cover ONLY the static, pure-data parts of the
// tool layer (declarations + input Zod schemas). The behavioural tests
// for the dispatcher live in runTool.test.ts.

describe('TOOL_DECLARATIONS', () => {
  it('exports exactly six tools', () => {
    expect(TOOL_DECLARATIONS).toHaveLength(6)
  })

  it('every declaration name matches TOOL_NAMES', () => {
    const declared = TOOL_DECLARATIONS.map((d) => d.name)
    expect(new Set(declared)).toEqual(new Set(TOOL_NAMES))
  })

  it('isToolName accepts every declared name and rejects others', () => {
    for (const t of TOOL_NAMES) {
      expect(isToolName(t)).toBe(true)
    }
    expect(isToolName('read_settings')).toBe(false)
    expect(isToolName('write_block')).toBe(false)
    expect(isToolName('')).toBe(false)
  })

  it('every parameters schema declares type: object', () => {
    for (const d of TOOL_DECLARATIONS) {
      expect(d.parameters.type).toBe('object')
    }
  })

  it('inspect_page takes no required parameters', () => {
    const decl = TOOL_DECLARATIONS.find((d) => d.name === 'inspect_page')!
    expect(decl.parameters.required ?? []).toEqual([])
  })

  it('propose_block_reorder caps moves array at 16', () => {
    const decl = TOOL_DECLARATIONS.find(
      (d) => d.name === 'propose_block_reorder',
    )!
    expect(decl.parameters.properties?.moves?.maxItems).toBe(16)
  })
})

describe('Zod input schemas', () => {
  it('InspectBlockInputSchema requires blockId > 0', () => {
    expect(InspectBlockInputSchema.safeParse({ blockId: 1 }).success).toBe(true)
    expect(InspectBlockInputSchema.safeParse({ blockId: 0 }).success).toBe(
      false,
    )
    expect(InspectBlockInputSchema.safeParse({}).success).toBe(false)
  })

  it('ProposeBlockEditInputSchema accepts {blockId, newData}', () => {
    const ok = ProposeBlockEditInputSchema.safeParse({
      blockId: 42,
      newData: { title: 'New title' },
    })
    expect(ok.success).toBe(true)
  })

  it('ProposeBlockEditInputSchema rejects unknown top-level fields', () => {
    const bad = ProposeBlockEditInputSchema.safeParse({
      blockId: 42,
      newData: {},
      extra: 'snuck-in',
    })
    expect(bad.success).toBe(false)
  })

  it('ProposeBlockInsertInputSchema rejects both anchor fields together', () => {
    const bad = ProposeBlockInsertInputSchema.safeParse({
      parentColumnId: 10,
      blockType: 'lx_heading',
      data: { text: 'x' },
      afterBlockId: 20,
      beforeBlockId: 30,
    })
    expect(bad.success).toBe(false)
  })

  it('ProposeBlockInsertInputSchema accepts a single anchor', () => {
    const ok = ProposeBlockInsertInputSchema.safeParse({
      parentColumnId: 10,
      blockType: 'lx_heading',
      data: { text: 'x' },
      afterBlockId: 20,
    })
    expect(ok.success).toBe(true)
  })

  it('ProposeBlockDeleteInputSchema requires only blockId', () => {
    expect(
      ProposeBlockDeleteInputSchema.safeParse({ blockId: 99 }).success,
    ).toBe(true)
    expect(ProposeBlockDeleteInputSchema.safeParse({}).success).toBe(false)
  })

  it('ProposeBlockReorderInputSchema enforces moves[] cap', () => {
    const moves = Array.from({ length: 17 }, (_, i) => ({
      blockId: i + 1,
      parentColumnId: 100,
      position: i,
    }))
    expect(
      ProposeBlockReorderInputSchema.safeParse({ moves }).success,
    ).toBe(false)
  })

  it('ProposeBlockReorderInputSchema requires position ≥ 0', () => {
    const bad = ProposeBlockReorderInputSchema.safeParse({
      moves: [{ blockId: 1, parentColumnId: 2, position: -1 }],
    })
    expect(bad.success).toBe(false)
  })
})

describe('changeset cap constant', () => {
  it('matches the inline AcceptIndices cap of 32', () => {
    // Mirrors the apply route's normaliseAcceptIndices(... 32) limit
    // so an overshoot from EITHER surface lands on the same error.
    expect(MAX_CHAT_CHANGESET_OPS).toBe(32)
  })
})
