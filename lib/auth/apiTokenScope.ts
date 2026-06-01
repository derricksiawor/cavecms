// Edge-safe shared constants + predicates for the API-token feature.
//
// NO `server-only`, NO node imports — this module is imported by BOTH the
// Edge middleware AND Node route handlers / the session pipeline, so it
// must stay free of any Node-only dependency. It is the single source of
// truth for: the token wire prefix, the synthetic session jti prefix, and
// the set of HTTP surfaces a bearer token may reach.

// Wire prefix on every API token secret. Lets callers reject a malformed
// Authorization header before any DB work, and lets the UI show a
// recognisable, non-secret stub ("cave_AbC3dEf…").
export const API_TOKEN_PREFIX = 'cave_'

// Full Authorization-header prefix for an API-token request.
export const BEARER_API_TOKEN_PREFIX = `Bearer ${API_TOKEN_PREFIX}`

// Prefix on the synthetic session jti minted for a token-authed request.
// requireCsrf skips the double-submit check and requireFreshReauth refuses
// outright when they see this prefix — keeping the mint/skip/reject
// contract compiler-enforced rather than three independent string literals.
export const API_TOKEN_JTI_PREFIX = 'apitoken:'

export function isBearerApiToken(
  authorizationHeader: string | null | undefined,
): authorizationHeader is string {
  return (
    typeof authorizationHeader === 'string' &&
    authorizationHeader.startsWith(BEARER_API_TOKEN_PREFIX)
  )
}

export function makeApiTokenJti(tokenId: number): string {
  return `${API_TOKEN_JTI_PREFIX}${tokenId}`
}

export function isApiTokenJti(jti: string): boolean {
  return jti.startsWith(API_TOKEN_JTI_PREFIX)
}

// Surfaces a bearer API token may reach: content (/api/cms/*) + the
// content/branding settings endpoint. Enforced at BOTH the Edge
// (middleware authGate) AND structurally in _loadAuthState, so a future
// middleware regression cannot silently widen a token's reach. The
// settings route applies a further per-KEY content/branding allowlist on
// top of this (a token can hit /api/admin/settings but only write
// content/branding keys).
export function tokenAllowedPath(pathname: string): boolean {
  return pathname.startsWith('/api/cms/') || pathname === '/api/admin/settings'
}
