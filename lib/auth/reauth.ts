import 'server-only'
import { cookies, headers } from 'next/headers'
import { HttpError } from './requireRole'
import { REAUTH_COOKIE_NAME } from './cookie-names'
import { cookieFlags, isSecureFromHeaders } from './cookies'

// Step-up reauth lifetime. 5 minutes is enough for an operator to
// chain a small batch of sensitive ops (create user → set role →
// rotate settings) without retyping their password between each.
// Long enough to be ergonomic, short enough that an unattended
// terminal can't be used to escalate.
const REAUTH_TTL_SEC = 300

// Defensive cap on the raw cookie value length. UUIDv4 jti is 36
// chars + 1 separator + 10-char unix-seconds = 47 chars typical. 128
// gives generous headroom while rejecting pathological values long
// before the indexOf/slice walk runs.
const MAX_REAUTH_COOKIE_LEN = 128

// Cookie value format: `<jti>.<unix-seconds>`. Binding to the
// session's jti prevents cross-session contamination — if user A
// logs out and user B logs in on the same browser BEFORE the
// 5-min TTL elapses, B's jti will differ from the cookie's jti
// and requireFreshReauth refuses. The logout handler also clears
// this cookie explicitly (belt + braces); jti binding is the
// reliable layer because logout might not run (process kill,
// browser tab close without sign-out click).
//
// Why not HMAC: in production the cookie is __Host- + Secure +
// HttpOnly + SameSite=Strict, so the cookie cannot be written by
// any party other than the server itself. The jti binding alone
// closes the same-browser-tenant-swap gap that HMAC would protect
// against in dev/non-prod where __Host- is dropped.

// Reuses the canonical cookie-flags helper rather than duplicating the
// (httpOnly + secure + sameSite + path) shape. Drift between the two
// would silently relax invariants on this cookie if a future change
// updated `cookieFlags()` (e.g. priority: 'high') without remembering
// to update this one. The reauth cookie's TTL is its only override.
async function reauthCookieFlags(): Promise<ReturnType<typeof cookieFlags>> {
  // Secure tracks the request protocol (see isSecureRequest) so the
  // step-up cookie stores on http://localhost installs. headers() is
  // request-scoped — both callers run in a route handler / server action.
  const secure = isSecureFromHeaders(await headers())
  return cookieFlags(REAUTH_TTL_SEC, secure)
}

// Sets the reauth cookie tying the freshness window to the current
// session's jti. Callers invoke this only after verifying the
// password.
export async function setFreshReauth(jti: string): Promise<void> {
  const c = await cookies()
  const value = `${jti}.${Math.floor(Date.now() / 1000)}`
  c.set(REAUTH_COOKIE_NAME, value, await reauthCookieFlags())
}

// Explicitly clears the reauth cookie. Used by the logout flow so a
// follow-up login on the same browser cannot inherit an unexpired
// reauth window minted for a different user.
export async function clearReauthCookie(): Promise<void> {
  const c = await cookies()
  c.set(REAUTH_COOKIE_NAME, '', { ...(await reauthCookieFlags()), maxAge: 0 })
}

// Throws HttpError(401, 'reauth_required') unless the user has
// reauthenticated WITHIN REAUTH_TTL_SEC and the reauth cookie was
// minted for the current session jti. Routes call this AFTER
// requireRole(['admin']) + requireCsrf so the response code is
// safe to surface (the client knows the user is logged in and has
// a valid CSRF; the only remaining failure mode is reauth).
//
// Future-time tolerance: a small skew (5s) accommodates wall-clock
// drift between the app server that set the cookie and the one
// reading it on the next request.
export async function requireFreshReauth(jti: string): Promise<void> {
  const c = await cookies()
  const raw = c.get(REAUTH_COOKIE_NAME)?.value
  if (!raw) throw new HttpError(401, 'reauth_required')
  // Length cap: in prod the cookie is __Host- + HttpOnly so it cannot
  // be set by anything other than the server. Capping here is defense
  // in depth (a non-prod env without __Host- could theoretically
  // accept a huge cookie via dev tooling, and we don't want indexOf /
  // slice traversing arbitrary lengths).
  if (raw.length > MAX_REAUTH_COOKIE_LEN) {
    throw new HttpError(401, 'reauth_required')
  }
  const dot = raw.indexOf('.')
  if (dot <= 0) throw new HttpError(401, 'reauth_required')
  const cookieJti = raw.slice(0, dot)
  // Reject silently on jti mismatch — same response shape as expired
  // so a probe can't distinguish "wrong session" from "stale".
  if (cookieJti !== jti) throw new HttpError(401, 'reauth_required')
  const ts = Number(raw.slice(dot + 1))
  if (!Number.isInteger(ts) || ts <= 0) throw new HttpError(401, 'reauth_required')
  const nowSec = Math.floor(Date.now() / 1000)
  if (ts - nowSec > 5) throw new HttpError(401, 'reauth_required')
  if (nowSec - ts > REAUTH_TTL_SEC) throw new HttpError(401, 'reauth_required')
}
