import 'server-only'
import {
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  EDIT_MODE_COOKIE_NAME,
  JTI_COOKIE_NAME,
} from './cookie-names'

// Cookie names are plain (no `__Host-` prefix) — see cookie-names.ts.
// The `Secure` attribute is set per-request based on the actual
// protocol: HTTPS requests (production behind nginx/Cloudflare) get
// Secure cookies; HTTP requests (localhost / LAN / dev) get non-Secure
// cookies the browser will actually store. Callers resolve the flag via
// isSecureRequest / isSecureFromHeaders and pass it in. NODE_ENV is
// deliberately NOT used — an http://localhost install runs
// NODE_ENV=production but must use non-Secure cookies.

export const SESSION_COOKIE = SESSION_COOKIE_NAME
export const CSRF_COOKIE = CSRF_COOKIE_NAME
export const EDIT_MODE_COOKIE = EDIT_MODE_COOKIE_NAME
export const JTI_COOKIE = JTI_COOKIE_NAME

// Is this request served over HTTPS? Behind a reverse proxy the edge
// terminates TLS and forwards `X-Forwarded-Proto: https`; a direct
// http://localhost install sends no such header and its URL is http.
export function isSecureRequest(req: { headers: Headers; url?: string }): boolean {
  const xfp = req.headers.get('x-forwarded-proto')
  if (xfp) return xfp.split(',')[0]!.trim().toLowerCase() === 'https'
  if (req.url) {
    try {
      return new URL(req.url).protocol === 'https:'
    } catch {
      /* malformed URL — fall through */
    }
  }
  return false
}

// Same determination from a bare Headers bag (next/headers contexts).
export function isSecureFromHeaders(h: Headers): boolean {
  const xfp = h.get('x-forwarded-proto')
  return xfp ? xfp.split(',')[0]!.trim().toLowerCase() === 'https' : false
}

export function cookieFlags(maxAge: number, secure: boolean) {
  return {
    httpOnly: true,
    secure,
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

export function csrfCookieFlags(maxAge: number, secure: boolean) {
  return {
    httpOnly: false, // CSRF cookie must be readable by JS for double-submit
    secure,
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
export function jtiCookieFlags(maxAge: number, secure: boolean) {
  return {
    httpOnly: false,
    secure,
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
