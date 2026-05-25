import { describe, it, expect } from 'vitest'
import { registry, AI_MODEL_IDS } from '@/lib/cms/settings-registry'
import { encryptSecret } from '@/lib/security/secretCipher'

const aiConfig = registry.ai_config.schema

describe('settings-registry: ai_config', () => {
  it('accepts the registered default (disabled, no model picks)', () => {
    expect(aiConfig.parse(registry.ai_config.default)).toMatchObject({
      enabled: false,
      provider: 'gemini',
      inlineEnabled: false,
      chatEnabled: false,
      voicePreset: 'default',
    })
  })

  it('exposes exactly five model IDs (verified against Google docs 2026-05)', () => {
    expect(AI_MODEL_IDS).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash',
    ])
  })

  it('accepts a fully-configured AI block', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE-test-key-for-shape')
    const parsed = aiConfig.parse({
      enabled: true,
      provider: 'gemini',
      apiKey,
      apiKeyLast4: 'hape', // exactly 4 chars (last 4 of "shape")
      models: { inline: 'gemini-2.5-flash', chat: 'gemini-3.5-flash' },
      inlineEnabled: true,
      chatEnabled: true,
      voicePreset: 'editorial',
      verifiedAt: '2026-05-25T00:00:00Z',
    })
    expect(parsed.enabled).toBe(true)
    expect(parsed.apiKey).toMatchObject({ v: 1, alg: 'aes-256-gcm' })
  })

  it('rejects enabled: true without an apiKey', () => {
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      enabled: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('api_key_required')
    }
  })

  it('rejects inlineEnabled: true when master enabled is false (dominating constraint, only one issue surfaces)', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      enabled: false,
      apiKey,
      inlineEnabled: true,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // Dominating constraint: only `enable_master_switch_first` fires;
      // the downstream `inline_model_required` does NOT pile on. Keeps
      // the admin form from lighting up three errors for one root cause.
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain('enable_master_switch_first')
      expect(messages).not.toContain('inline_model_required_when_inline_enabled')
    }
  })

  it('rejects inlineEnabled: true without an inline model pick (no-fallback rule)', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      enabled: true,
      apiKey,
      inlineEnabled: true,
      chatEnabled: false,
      // models intentionally omitted — no fallback default for model.
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.message.includes('inline_model_required'),
        ),
      ).toBe(true)
    }
  })

  it('rejects chatEnabled: true without a chat model pick (no-fallback rule)', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      enabled: true,
      apiKey,
      chatEnabled: true,
      inlineEnabled: false,
      models: { inline: 'gemini-2.5-flash' }, // chat absent
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.message.includes('chat_model_required'),
        ),
      ).toBe(true)
    }
  })

  it('accepts enabled: true with a stored apiKey but no surfaces flipped (operator iterating)', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    const parsed = aiConfig.parse({
      ...registry.ai_config.default,
      enabled: true,
      apiKey,
    })
    expect(parsed.enabled).toBe(true)
    expect(parsed.inlineEnabled).toBe(false)
  })

  it('rejects an unknown provider', () => {
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      provider: 'openai',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown model ID', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      enabled: true,
      apiKey,
      inlineEnabled: true,
      models: { inline: 'gemini-1.0-flash', chat: 'gemini-2.5-pro' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects apiKeyLast4 that is not exactly 4 chars', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    expect(
      aiConfig.safeParse({
        ...registry.ai_config.default,
        enabled: true,
        apiKey,
        apiKeyLast4: 'abc',
      }).success,
    ).toBe(false)
    expect(
      aiConfig.safeParse({
        ...registry.ai_config.default,
        enabled: true,
        apiKey,
        apiKeyLast4: 'abcde',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown voice preset', () => {
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      voicePreset: 'edgy',
    })
    expect(result.success).toBe(false)
  })

  it('rejects customVoiceNotes longer than 800 chars', () => {
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      voicePreset: 'custom',
      customVoiceNotes: 'a'.repeat(801),
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed encrypted envelope', () => {
    const result = aiConfig.safeParse({
      ...registry.ai_config.default,
      enabled: true,
      apiKey: { v: 2, alg: 'aes-256-gcm', iv: 'x', tag: 'y', ct: 'z' },
    })
    expect(result.success).toBe(false)
  })

  it('accepts every documented model ID for each surface', () => {
    const apiKey = encryptSecret('AIzaSyA-FAKE')
    for (const inline of AI_MODEL_IDS) {
      for (const chat of AI_MODEL_IDS) {
        const result = aiConfig.safeParse({
          enabled: true,
          provider: 'gemini',
          apiKey,
          models: { inline, chat },
          inlineEnabled: true,
          chatEnabled: true,
          voicePreset: 'default',
        })
        expect(result.success, `inline=${inline} chat=${chat}`).toBe(true)
      }
    }
  })
})
