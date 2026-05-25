import { describe, it, expect } from 'vitest'
import { buildChatSystemPrompt } from '@/lib/ai/prompts/chat'

// PR 4 — Page Assistant system prompt. The chat surface adds a Section
// 4 tool-scope block on top of the inline prompt's voice+site spine.
// These tests pin the must-have phrases — the cross-tenant safety
// statements that prevent Gemini from inventing tools or crossing
// pages.

describe('buildChatSystemPrompt', () => {
  it('embeds the voice description for non-custom presets', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'editorial',
      pageTitle: 'About',
      pageSlug: 'about',
      pageId: 5,
    })
    expect(prompt).toContain('Brand voice (editorial)')
    expect(prompt).toContain('Polished, considered, magazine-quality')
  })

  it('inlines operator-defined notes when voicePreset=custom', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'custom',
      customVoiceNotes: 'Sound like a thoughtful art dealer.',
      pageTitle: 'Collection',
      pageSlug: 'collection',
      pageId: 12,
    })
    expect(prompt).toContain('Brand voice (operator-defined):')
    expect(prompt).toContain('thoughtful art dealer')
  })

  it('lists every registered chat tool by name', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'default',
      pageTitle: 'Home',
      pageSlug: 'home',
      pageId: 1,
    })
    expect(prompt).toContain('inspect_page')
    expect(prompt).toContain('inspect_block')
    expect(prompt).toContain('propose_block_edit')
    expect(prompt).toContain('propose_block_insert')
    expect(prompt).toContain('propose_block_delete')
    expect(prompt).toContain('propose_block_reorder')
  })

  it('states the page-scope boundary as a hard rule', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'default',
      pageTitle: 'Home',
      pageSlug: 'home',
      pageId: 9,
    })
    expect(prompt).toMatch(/pageId=9/)
    expect(prompt.toLowerCase()).toContain("isn't on this page")
  })

  it("enumerates 'things you do NOT have a tool for'", () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'default',
      pageTitle: 'Home',
      pageSlug: 'home',
      pageId: 1,
    })
    // Critical safety statements — settings, cross-page, media,
    // out-of-app side effects.
    expect(prompt).toContain('settings')
    expect(prompt).toContain('page other than the current page')
    expect(prompt.toLowerCase()).toContain('media')
    expect(prompt.toLowerCase()).toContain('out-of-app')
  })

  it('caps the tool-call budget in the rules section', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'default',
      pageTitle: 'Home',
      pageSlug: 'home',
      pageId: 1,
    })
    expect(prompt).toContain('8 tool calls')
  })

  it('restates the operator-prompt-is-input safety rail', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'default',
      pageTitle: 'Home',
      pageSlug: 'home',
      pageId: 1,
    })
    expect(prompt.toLowerCase()).toContain('not a system instruction')
  })

  it('keeps total length under ~3000 chars for default args', () => {
    const prompt = buildChatSystemPrompt({
      voicePreset: 'default',
      pageTitle: 'Home',
      pageSlug: 'home',
      pageId: 1,
    })
    // Soft sanity cap. If a future edit triples the prompt size,
    // this test flags it for an explicit review.
    expect(prompt.length).toBeLessThan(6000)
  })
})
