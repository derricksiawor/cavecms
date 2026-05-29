import { describe, it, expect } from 'vitest'
import { hexToRgb, wcagRatio, apcaLc } from '@/lib/cms/contrast'

describe('hexToRgb', () => {
  it('parses 6-char hex', () => {
    expect(hexToRgb('#C9A961')).toEqual([201, 169, 97])
  })
  it('parses 3-char shorthand', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255])
  })
  it('returns null on garbage', () => {
    expect(hexToRgb('not-a-color')).toBeNull()
  })
})

describe('wcagRatio', () => {
  it('black on white is 21:1', () => {
    expect(wcagRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })
  it('same color is 1:1', () => {
    expect(wcagRatio('#777777', '#777777')).toBeCloseTo(1, 2)
  })
  it('#767676 on white clears AA (>=4.5)', () => {
    expect(wcagRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })
})

describe('apcaLc', () => {
  it('black text on white bg ~ Lc 106', () => {
    const lc = apcaLc('#000000', '#ffffff')
    expect(lc).toBeGreaterThan(105)
    expect(lc).toBeLessThan(107)
  })
  it('white text on black bg ~ Lc -108 (reverse polarity)', () => {
    const lc = apcaLc('#ffffff', '#000000')
    expect(lc).toBeLessThan(-106)
    expect(lc).toBeGreaterThan(-109)
  })
  it('returns 0 for invalid input', () => {
    expect(apcaLc('xxx', '#fff')).toBe(0)
  })
})
