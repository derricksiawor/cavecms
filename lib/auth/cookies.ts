import 'server-only'
import {
  IS_PROD as PROD,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  EDIT_MODE_COOKIE_NAME,
  JTI_COOKIE_NAME,
} from './cookie-names'

// __Host- cookies require Secure=true; browsers reject them otherwise.
// In production we use the prefix for defence-in-depth; in dev we drop
// it so http://localhost works without TLS. PROD reads through the
// shared `IS_PROD` flag in cookie-names.ts so the prefix decision and
// the secure-flag decision can't drift.

export const SESSION_COOKIE = SESSION_COOKIE_NAME
export const CSRF_COOKIE = CSRF_COOKIE_NAME
export const EDIT_MODE_COOKIE = EDIT_MODE_COOKIE_NAME
export const JTI_COOKIE = JTI_COOKIE_NAME

export function cookieFlags(maxAge: number) {
  return {
    httpOnly: true,
    secure: PROD,
    // 'lax' (not 'strict') per ~/.claude/CLAUDE.md Security Standards:
    // strict-sameSite blocks the cookie on cross-site top-level GET
    // navigations, which silently breaks OAuth callbacks (Slack /
    // Google / GitHub / Stripe Connect — anything that redirects
    // back to our origin from the provider's authorize URL). CSRF
    // protection comes from the dedicated CSRF middleware's
    // double-submit token, not from SameSite. Lax keeps us safe
    // against cross-site form-POST / fetch / iframe-load while
    // permitting the OAuth top-level GET to carry our session.
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  }
}

export function csrfCookieFlags(maxAge: number) {
  return {
    httpOnly: false, // CSRF cookie must be readable by JS for double-submit
    secure: PROD,
    // 'lax' (not 'strict') per ~/.claude/CLAUDE.md Security Standards:
    // strict-sameSite blocks the cookie on cross-site top-level GET
    // navigations, which silently breaks OAuth callbacks (Slack /
    // Google / GitHub / Stripe Connect — anything that redirects
    // back to our origin from the provider's authorize URL). CSRF
    // protection comes from the dedicated CSRF middleware's
    // double-submit token, not from SameSite. Lax keeps us safe
    // against cross-site form-POST / fetch / iframe-load while
    // permitting the OAuth top-level GET to carry our session.
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  }
}

// JTI companion cookie flags. NOT httpOnly because the FE reads the
// value via document.cookie to derive the HMAC key per spec §3.5.
// SameSite=Strict matches the session cookie's posture (the value
// only needs to travel on same-site requests; preview-token URLs are
// served same-origin). Max-Age must come from the JWT's actual
// `exp - iat` (see signSessionJwt return shape) rather than a bare
// JWT_TTL_SECONDS — see spec §3.5 cookie-Max-Age-fix.
export function jtiCookieFlags(maxAge: number) {
  return {
    httpOnly: false,
    secure: PROD,
    // 'lax' (not 'strict') per ~/.claude/CLAUDE.md Security Standards:
    // strict-sameSite blocks the cookie on cross-site top-level GET
    // navigations, which silently breaks OAuth callbacks (Slack /
    // Google / GitHub / Stripe Connect — anything that redirects
    // back to our origin from the provider's authorize URL). CSRF
    // protection comes from the dedicated CSRF middleware's
    // double-submit token, not from SameSite. Lax keeps us safe
    // against cross-site form-POST / fetch / iframe-load while
    // permitting the OAuth top-level GET to carry our session.
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  }
}
