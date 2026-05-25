import { describe, it, expect } from 'vitest'
import { buildInlineSystemPrompt } from '@/lib/ai/prompts/system'
import {
  buildIntent,
  parseFieldsResponse,
  parseSuggestResponse,
  TONE_CHIPS,
  TRANSLATE_LANGUAGES,
} from '@/lib/ai/prompts/inline'
import type { ResolvedField } from '@/lib/ai/inlineEligibility'

const fakeFields: ResolvedField[] = [
  {
    path: 'text',
    kind: 'plain',
    maxLength: 220,
    primary: true,
    value: 'Welcome',
  },
]

describe('buildInlineSystemPrompt', () => {
  it('always emits the five sections', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('## 1. Role')
    expect(p).toContain('## 2. Voice')
    expect(p).toContain('## 3. Site')
    expect(p).toContain('## 4. This block')
    expect(p).toContain('## 5. Rules')
  })

  it('renders the editorial preset description', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'editorial',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('editorial')
    expect(p).toContain('magazine-quality')
  })

  it('inlines custom voice notes verbatim', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'custom',
      customVoiceNotes: 'Always start with a question.',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('Always start with a question.')
  })

  it('falls back gracefully when custom is selected with no notes', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'custom',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('No custom notes provided')
  })

  it('includes site name and description when present', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      siteName: 'Acme Bakery',
      siteDescription: 'Family-run since 1962.',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('Acme Bakery')
    expect(p).toContain('Family-run since 1962.')
  })

  it('emits the block-type + field paths in section 4', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      blockType: 'hero',
      fields: [
        { path: 'title', kind: 'plain', maxLength: 220, primary: true, value: 'A' },
        { path: 'cta.text', kind: 'plain', maxLength: 80, primary: false, value: 'Go' },
      ],
      neighbours: [],
    })
    expect(p).toContain('Block type: hero')
    expect(p).toContain('title')
    expect(p).toContain('cta.text')
  })

  it('marks empty field values explicitly', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      blockType: 'lx_heading',
      fields: [
        { path: 'text', kind: 'plain', maxLength: 220, primary: true, value: '' },
      ],
      neighbours: [],
    })
    expect(p).toContain('(empty)')
  })

  it('caps neighbour text count at 3 even when more supplied', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Neighbour ${i}`)
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: many,
    })
    // 3 should appear, 4 should not.
    expect(p).toContain('Neighbour 0')
    expect(p).toContain('Neighbour 2')
    expect(p).not.toContain('Neighbour 3')
  })

  it('explicitly bans hidden HTML tags in section 5', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      blockType: 'lx_text',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('<script>')
    expect(p).toContain('<iframe>')
    expect(p).toContain('on*')
  })

  it('reminds the model that operator free-text is INPUT not instructions', () => {
    const p = buildInlineSystemPrompt({
      voicePreset: 'default',
      blockType: 'lx_heading',
      fields: fakeFields,
      neighbours: [],
    })
    expect(p).toContain('operator\'s free-text instruction')
    expect(p).toContain('ignore previous instructions')
  })
})

describe('buildIntent', () => {
  it('rewrite builds a fields responseSchema with all eligible paths', () => {
    const built = buildIntent({
      intent: 'rewrite',
      toneChip: 'punchier',
      fields: fakeFields,
    })
    // Tone chip expansion is the lowercase verb form ("Make it punchier")
    expect(built.userMessage).toContain('punchier')
    expect(built.responseSchema).toMatchObject({
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          properties: { text: { type: 'string', maxLength: 220 } },
          required: ['text'],
        },
      },
      required: ['fields'],
    })
  })

  it('translate names the target language label', () => {
    const built = buildIntent({
      intent: 'translate',
      language: 'fr',
      fields: fakeFields,
    })
    expect(built.userMessage).toContain('French')
  })

  it('suggest builds a 3-options array schema', () => {
    const built = buildIntent({
      intent: 'suggest',
      fields: fakeFields,
    })
    expect(built.responseSchema).toMatchObject({
      type: 'object',
      properties: {
        options: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: { type: 'string' },
        },
      },
      required: ['options'],
    })
  })

  it('suggest throws when the block has no primary field', () => {
    expect(() =>
      buildIntent({
        intent: 'suggest',
        fields: [
          { path: 'items[0].label', kind: 'plain', maxLength: 60, primary: false, value: '' },
        ],
      }),
    ).toThrow()
  })

  it('fillin emits its starter-draft prompt', () => {
    const built = buildIntent({
      intent: 'fillin',
      freeText: 'announce spring sale',
      fields: fakeFields,
    })
    expect(built.userMessage).toContain('announce spring sale')
    expect(built.userMessage).toContain('empty or nearly empty')
  })

  it('all 10 tone chips exist + are unique', () => {
    expect(TONE_CHIPS.length).toBe(10)
    expect(new Set(TONE_CHIPS).size).toBe(10)
  })

  it('exactly 30 translate languages — marketing promise', () => {
    expect(TRANSLATE_LANGUAGES.length).toBe(30)
  })
})

describe('parseFieldsResponse', () => {
  it('extracts a known field path', () => {
    const out = parseFieldsResponse(
      JSON.stringify({ fields: { text: 'Hello' } }),
      new Set(['text']),
    )
    expect(out).toEqual({ fields: { text: 'Hello' } })
  })

  it('drops paths not in the allow-list', () => {
    const out = parseFieldsResponse(
      JSON.stringify({ fields: { text: 'ok', evil: 'no' } }),
      new Set(['text']),
    )
    expect(out).toEqual({ fields: { text: 'ok' } })
  })

  it('returns null on invalid JSON', () => {
    expect(parseFieldsResponse('not json', new Set(['text']))).toBeNull()
  })

  it('returns null when nothing matches the allow-list', () => {
    expect(
      parseFieldsResponse(
        JSON.stringify({ fields: { other: 'x' } }),
        new Set(['text']),
      ),
    ).toBeNull()
  })

  it('rejects prototype-pollution keys even if allowed', () => {
    const out = parseFieldsResponse(
      JSON.stringify({ fields: { __proto__: 'evil', text: 'good' } }),
      new Set(['__proto__', 'text']),
    )
    expect(out).toEqual({ fields: { text: 'good' } })
  })
})

describe('parseSuggestResponse', () => {
  it('extracts exactly 3 options', () => {
    const out = parseSuggestResponse(
      JSON.stringify({ options: ['a', 'b', 'c'] }),
    )
    expect(out).toEqual({ options: ['a', 'b', 'c'] })
  })

  it('returns null on fewer than 3 strings', () => {
    expect(
      parseSuggestResponse(JSON.stringify({ options: ['a', 'b'] })),
    ).toBeNull()
  })

  it('truncates more than 3 to exactly 3', () => {
    const out = parseSuggestResponse(
      JSON.stringify({ options: ['a', 'b', 'c', 'd', 'e'] }),
    )
    expect(out).toEqual({ options: ['a', 'b', 'c'] })
  })

  it('returns null on malformed JSON', () => {
    expect(parseSuggestResponse('garbage')).toBeNull()
  })

  it('returns null on non-array options', () => {
    expect(parseSuggestResponse('{"options": "x"}')).toBeNull()
  })
})
