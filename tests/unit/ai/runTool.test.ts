import { describe, it, expect } from 'vitest'
import {
  executeToolCall,
  type ChatSessionContext,
} from '@/lib/ai/runTool'

// PR 4 — Tool runner unit tests. Cover scope checks (every referenced
// block must be on the session's pageId), parseAndSanitize gating, and
// changeset-append behaviour. The orchestrator integration lives in
// runChatProposal which exercises the full Gemini loop end-to-end via
// Playwright; these tests pin the pure-data behaviour.

function buildSession(): ChatSessionContext {
  return {
    pageId: 7,
    blocks: [
      // Top-level section
      {
        id: 100,
        blockType: 'section',
        kind: 'section',
        parentId: null,
        position: 1000,
        blockKey: null,
        version: 0,
        data: {},
      },
      // Column under the section
      {
        id: 110,
        blockType: 'column',
        kind: 'column',
        parentId: 100,
        position: 1000,
        blockKey: null,
        version: 0,
        data: {},
      },
      // lx_heading widget
      {
        id: 120,
        blockType: 'lx_heading',
        kind: 'widget',
        parentId: 110,
        position: 1000,
        blockKey: null,
        version: 3,
        data: { text: 'Hello world', level: 'h2', size: 'display-lg' },
      },
      // Fixed-slot widget (contact_form on /contact)
      {
        id: 130,
        blockType: 'contact_form',
        kind: 'widget',
        parentId: 110,
        position: 2000,
        blockKey: 'contact_form',
        version: 5,
        data: {
          heading: 'Get in touch',
          submit_label: 'Send',
        },
      },
    ],
    changeset: [],
  }
}

describe('inspect_page', () => {
  it('returns every block with kind + hasEditableText signals', async () => {
    const session = buildSession()
    const result = await executeToolCall('inspect_page', {}, session)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as {
      pageId: number
      blocks: Array<{
        id: number
        kind: string
        hasEditableText: boolean
        isFixedSlot: boolean
      }>
    }
    expect(data.pageId).toBe(7)
    expect(data.blocks).toHaveLength(4)
    const headingEntry = data.blocks.find((b) => b.id === 120)!
    expect(headingEntry.hasEditableText).toBe(true)
    expect(headingEntry.isFixedSlot).toBe(false)
    const contactForm = data.blocks.find((b) => b.id === 130)!
    expect(contactForm.isFixedSlot).toBe(true)
  })
})

describe('inspect_block', () => {
  it('returns the block when on this page', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'inspect_block',
      { blockId: 120 },
      session,
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a blockId not on the session page', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'inspect_block',
      { blockId: 999 },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('block_not_on_page')
  })
})

describe('propose_block_edit', () => {
  it('appends a validated edit op for a widget on this page', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_edit',
      {
        blockId: 120,
        newData: { text: 'New heading' },
      },
      session,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.opIndex).toBe(0)
    expect(session.changeset).toHaveLength(1)
    const op = session.changeset[0]!
    expect(op.op).toBe('edit')
    if (op.op === 'edit') {
      expect(op.blockId).toBe(120)
      expect(op.blockType).toBe('lx_heading')
      expect(op.expectedBlockVersion).toBe(3)
    }
  })

  it('refuses an edit against a section (container, not widget)', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_edit',
      { blockId: 100, newData: {} },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_edit_container')
    expect(session.changeset).toHaveLength(0)
  })

  it('refuses an edit when the candidate data fails Zod', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_edit',
      // lx_heading requires text.min(1); empty string trips Zod.
      { blockId: 120, newData: { text: '' } },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('validation_failed')
    expect(session.changeset).toHaveLength(0)
  })

  it('refuses an edit against a block not on this page', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_edit',
      { blockId: 99999, newData: { text: 'x' } },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('block_not_on_page')
  })
})

describe('propose_block_insert', () => {
  it('appends a validated insert op into a column', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_insert',
      {
        parentColumnId: 110,
        blockType: 'lx_quote',
        data: { quote: 'Build it carefully.' },
      },
      session,
    )
    expect(result.ok).toBe(true)
    expect(session.changeset).toHaveLength(1)
    const op = session.changeset[0]!
    expect(op.op).toBe('insert')
  })

  it('refuses an insert into a non-column parent', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_insert',
      {
        parentColumnId: 100, // section, not column
        blockType: 'lx_quote',
        data: { quote: 'x' },
      },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('parent_must_be_column')
  })

  it('refuses an insert with an anchor that lives under a different column', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_insert',
      {
        parentColumnId: 110,
        blockType: 'lx_quote',
        data: { quote: 'x' },
        afterBlockId: 100, // section, not a sibling under 110
      },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('anchor_not_sibling')
  })

  it('refuses an insert of an unknown block type', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_insert',
      {
        parentColumnId: 110,
        blockType: 'totally_made_up_widget',
        data: {},
      },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('unknown_block_type')
  })
})

describe('propose_block_delete', () => {
  it('appends a delete op for a non-fixed widget', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_delete',
      { blockId: 120 },
      session,
    )
    expect(result.ok).toBe(true)
    expect(session.changeset).toHaveLength(1)
  })

  it('refuses to delete a fixed-slot widget', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_delete',
      { blockId: 130 },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_delete_fixed_block')
  })

  it('refuses to delete a container', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_delete',
      { blockId: 100 },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('cannot_delete_container')
  })
})

describe('propose_block_reorder', () => {
  it('appends a reorder op for widgets on this page', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_reorder',
      {
        moves: [
          { blockId: 120, parentColumnId: 110, position: 0 },
        ],
      },
      session,
    )
    expect(result.ok).toBe(true)
    expect(session.changeset).toHaveLength(1)
  })

  it('refuses moves with cross-page blockId', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_reorder',
      {
        moves: [
          { blockId: 9999, parentColumnId: 110, position: 0 },
        ],
      },
      session,
    )
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate blockIds in moves[]', async () => {
    const session = buildSession()
    const result = await executeToolCall(
      'propose_block_reorder',
      {
        moves: [
          { blockId: 120, parentColumnId: 110, position: 0 },
          { blockId: 120, parentColumnId: 110, position: 1 },
        ],
      },
      session,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('duplicate_block_in_moves')
  })
})

describe('unknown tool', () => {
  it('returns unknown_tool for a non-registered name', async () => {
    const session = buildSession()
    const result = await executeToolCall('write_db', {}, session)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('unknown_tool')
  })
})
