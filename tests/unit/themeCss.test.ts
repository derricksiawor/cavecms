import { describe, it, expect } from 'vitest'
import {
  THEME_PALETTE_DEFAULT,
  darkenHex,
  brandVarsCss,
} from '@/lib/cms/themeCss'

describe('darkenHex', () => {
  it('mixes toward black by the given fraction (sRGB)', () => {
    // 200 * (1 - 0.5) = 100 -> 0x64
    expect(darkenHex('#C8C8C8', 0.5)).toBe('#646464')
  })
  it('returns input unchanged on invalid hex', () => {
    expect(darkenHex('nope', 0.5)).toBe('nope')
  })
})

describe('brandVarsCss', () => {
  it('emits all five brand vars + base vars from defaults', () => {
    const css = brandVarsCss(THEME_PALETTE_DEFAULT)
    expect(css).toContain('--brand-surface-dark:#050505')
    expect(css).toContain('--brand-surface-light:#F5F1EA')
    expect(css).toContain('--brand-accent:#C9A961')
    expect(css).toContain('--brand-secondary:#6E665A')
    expect(css).toContain('--brand-primary:#050505')
    // Light mode default -> base bg is the light surface.
    expect(css).toContain('--brand-base-bg:#F5F1EA')
    expect(css).toContain('--brand-base-fg:#050505')
    expect(css.startsWith(':root{')).toBe(true)
    expect(css.endsWith('}')).toBe(true)
  })
  it('does NOT override antique-gold/bone when accent/surface are default', () => {
    const css = brandVarsCss(THEME_PALETTE_DEFAULT)
    expect(css).not.toContain('--color-antique-gold')
    expect(css).not.toContain('--color-bone')
  })
  it('derives antique-gold when accent changes', () => {
    const css = brandVarsCss({ ...THEME_PALETTE_DEFAULT, accent: '#3366FF' })
    expect(css).toContain('--brand-accent:#3366FF')
    // 0x33*.85=43=0x2B, 0x66*.85=86.7~87=0x57, 0xFF*.85=216.75~217=0xD9
    expect(css).toContain('--color-antique-gold:#2B57D9')
  })
  it('dark mode flips base bg/fg to the dark surface', () => {
    const css = brandVarsCss({ ...THEME_PALETTE_DEFAULT, mode: 'dark' })
    expect(css).toContain('--brand-base-bg:#050505')
    expect(css).toContain('--brand-base-fg:#F5F1EA')
  })
  it('drops any field failing the hex regex (no CSS injection)', () => {
    const css = brandVarsCss({
      ...THEME_PALETTE_DEFAULT,
      accent: 'red;}/**/body{display:none' as unknown as string,
    })
    expect(css).not.toContain('display:none')
    expect(css).not.toContain('--brand-accent:')
  })
})
