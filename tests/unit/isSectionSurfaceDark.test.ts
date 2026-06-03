import { describe, it, expect } from 'vitest'
import { isSectionSurfaceDark } from '@/lib/cms/blockMeta'

// FIX 3 — theme-mode-aware surface-dark probe. A section with NO explicit
// background sits on the page body, which flips light↔dark with the active
// theme. The renderer (lx_posts) passes the resolved theme mode so a no-bg
// section on a dark theme reads light-on-dark instead of dark-on-dark. Every
// other case (explicit bg token, dark cover overlay) is unchanged, and every
// caller that omits `themeMode` keeps the legacy light-default behaviour.
describe('isSectionSurfaceDark', () => {
  describe('no explicit background (page body — theme-driven)', () => {
    it('null meta + no themeMode → false (legacy default, light body)', () => {
      expect(isSectionSurfaceDark(null)).toBe(false)
      expect(isSectionSurfaceDark(undefined)).toBe(false)
    })

    it('null meta + light theme → false (light body, dark text stays legible)', () => {
      expect(isSectionSurfaceDark(null, 'light')).toBe(false)
    })

    it('null meta + dark theme → true (dark body, text must go light)', () => {
      expect(isSectionSurfaceDark(null, 'dark')).toBe(true)
    })

    it('meta with no background token + dark theme → true', () => {
      expect(isSectionSurfaceDark({}, 'dark')).toBe(true)
    })

    it('meta with no background token + light theme → false', () => {
      expect(isSectionSurfaceDark({}, 'light')).toBe(false)
      // omitted themeMode preserves the legacy light default.
      expect(isSectionSurfaceDark({})).toBe(false)
    })
  })

  describe('explicit background token (theme mode must NOT override)', () => {
    it('explicit dark bg is dark regardless of theme mode', () => {
      expect(isSectionSurfaceDark({ background: 'obsidian' })).toBe(true)
      expect(isSectionSurfaceDark({ background: 'obsidian' }, 'light')).toBe(true)
      expect(isSectionSurfaceDark({ background: 'obsidian' }, 'dark')).toBe(true)
    })

    it('explicit light bg is light regardless of theme mode (no dark-theme override)', () => {
      expect(isSectionSurfaceDark({ background: 'cream' })).toBe(false)
      // FIX 3 must NOT flip an explicit light bg to dark just because the
      // install theme is dark — only NO-bg sections follow the theme.
      expect(isSectionSurfaceDark({ background: 'cream' }, 'dark')).toBe(false)
      expect(isSectionSurfaceDark({ background: 'ivory' }, 'dark')).toBe(false)
    })

    it('neutral bg token is treated as light (not dark) on a dark theme', () => {
      expect(isSectionSurfaceDark({ background: 'champagne' }, 'dark')).toBe(false)
    })
  })

  describe('cover photo + darkening overlay (wins regardless of theme)', () => {
    it('dark overlay → dark even with a light theme', () => {
      expect(
        isSectionSurfaceDark(
          {
            background: 'cream',
            backgroundImage: { media_id: 1, alt: '' },
            backgroundOverlay: 'darken',
          },
          'light',
        ),
      ).toBe(true)
    })

    it('a cover image WITHOUT a darkening overlay falls through to the bg/theme logic', () => {
      // No darkening overlay → not forced dark; explicit light bg stays light.
      expect(
        isSectionSurfaceDark({
          background: 'cream',
          backgroundImage: { media_id: 1, alt: '' },
        }),
      ).toBe(false)
    })
  })
})
