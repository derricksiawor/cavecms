import { describe, it, expect } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  last4,
  fingerprint,
} from '@/lib/security/secretCipher'

describe('secretCipher (AES-256-GCM)', () => {
  it('roundtrips a plaintext through encrypt + decrypt', () => {
    const plaintext = 'AIzaSyA-FAKE-GEMINI-KEY-roundtrip-test-12345'
    const encrypted = encryptSecret(plaintext)
    expect(encrypted.v).toBe(1)
    expect(encrypted.alg).toBe('aes-256-gcm')
    expect(decryptSecret(encrypted)).toBe(plaintext)
  })

  it('emits a fresh IV per encryption (same plaintext → different ciphertext)', () => {
    const plaintext = 'AIzaSyA-FAKE-GEMINI-KEY-iv-uniqueness'
    const a = encryptSecret(plaintext)
    const b = encryptSecret(plaintext)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
    // Both must still decrypt to the same plaintext — IV randomness is
    // about ciphertext distinctness, not key derivation.
    expect(decryptSecret(a)).toBe(plaintext)
    expect(decryptSecret(b)).toBe(plaintext)
  })

  it('refuses to decrypt when the ciphertext is tampered', () => {
    const plaintext = 'tamper-test-secret'
    const encrypted = encryptSecret(plaintext)
    // Flip one byte of the ciphertext base64 → GCM tag must catch it.
    const buf = Buffer.from(encrypted.ct, 'base64')
    buf[0] = (buf[0] ?? 0) ^ 0x01
    const tampered = { ...encrypted, ct: buf.toString('base64') }
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('refuses to decrypt when the tag is tampered', () => {
    const encrypted = encryptSecret('tag-tamper-test')
    const buf = Buffer.from(encrypted.tag, 'base64')
    buf[0] = (buf[0] ?? 0) ^ 0x01
    const tampered = { ...encrypted, tag: buf.toString('base64') }
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('binds ciphertext to AAD (encrypted with AAD, decrypted without → fails)', () => {
    const plaintext = 'aad-bound-secret'
    const encrypted = encryptSecret(plaintext, 'ai_config:apiKey')
    expect(() => decryptSecret(encrypted)).toThrow()
    expect(() => decryptSecret(encrypted, 'wrong:aad')).toThrow()
    expect(decryptSecret(encrypted, 'ai_config:apiKey')).toBe(plaintext)
  })

  it('rejects an unsupported envelope version with a stable code', () => {
    const encrypted = encryptSecret('version-test')
    // Cast through unknown so the test can simulate a forward-version
    // payload landing in a current reader.
    const bumped = { ...encrypted, v: 2 } as unknown as typeof encrypted
    expect(() => decryptSecret(bumped)).toThrow('cipher_bad_version')
  })

  it('rejects an unsupported algorithm with a stable code', () => {
    const encrypted = encryptSecret('alg-test')
    const bumped = { ...encrypted, alg: 'aes-128-gcm' } as unknown as typeof encrypted
    expect(() => decryptSecret(bumped)).toThrow('cipher_bad_alg')
  })

  it('refuses non-12-byte IVs with a stable code', () => {
    const encrypted = encryptSecret('iv-len-test')
    const shortIv = Buffer.alloc(8).toString('base64')
    const broken = { ...encrypted, iv: shortIv }
    expect(() => decryptSecret(broken)).toThrow('cipher_bad_iv_len')
  })

  it('roundtrips long plaintext (covers UTF-8 + chunking edge cases)', () => {
    const plaintext = '🔑' + 'a'.repeat(2048) + '✨' + 'b'.repeat(2048)
    const encrypted = encryptSecret(plaintext)
    expect(decryptSecret(encrypted)).toBe(plaintext)
  })

  it('roundtrips empty plaintext', () => {
    const encrypted = encryptSecret('')
    expect(decryptSecret(encrypted)).toBe('')
  })

  it('last4 returns the last 4 chars; returns empty for short or empty input', () => {
    expect(last4('AIzaSyAbcdef1234')).toBe('1234')
    // Strings <= 4 chars never reveal full plaintext via the display
    // helper — protects test/dev fixtures that might have short keys.
    expect(last4('xyz')).toBe('')
    expect(last4('abcd')).toBe('')
    expect(last4('abcde')).toBe('bcde')
    expect(last4('')).toBe('')
  })

  it('last4 trims surrounding whitespace before slicing', () => {
    expect(last4('  AIzaSyAbcdef1234  ')).toBe('1234')
    expect(last4('   \n')).toBe('')
  })

  it('fingerprint is deterministic and 8 hex chars', () => {
    const a = fingerprint('AIzaSyA-FAKE-GEMINI-KEY-fingerprint')
    const b = fingerprint('AIzaSyA-FAKE-GEMINI-KEY-fingerprint')
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{8}$/)
    expect(fingerprint('different')).not.toBe(a)
  })
})
