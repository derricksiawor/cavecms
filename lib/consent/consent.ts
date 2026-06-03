// Shared cookie-consent primitives (Feature B). Client-safe — NO server-only
// imports — because both the public banner (client) and the consent-default
// snippet builder (server) use the signal map. Pure data + small helpers.

export const CONSENT_COOKIE = 'cavecms_consent'
export const CONSENT_MAX_AGE_DAYS = 180

// The stored choice. Persisted as JSON in a first-party cookie.
export interface ConsentState {
  /** The `consentVersion` this choice was made against. A bump re-asks. */
  v: number
  /** Epoch seconds when the choice was made. */
  ts: number
  /** category key → granted. 'necessary' is always true. */
  cats: Record<string, boolean>
}

// Well-known category keys → Google Consent Mode v2 signals they control.
// Custom category keys simply have no Google signal (they still gate via the
// `cavecms:consent` event + window.cavecmsConsent for non-Google tags).
export const GOOGLE_SIGNALS: Record<string, string[]> = {
  necessary: ['security_storage', 'functionality_storage'],
  analytics: ['analytics_storage'],
  marketing: ['ad_storage', 'ad_user_data', 'ad_personalization'],
  preferences: ['functionality_storage', 'personalization_storage'],
}

export const ALL_GOOGLE_SIGNALS = [
  'ad_storage',
  'ad_user_data',
  'ad_personalization',
  'analytics_storage',
  'functionality_storage',
  'personalization_storage',
  'security_storage',
] as const

export type GoogleSignalValue = 'granted' | 'denied'

// Translate a category-consent map into the full Google Consent Mode signal
// set. Everything defaults to 'denied'; security_storage is always granted
// (strictly-necessary security cookies); a granted category grants its
// signals. Used for both the default (all denied) and the on-grant update.
export function consentToGoogleSignals(
  cats: Record<string, boolean>,
): Record<string, GoogleSignalValue> {
  const out: Record<string, GoogleSignalValue> = {}
  for (const sig of ALL_GOOGLE_SIGNALS) out[sig] = 'denied'
  out.security_storage = 'granted'
  for (const [key, granted] of Object.entries(cats)) {
    // STRICT boolean === true, never truthiness. A tampered cookie carrying a
    // truthy string (e.g. {analytics:'yes'}) must NOT be coerced into a grant;
    // only a literal `true` — the value readConsent now enforces — grants the
    // category's Google signals. (GDPR Art. 7 / ePrivacy: consent must be an
    // affirmative opt-in, not an accident of JS coercion.)
    if (granted !== true) continue
    for (const sig of GOOGLE_SIGNALS[key] ?? []) out[sig] = 'granted'
  }
  return out
}

// --- cookie read/write (client only; guarded for SSR) ---

export function readConsent(): ConsentState | null {
  if (typeof document === 'undefined') return null
  const raw = document.cookie
    .split('; ')
    .find((c) => c.startsWith(CONSENT_COOKIE + '='))
    ?.slice(CONSENT_COOKIE.length + 1)
  if (!raw) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as ConsentState).v === 'number' &&
      (parsed as ConsentState).cats &&
      typeof (parsed as ConsentState).cats === 'object' &&
      !Array.isArray((parsed as ConsentState).cats)
    ) {
      // Every category value MUST be a real boolean. A tampered cookie with a
      // string/number/null value (e.g. {analytics:'yes'} or {analytics:1}) is
      // rejected wholesale → treated as "no consent" → the banner re-asks.
      // This is the input boundary that lets every downstream consumer
      // (consentToGoogleSignals, ConsentGatedScripts) trust `cats[x] === true`.
      const cats = (parsed as ConsentState).cats
      for (const v of Object.values(cats)) {
        if (typeof v !== 'boolean') return null
      }
      return parsed as ConsentState
    }
  } catch {
    /* malformed cookie → treat as no consent */
  }
  return null
}

export function writeConsent(state: ConsentState): void {
  if (typeof document === 'undefined') return
  const maxAge = CONSENT_MAX_AGE_DAYS * 24 * 60 * 60
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : ''
  // SameSite=Lax: the consent cookie is first-party UX state, never sent on
  // cross-site sub-requests that matter; Lax is the correct, broadly-supported
  // default. Not httpOnly — the client banner must read/write it.
  document.cookie =
    `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(state))}` +
    `; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`
}
