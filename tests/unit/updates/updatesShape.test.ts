import { describe, it, expect } from 'vitest'
import { registry } from '@/lib/cms/settings-registry'

const schema = registry.updates.schema

describe('settings.updates Zod schema', () => {
  it('accepts default values', () => {
    const parsed = schema.parse(registry.updates.default)
    expect(parsed.autoApplySecurityPatches).toBe(true)
    expect(parsed.checkFrequencyHours).toBe(12)
  })

  it('accepts valid notificationEmail', () => {
    const r = schema.parse({
      autoApplySecurityPatches: true,
      checkFrequencyHours: 24,
      notificationEmail: 'ops@example.com',
    })
    expect(r.notificationEmail).toBe('ops@example.com')
  })

  it('treats empty string notificationEmail as undefined', () => {
    const r = schema.parse({
      autoApplySecurityPatches: true,
      checkFrequencyHours: 24,
      notificationEmail: '',
    })
    expect(r.notificationEmail).toBeUndefined()
  })

  it('rejects malformed email', () => {
    expect(() =>
      schema.parse({
        autoApplySecurityPatches: true,
        checkFrequencyHours: 24,
        notificationEmail: 'not-an-email',
      }),
    ).toThrow()
  })

  it('rejects checkFrequencyHours < 1', () => {
    expect(() =>
      schema.parse({ autoApplySecurityPatches: true, checkFrequencyHours: 0 }),
    ).toThrow()
  })

  it('rejects checkFrequencyHours > 168', () => {
    expect(() =>
      schema.parse({ autoApplySecurityPatches: true, checkFrequencyHours: 169 }),
    ).toThrow()
  })

  it('rejects non-integer hours', () => {
    expect(() =>
      schema.parse({ autoApplySecurityPatches: true, checkFrequencyHours: 1.5 }),
    ).toThrow()
  })
})
