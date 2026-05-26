import { describe, it, expect } from 'vitest'
import { isAiAction, renderAiActivityLine } from '@/lib/admin/aiActivity'

describe('isAiAction', () => {
  it('recognises the three AI proposal actions', () => {
    expect(isAiAction('ai_proposal_created')).toBe(true)
    expect(isAiAction('ai_proposal_accepted')).toBe(true)
    expect(isAiAction('ai_proposal_dismissed')).toBe(true)
  })

  it('rejects unrelated actions', () => {
    expect(isAiAction('block.update')).toBe(false)
    expect(isAiAction('project.create')).toBe(false)
    expect(isAiAction('ai_proposal_unknown')).toBe(false)
    expect(isAiAction('')).toBe(false)
  })
})

describe('renderAiActivityLine', () => {
  it('renders inline rewrite create with tone + model + tokens', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_created',
      userEmail: 'daria@studio.test',
      diff: {
        token: 'abc',
        surface: 'inline',
        intent: 'rewrite',
        toneChip: 'punchier',
        blockType: 'lx_heading',
        blockId: 42,
        geminiModel: 'gemini-2.5-flash',
        usage: { outputTokens: 87, promptTokens: 312 },
      },
    })
    expect(line).toContain('daria@studio.test')
    expect(line).toContain('Rewrite')
    expect(line).toContain('punchier')
    expect(line).toContain('lx_heading')
    expect(line).toContain('#42')
    expect(line).toContain('Gemini 2.5 Flash')
    expect(line).toContain('87 tokens')
    expect(line).toMatch(/via Inline/)
  })

  it('renders inline translate create with target language', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_created',
      userEmail: 'daria@studio.test',
      diff: {
        token: 't',
        surface: 'inline',
        intent: 'translate',
        language: 'fr',
        blockType: 'lx_text',
        blockId: 7,
        geminiModel: 'gemini-2.5-pro',
        usage: { outputTokens: 144 },
      },
    })
    expect(line).toContain('Translation')
    expect(line).toContain('→ fr')
    expect(line).toContain('lx_text')
  })

  it('renders chat create with op count instead of single block', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_created',
      userEmail: 'ed@studio.test',
      diff: {
        token: 'c',
        surface: 'chat',
        opCount: 4,
        opKinds: { edit: 3, insert: 1 },
        geminiModel: 'gemini-2.5-flash',
        usage: { outputTokens: 220 },
      },
    })
    expect(line).toContain('Page Assistant')
    expect(line).toContain('4 blocks')
    expect(line).toContain('220 tokens')
  })

  it('renders inline accept with block id', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_accepted',
      userEmail: 'daria@studio.test',
      diff: {
        token: 'x',
        surface: 'inline',
        appliedBlocks: [{ op: 'edit', blockId: 99 }],
      },
    })
    expect(line).toContain('applied')
    expect(line).toContain('Inline')
    expect(line).toContain('#99')
  })

  it('renders chat accept with op count + op kinds', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_accepted',
      userEmail: 'ed@studio.test',
      diff: {
        token: 'x',
        surface: 'chat',
        opCount: 3,
        opKinds: { edit: 2, delete: 1 },
        appliedBlocks: [],
      },
    })
    expect(line).toContain('Page Assistant')
    expect(line).toContain('3 ops')
    expect(line).toMatch(/2 edit/)
    expect(line).toMatch(/1 delete/)
  })

  it('renders dismiss', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_dismissed',
      userEmail: 'daria@studio.test',
      diff: { token: 'x', surface: 'inline' },
    })
    expect(line).toContain('dismissed')
    expect(line).toContain('Inline')
  })

  it('falls back to "Someone" when user_email is null', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_dismissed',
      userEmail: null,
      diff: { token: 'x', surface: 'inline' },
    })
    expect(line.startsWith('Someone ')).toBe(true)
  })

  it('degrades gracefully on a missing/malformed diff', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_created',
      userEmail: 'd@x.test',
      diff: null,
    })
    expect(line).toMatch(/d@x\.test/)
    expect(line).toMatch(/proposed/)
  })

  it('parses a JSON-string diff (mysql2 raw shape)', () => {
    // mysql2 returns JSON columns as raw strings unless the call site
    // parses them — the renderer must work either way.
    const diffString = JSON.stringify({
      surface: 'inline',
      intent: 'rewrite',
      toneChip: 'shorter',
      blockType: 'lx_heading',
      blockId: 8,
      geminiModel: 'gemini-2.5-flash',
      usage: { outputTokens: 42 },
    })
    const line = renderAiActivityLine({
      action: 'ai_proposal_created',
      userEmail: 'd@x.test',
      diff: diffString,
    })
    expect(line).toContain('Rewrite')
    expect(line).toContain('shorter')
    expect(line).toContain('lx_heading')
    expect(line).toContain('#8')
  })

  it('falls back gracefully on a malformed JSON-string diff', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_dismissed',
      userEmail: 'd@x.test',
      diff: 'not-json',
    })
    expect(line).toMatch(/dismissed/)
  })

  it('rejects an array-shaped diff (defensive)', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_dismissed',
      userEmail: 'd@x.test',
      diff: JSON.stringify([1, 2, 3]),
    })
    // Array gets treated as empty diff → surface defaults to 'Inline'.
    expect(line).toBe('d@x.test dismissed an Inline proposal')
  })

  it('handles non-array appliedBlocks without crashing', () => {
    const lineString = renderAiActivityLine({
      action: 'ai_proposal_accepted',
      userEmail: 'd@x.test',
      diff: {
        surface: 'inline',
        appliedBlocks: 'corrupted-string' as unknown as never,
      },
    })
    expect(lineString).toMatch(/applied/)

    const lineObject = renderAiActivityLine({
      action: 'ai_proposal_accepted',
      userEmail: 'd@x.test',
      diff: {
        surface: 'chat',
        appliedBlocks: { not: 'an-array' } as unknown as never,
        opCount: 2,
        opKinds: { edit: 2 },
      },
    })
    expect(lineObject).toMatch(/Page Assistant/)
    expect(lineObject).toMatch(/2 ops/)
  })

  it('handles unknown model id by falling through to the raw string', () => {
    const line = renderAiActivityLine({
      action: 'ai_proposal_created',
      userEmail: 'd@x.test',
      diff: {
        surface: 'inline',
        intent: 'rewrite',
        blockType: 'lx_heading',
        blockId: 1,
        geminiModel: 'some-future-model',
        usage: { outputTokens: 50 },
      },
    })
    expect(line).toContain('some-future-model')
  })
})
