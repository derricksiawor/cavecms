// Plain runtime-readable cookie names. No process.env validation here — Zod
// gates that in lib/env.ts (server) and Next inlines NODE_ENV at client build.
// This module is safe to import from BOTH server and client modules.
//
// `IS_PROD` is the SINGLE SOURCE OF TRUTH for the "use __Host- prefix"
// decision. lib/auth/cookies.ts and instrumentation.ts both import this
// flag rather than re-deriving via separate `process.env.NODE_ENV` /
// `env.NODE_ENV` reads — keeps the prefix invariant from drifting if
// either reader changes in the future.
export const IS_PROD = process.env.NODE_ENV === 'production'
const PROD = IS_PROD

export const SESSION_COOKIE_NAME = PROD ? '__Host-bwc_session' : 'bwc_session'
export const CSRF_COOKIE_NAME = PROD ? '__Host-bwc_csrf' : 'bwc_csrf'
export const EDIT_MODE_COOKIE_NAME = PROD ? '__Host-bwc_edit_mode' : 'bwc_edit_mode'
// Step-up reauth (Plan 08): admin proves they hold the password again
// before mutating users / settings. Lifetime is short (5 min); cookie
// stores a unix-seconds timestamp the server compares against NOW().
export const REAUTH_COOKIE_NAME = PROD ? '__Host-bwc_reauth' : 'bwc_reauth'
// Companion cookie carrying the session JWT's `jti` claim in clear
// text (NOT httpOnly — the FE needs to read it from JS to derive the
// HMAC key that signs/verifies the pages-CMS localStorage draft
// buffer per spec §3.5). Bound to the session's lifetime: minted in
// the same response as the session cookie, cleared in the same
// response as the session cookie on logout / revocation. The
// `__Host-` prefix in prod prevents a sibling subdomain or
// `Domain=.bestworldcompany.com`-scoped attacker from planting a
// shadowing jti cookie. Dev drops the prefix so HTTP-mode localhost
// works.
//
// Value === the same uuid that's in the JWT payload. Disclosure of
// the jti alone does NOT widen the attack surface — an XSS payload
// in the admin context could already mint authenticated requests via
// the session cookie. The HMAC derivation defends against attackers
// who can WRITE localStorage but cannot READ the in-memory derived
// key (extensions, sibling tabs pre-CSP, stored-XSS that fires after
// jti rotation). Live in-context XSS is covered upstream by the
// CSP nonce + strict-dynamic + DOMPurify pipeline.
export const JTI_COOKIE_NAME = PROD ? '__Host-bwc_session_jti' : 'bwc_session_jti'
