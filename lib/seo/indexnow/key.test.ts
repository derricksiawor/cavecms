import { describe, it, expect } from 'vitest'
import {
  generateIndexNowKey,
  isValidIndexNowKey,
  keyFileContent,
  ENDPOINTS,
} from '@/lib/seo/indexnow/key'

const REGISTRY_REGEX = /^[a-zA-Z0-9-]{8,128}$/

describe('generateIndexNowKey', () => {
  it('returns 32 lowercase-hex chars matching the registry regex', () => {
    for (let i = 0; i < 50; i++) {
      const key = generateIndexNowKey()
      expect(key).toHaveLength(32)
      expect(key).toMatch(/^[0-9a-f]{32}$/)
      expect(key).toMatch(REGISTRY_REGEX)
      expect(isValidIndexNowKey(key)).toBe(true)
    }
  })

  it('produces distinct keys across calls (entropy sanity)', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateIndexNowKey()))
    // 128 bits of entropy — collisions across 100 draws are astronomically
    // unlikely, so all 100 should be unique.
    expect(keys.size).toBe(100)
  })
})

describe('isValidIndexNowKey', () => {
  it('accepts keys at the length boundaries (8 and 128)', () => {
    expect(isValidIndexNowKey('a'.repeat(8))).toBe(true)
    expect(isValidIndexNowKey('a'.repeat(128))).toBe(true)
  })

  it('accepts the full allowed alphabet [a-zA-Z0-9-]', () => {
    expect(isValidIndexNowKey('AbZ-019-azAZ')).toBe(true)
  })

  it('rejects keys that are too short (<8) or too long (>128)', () => {
    expect(isValidIndexNowKey('a'.repeat(7))).toBe(false)
    expect(isValidIndexNowKey('a'.repeat(129))).toBe(false)
    expect(isValidIndexNowKey('')).toBe(false)
  })

  it('rejects keys containing disallowed characters', () => {
    expect(isValidIndexNowKey('has space123')).toBe(false)
    expect(isValidIndexNowKey('underscore_key')).toBe(false)
    expect(isValidIndexNowKey('dot.key.value')).toBe(false)
    expect(isValidIndexNowKey('slash/key/here')).toBe(false)
    expect(isValidIndexNowKey('unicodé-key-here')).toBe(false)
  })

  it('rejects non-string input defensively', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(isValidIndexNowKey(undefined)).toBe(false)
    // @ts-expect-error — exercising the runtime guard
    expect(isValidIndexNowKey(12345678)).toBe(false)
  })
})

describe('keyFileContent', () => {
  it('returns the key verbatim as the file body', () => {
    const key = generateIndexNowKey()
    expect(keyFileContent(key)).toBe(key)
  })
})

describe('ENDPOINTS', () => {
  it('maps every engine to its host name', () => {
    expect(ENDPOINTS).toEqual({
      indexnow: 'api.indexnow.org',
      bing: 'www.bing.com',
      yandex: 'yandex.com',
      seznam: 'search.seznam.cz',
      naver: 'searchadvisor.naver.com',
    })
  })

  it('does NOT include DuckDuckGo or Yahoo (they ride Bing)', () => {
    const hosts = Object.values(ENDPOINTS).join(' ')
    expect(hosts).not.toMatch(/duckduckgo/i)
    expect(hosts).not.toMatch(/yahoo/i)
  })
})
