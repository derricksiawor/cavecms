import { describe, it, expect } from 'vitest'
import {
  AiUnconfiguredError,
  AiDisabledError,
  AiDecryptError,
} from '@/lib/ai/client'

// Locks the typed-error contract that PR 3/4 will switch on. Each
// error class carries a stable `code` field and a stable `name`.
// Constructor arity changes (e.g. dropping the redundant `code`
// param) trip these tests, signalling the consumer in PR 3/4 must
// re-read.

describe('lib/ai/client typed errors', () => {
  it('AiUnconfiguredError carries the constructor code in both message and field', () => {
    const a = new AiUnconfiguredError('ai_not_configured')
    expect(a.code).toBe('ai_not_configured')
    expect(a.message).toBe('ai_not_configured')
    expect(a.name).toBe('AiUnconfiguredError')

    const b = new AiUnconfiguredError('ai_key_missing')
    expect(b.code).toBe('ai_key_missing')
    expect(b.message).toBe('ai_key_missing')
  })

  it('AiDisabledError has stable code/name/message', () => {
    const e = new AiDisabledError()
    expect(e.code).toBe('ai_disabled')
    expect(e.message).toBe('ai_disabled')
    expect(e.name).toBe('AiDisabledError')
  })

  it('AiDecryptError carries an internal cipher code (not echoed to clients)', () => {
    const e = new AiDecryptError('cipher_bad_version')
    expect(e.code).toBe('ai_key_decrypt_failed')
    expect(e.innerCode).toBe('cipher_bad_version')
    expect(e.message).toBe('ai_key_decrypt_failed')
    expect(e.name).toBe('AiDecryptError')
  })

  it('error classes are instanceof Error (for withError catch-all path)', () => {
    expect(new AiUnconfiguredError('ai_not_configured')).toBeInstanceOf(Error)
    expect(new AiDisabledError()).toBeInstanceOf(Error)
    expect(new AiDecryptError('cipher_bad_version')).toBeInstanceOf(Error)
  })
})
