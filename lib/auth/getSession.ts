import 'server-only'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import type { Role } from '@/lib/auth/types'
import type { SessionPayload } from '@/lib/auth/jwt'
import type { CachedUser } from '@/lib/auth/userCache'
import { verifySessionJwt } from '@/lib/auth/jwt'
import { getUser } from '@/lib/auth/userCache'
import { verifyApiToken } from '@/lib/auth/apiToken'
import {
  isBearerApiToken,
  makeApiTokenJti,
  tokenAllowedPath,
} from '@/lib/auth/apiTokenScope'
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  JTI_COOKIE,
  EDIT_MODE_COOKIE,
  cookieFlags,
  csrfCookieFlags,
  jtiCookieFlags,
} from '@/lib/auth/cookies'

// 401-cookie-clear path (spec §3.5): when a session token is present
// but rejected (invalid JWT signature, expired, user deactivated,
// tokens_valid_after revoked), actively clear BOTH the session AND
// the jti companion cookie in the response. The FE's HKDF derivation
// reads the jti from the cookie; leaving a stale jti behind would
// keep the FE able to "sign" a buffered draft with a key the server
// no longer trusts.
//
// Why a try/catch: Next 15's `cookies()` API allows `.set()` only in
// route handlers, server actions, and middleware. RSC render contexts
// throw on write. _loadAuthState runs in both, so we swallow the
// write-failure path — when called from an RSC, the cookies expire
// naturally via their existing Max-Age. The active clear is only an
// optimisation for the route-handler path that emits the 401 response.
function tryClearRevocationCookies(c: Awaited<ReturnType<typeof cookies>>): void {
  try {
    // Cookies are plain-named (no `__Host-`), so deletion matches on
    // name+path+domain regardless of the Secure attribute — passing
    // secure=false here clears them on both HTTP and HTTPS installs.
    c.set(SESSION_COOKIE, '', cookieFlags(0, false))
    c.set(JTI_COOKIE, '', jtiCookieFlags(0, false))
    c.set(CSRF_COOKIE, '', csrfCookieFlags(0, false))
  } catch {
    // RSC contexts can't mutate cookies — swallow silently. Cookies
    // expire naturally on their Max-Age; the next route-handler call
    // path (if any) will re-detect the revocation and clear then.
  }
}

// Single shared auth pipeline. Two adapters live above it:
//   - getSession() — RSC-friendly, returns null on any failure
//     (treats pwp=true as "no session" so the bar suppresses during
//     password rotation). Used by root layout, AdminBar, public RSC
//     pages that branch on session presence.
//   - requireAuth() (in requireRole.ts) — API-friendly, throws an
//     HttpError on failure but PRESERVES pwp in the return so callers
//     like /api/auth/logout can accept the session as-is.
//
// React.cache wraps the pipeline so it runs at most once per request,
// no matter how many adapters fire. Caches the raw {user, payload}
// pair so both adapters can build their own return shape without a
// second JWT verify + user lookup.

interface AuthState {
  user: CachedUser
  payload: SessionPayload
  // Set when the request authenticated via an API token (Bearer) rather
  // than the session cookie. requireCsrf + requireFreshReauth branch on
  // the synthetic `apitoken:<id>` jti; requireAuth surfaces this as
  // `viaApiToken` so handlers can defend sensitive surfaces explicitly.
  apiTokenId?: number
  // The token's per-resource grants (null = unrestricted within role).
  // Surfaced as AuthContext.scopes and enforced by requireScope.
  apiTokenScopes?: string[] | null
}

