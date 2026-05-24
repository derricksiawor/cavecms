// Single source of truth for the `window.grecaptcha` global. Three
// call sites touch it (login form, public-form hook, admin verify
// modal); when each declared its own `interface Window { grecaptcha?: ... }`
// the merged interface shapes occasionally conflicted on Next minor
// upgrades. Centralising the type here lets every consumer import
// from one place without redeclaring.

export interface GrecaptchaV3Like {
  ready: (cb: () => void) => void
  execute?: (siteKey: string, opts: { action: string }) => Promise<string>
}

export interface GrecaptchaV2Like {
  ready: (cb: () => void) => void
  render?: (
    container: HTMLElement,
    opts: {
      sitekey: string
      callback?: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    },
  ) => number
  reset?: (widgetId?: number) => void
  getResponse?: (widgetId?: number) => string
}

// The shape window.grecaptcha can take in any of v2 / v3 / explicit-
// render modes. Methods are optional because they're populated by the
// async script load — `ready` is the only guaranteed-present hook
// after the load resolves.
export interface GrecaptchaShared extends GrecaptchaV3Like, GrecaptchaV2Like {}

declare global {
  interface Window {
    grecaptcha?: GrecaptchaShared
  }
}
