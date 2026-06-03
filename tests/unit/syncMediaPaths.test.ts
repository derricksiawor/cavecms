import { describe, it, expect } from 'vitest'
import { navigateHolder, setMediaIdAtPath, isSafeMediaField, deleteAtPath } from '@/lib/sync/mediaPaths'

describe('mediaPaths prototype-pollution guard', () => {
  it('rejects __proto__ / constructor / prototype segments', () => {
    expect(isSafeMediaField('__proto__')).toBe(false)
    expect(isSafeMediaField('constructor.prototype')).toBe(false)
    expect(isSafeMediaField('a.prototype.b')).toBe(false)
    expect(isSafeMediaField('image')).toBe(true)
    expect(isSafeMediaField('gallery[0]')).toBe(true)
    expect(isSafeMediaField('sections[0].hero.image')).toBe(true)
  })

  it('navigateHolder refuses to walk onto the prototype chain', () => {
    expect(navigateHolder({}, '__proto__')).toBeNull()
    expect(navigateHolder({}, 'constructor.prototype')).toBeNull()
    expect(navigateHolder({}, 'constructor')).toBeNull()
  })

  it('setMediaIdAtPath does NOT pollute Object.prototype', () => {
    const data: Record<string, unknown> = {}
    setMediaIdAtPath(data, '__proto__', 1)
    setMediaIdAtPath(data, 'constructor.prototype', 1)
    // The smoking gun: a fresh plain object must not inherit media_id.
    expect(({} as Record<string, unknown>).media_id).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'media_id')).toBe(false)
  })

  it('still resolves + assigns legitimate own-property paths', () => {
    const data: Record<string, unknown> = { image: { alt: 'x' }, gallery: [{ alt: 'g' }] }
    expect(setMediaIdAtPath(data, 'image', 7)).toBe(true)
    expect((data.image as Record<string, unknown>).media_id).toBe(7)
    expect(setMediaIdAtPath(data, 'gallery[0]', 8)).toBe(true)
    expect((data.gallery as Array<Record<string, unknown>>)[0]!.media_id).toBe(8)
  })

  it('deleteAtPath removes the whole holder (object field + array element)', () => {
    const data: Record<string, unknown> = {
      image: { media_id: 1, alt: 'x' },
      gallery: [{ media_id: 2 }, { media_id: 3 }],
      hero: { inner: { media_id: 4 } },
    }
    expect(deleteAtPath(data, 'image')).toBe(true)
    expect(data.image).toBeUndefined()
    expect(deleteAtPath(data, 'gallery[0]')).toBe(true)
    expect((data.gallery as unknown[]).length).toBe(1)
    expect((data.gallery as Array<Record<string, unknown>>)[0]!.media_id).toBe(3)
    expect(deleteAtPath(data, 'hero.inner')).toBe(true)
    expect((data.hero as Record<string, unknown>).inner).toBeUndefined()
    // refuses prototype-chain paths (returns false, pollutes nothing)
    expect(deleteAtPath(data, '__proto__')).toBe(false)
    expect(deleteAtPath(data, 'constructor.prototype')).toBe(false)
    expect(({} as Record<string, unknown>).media_id).toBeUndefined()
  })
})