// Intentionally not exported as part of the public API — adapters in
// this file and in requireRole.ts are the supported callers.
export const _loadAuthState = cache(async (): Promise<AuthState | null> => {
  // API-token bearer auth: programmatic clients (AI assistants, scripts,
  // CI) send `Authorization: Bearer cave_…` with NO cookie and NO CSRF.
  // verifyApiToken does the DB-backed hash lookup (Node-only — this module
  // is never bundled into the Edge middleware). The token is honoured ONLY
  // when it is valid AND the request targets a token-allowed surface
  // (defense-in-depth path cap: middleware blocks others at the edge, this
  // makes the cap STRUCTURAL so a middleware regression can't widen it).
  // If the bearer is unusable for any AUTH reason (invalid/revoked/expired
  // token, disallowed path, or an inactive/over-privileged creator) we FALL
  // THROUGH to the cookie path rather than returning null, so a stray
  // Authorization header can never shadow a valid session cookie. A
  // transient DB error inside verifyApiToken is swallowed to null (fail-
  // closed → falls through); a DB error inside getUser propagates as a 500,
  // identical to the cookie path below — also fail-closed.
  const h = await headers()
  const authz = h.get('authorization')
  if (isBearerApiToken(authz)) {
    // Check the (free, in-memory) path gate BEFORE the DB lookup so a stray
    // Authorization header on a public-page SSR render (uncacheable,
    // unthrottled) can't force an api_tokens SELECT — the token can never be
    // honoured there anyway. x-pathname is set by middleware on every
    // matched request.
    const pathname = h.get('x-pathname') ?? ''
    if (tokenAllowedPath(pathname)) {
      const tok = await verifyApiToken(authz)
      if (tok) {
        // Attribute writes to the minting user (real FK target for
        // content_blocks.updated_by); the acting token id is surfaced
        // separately (apiTokenId → AuthContext.tokenId) for audit
        // attribution + the per-TOKEN CMS mutation rate bucket
        // (checkCmsMutationRate in cmsRateLimit.ts), so a runaway agent
        // does not starve the minting admin's own per-user bucket.
        // Clamp the EFFECTIVE role to the creator's CURRENT role so demoting
        // the minting admin strips an over-privileged token: an admin token
        // wielded by a now-editor creator acts as editor; a now-viewer or
        // deactivated creator can't wield a write token at all. Role/active
        // are read via getUser's ~30s cache, so demotion/deactivation take
        // effect within that TTL — the SAME window as the cookie-session
        // path. (Token REVOCATION and creator DELETION are immediate:
        // verifyApiToken does an uncached per-request lookup, and the FK
        // cascade drops the row on delete.) Fail-closed throughout; the jti
        // marks this a token request so requireCsrf skips the double-submit
        // check and requireFreshReauth refuses outright.
        const user = await getUser(tok.userId)
        if (user && user.active) {
          const RANK = { viewer: 0, editor: 1, admin: 2 } as const
          const effectiveRole: Role =
            RANK[user.role] < RANK[tok.role] ? user.role : tok.role
          const nowSec = Math.floor(Date.now() / 1000)
          return {
            user: { ...user, role: effectiveRole },
            payload: {
              sub: String(tok.userId),
              jti: makeApiTokenJti(tok.tokenId),
              oat: nowSec,
              iat: nowSec,
              exp: nowSec + 60,
              pwp: false,
            },
            apiTokenId: tok.tokenId,
            apiTokenScopes: tok.scopes,
          }
        }
      }
    }
    // Unusable bearer — fall through to the cookie path below.
  }

  const c = await cookies()
  const token = c.get(SESSION_COOKIE)?.value
  // No token at all — nothing to clear; fast-path null.
  if (!token) return null
  const payload = await verifySessionJwt(token).catch(() => null)
  if (!payload) {
    // Token present but signature/expiry/abs-cap failed — clear both cookies
    // so the browser stops sending an invalid pair on every subsequent
    // request. Per spec §3.5 force-logout flow.
    tryClearRevocationCookies(c)
    return null
  }
  const user = await getUser(Number(payload.sub))
  if (!user || !user.active) {
    tryClearRevocationCookies(c)
    return null
  }
  // tokens_valid_after invalidation: any token issued at-or-before
  // the user's last "revoke" timestamp (logout, password change,
  // manual boot) is treated as already expired.
  if (payload.iat * 1000 <= user.tokensValidAfterMs) {
    tryClearRevocationCookies(c)
    return null
  }
  return { user, payload }
})

export interface AdminSession {
  userId: number
  role: Role
  email: string
  jti: string
  oat: number
  // `iat` is exposed so a future renewal/rotate path can compute the
  // companion jti cookie's Max-Age as `JWT exp - iat` instead of bare
  // `JWT_TTL_SECONDS` (spec §3.5). Login does not consume this from
  // getSession (it has the value directly from signSessionJwt); any
  // caller that mints a fresh jti cookie OFF an existing session
  // (e.g. a hypothetical /api/auth/refresh) reads it here.
  iat: number
}

export const getSession = cache(async (): Promise<AdminSession | null> => {
  const s = await _loadAuthState()
  if (!s) return null
  // pwp=true means the user owes a password rotation before the
  // session counts as fully authenticated. The admin layout routes
  // these users to /auth/rotate; treating them as "no session" here
  // keeps the bar from rendering during the rotation flow.
  if (s.payload.pwp) return null
  return {
    userId: s.user.id,
    role: s.user.role,
    email: s.user.email,
    jti: s.payload.jti,
    oat: s.payload.oat,
    iat: s.payload.iat,
  }
})

export function canEdit(s: AdminSession | null): boolean {
  return !!s && (s.role === 'admin' || s.role === 'editor')
}

export function isEditModeOn(c: {
  get(name: string): { value: string } | undefined
}): boolean {
  return c.get(EDIT_MODE_COOKIE)?.value === '1'
}

/**
 * URL-override entry for edit mode. Returns true ONLY when the visitor
 * has admin/editor session AND the URL carries `?edit=1`. Use as an
 * additional OR-condition alongside isEditModeOn() so an authenticated
 * admin can land directly on the edit surface by following a shared
 * link without first toggling the cookie. canEdit() gates the override
 * — a non-admin landing on the same URL sees the anonymous render.
 *
 * The URL override is render-only — it does NOT mutate the cookie.
 * Closing the tab restores the cookie-driven state on the next visit.
 */
export function isEditUrlOverride(
  session: AdminSession | null,
  searchParams:
    | { [key: string]: string | string[] | undefined }
    | undefined
    | null,
): boolean {
  if (!canEdit(session)) return false
  if (!searchParams) return false
  const raw = searchParams['edit']
  if (Array.isArray(raw)) return raw.includes('1')
  return raw === '1'
}

/**
 * Composite "is the edit surface active for this request?" check used
 * by every page-level render that mounts EditableMain. Combines the
 * persistent cookie state with the per-request URL override so a
 * collaborator who follows a `?edit=1` link from an admin colleague
 * lands on the edit surface immediately (if their own session has the
 * canEdit role).
 */
export function resolveEditableMode(
  session: AdminSession | null,
  c: { get(name: string): { value: string } | undefined },
  searchParams?:
    | { [key: string]: string | string[] | undefined }
    | null,
): boolean {
  if (!canEdit(session)) return false
  if (isEditModeOn(c)) return true
  return isEditUrlOverride(session, searchParams ?? null)
}
