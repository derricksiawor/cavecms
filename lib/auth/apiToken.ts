import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Role } from '@/lib/auth/types'
import { API_TOKEN_PREFIX, parseScopes } from '@/lib/auth/apiTokenScope'

// Chars of the token persisted for display (prefix + a few entropy chars).
const PREFIX_DISPLAY_LEN = 12

export interface VerifiedApiToken {
  tokenId: number
  // created_by — the real user the token attributes content writes to.
  userId: number
  role: Role
  // Per-resource grants, or null = unrestricted within role.
  scopes: string[] | null
}

// 256-bit secret, base64url so it survives copy/paste, shell, and env
// files unmangled (no +,/,= to escape). Returned plaintext is shown to
// the operator exactly once; only the hash + display prefix persist.
export function generateApiToken(): {
  token: string
  hash: string
  prefix: string
} {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return {
    token,
    hash: hashApiToken(token),
    prefix: token.slice(0, PREFIX_DISPLAY_LEN),
  }
}

// SHA-256 is sufficient here (unlike user passwords): the token is a
// 256-bit random secret, not a low-entropy human choice, so there is no
// dictionary/brute surface a slow KDF would defend. Constant-work lookup
// is the unique index on token_hash.
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Throttle last_used_at writes to ≤1 per 60s per token so a hot token
// doesn't issue a DB write on every request. Pinned to globalThis so dev
// HMR doesn't reset it mid-session.
declare global {
  var __cavecmsApiTokenTouch: Map<number, number> | undefined
}
const lastTouch: Map<number, number> =
  globalThis.__cavecmsApiTokenTouch ?? new Map()
globalThis.__cavecmsApiTokenTouch = lastTouch
const TOUCH_THROTTLE_MS = 60_000
// Bound the throttle map so it can't grow without limit across the process
// lifetime (FIFO eviction via Map insertion order, mirroring userCache.ts).
const TOUCH_MAX_ENTRIES = 10_000

interface TokenRow {
  id: number
  role: string
  created_by: number
  expires_at: Date | null
  revoked_at: Date | null
  scopes: unknown
}

// Verifies an `Authorization` header value. Returns null on any failure
// (malformed header, unknown/revoked/expired token) — the caller treats
// null as "no token" and either falls back to the cookie session or 401s.
// Never throws on a bad token (a bogus bearer must not 500).
export async function verifyApiToken(
  authorizationHeader: string,
): Promise<VerifiedApiToken | null> {
  const m = /^Bearer\s+(\S+)$/.exec(authorizationHeader)
  if (!m) return null
  const token = m[1]!
  if (!token.startsWith(API_TOKEN_PREFIX)) return null
  const hash = hashApiToken(token)
  let rows: TokenRow[]
  try {
    ;[rows] = (await db.execute(sql`
      SELECT id, role, created_by, expires_at, revoked_at, scopes
      FROM api_tokens
      WHERE token_hash = ${hash}
      LIMIT 1
    `)) as unknown as [TokenRow[]]
  } catch {
    // Honour the documented "never throws" contract: a transient DB error
    // on the auth hot path DENIES (the caller treats null as "no token")
    // rather than surfacing a 500. Fail-closed.
    return null
  }
  const row = rows[0]
  if (!row) return null
  // Validate the role at the auth boundary (fail-closed) instead of trusting
  // a downstream allowlist — a row whose role is somehow outside the enum
  // must not flow into the role clamp as a raw string.
  if (row.role !== 'admin' && row.role !== 'editor' && row.role !== 'viewer') {
    lastTouch.delete(row.id)
    return null
  }
  // Revocation + expiry are the security gates — FAIL CLOSED. The mere
  // PRESENCE of a non-null revoked_at denies, regardless of parseability: a
  // corrupt / zero-date value must never be read as "not revoked". A present
  // expiry that is in the past OR unparseable also denies. (With the datetime
  // columns these are always clean dates or NULL; the NaN handling is pure
  // defense-in-depth.) Prune the throttle map for dead tokens.
  if (row.revoked_at !== null) {
    lastTouch.delete(row.id)
    return null
  }
  if (row.expires_at !== null) {
    const expMs = new Date(row.expires_at).getTime()
    if (Number.isNaN(expMs) || expMs <= Date.now()) {
      lastTouch.delete(row.id)
      return null
    }
  }
  // Fire-and-forget; a last-used write failure must never fail the request.
  void touchLastUsed(row.id)
  return {
    tokenId: row.id,
    userId: row.created_by,
    role: row.role as VerifiedApiToken['role'],
    scopes: parseScopes(row.scopes),
  }
}

async function touchLastUsed(tokenId: number): Promise<void> {
  const now = Date.now()
  if (now - (lastTouch.get(tokenId) ?? 0) < TOUCH_THROTTLE_MS) return
  lastTouch.set(tokenId, now)
  if (lastTouch.size > TOUCH_MAX_ENTRIES) {
    const overflow = lastTouch.size - TOUCH_MAX_ENTRIES
    let removed = 0
    for (const k of lastTouch.keys()) {
      lastTouch.delete(k)
      if (++removed >= overflow) break
    }
  }
  try {
    await db.execute(
      sql`UPDATE api_tokens SET last_used_at = NOW(3) WHERE id = ${tokenId}`,
    )
  } catch {
    /* non-fatal — last_used_at is observability, not correctness */
  }
}

// Drop the in-memory last_used_at throttle entry for a token. Called after a
// ROTATION resets last_used_at = NULL in the DB: without this, a stale recent
// timestamp in `lastTouch` would suppress the next last_used_at write for up
// to 60s, so a freshly-rotated, actively-used token would read "Never" in the
// management UI. Mirrors the lastTouch.delete cleanup on the revoke/expiry
// branches in verifyApiToken.
export function clearTokenTouch(tokenId: number): void {
  lastTouch.delete(tokenId)
}

// Metadata-only row for the management surfaces. NEVER includes the token
// secret or its hash. Timestamps are typed Date | string because mysql2
// returns JSON/TIMESTAMP columns differently depending on driver config;
// callers normalise as needed.
export interface ApiTokenListRow {
  id: number
  name: string
  token_prefix: string
  role: string
  scopes: unknown
  created_at: Date | string
  last_used_at: Date | string | null
  expires_at: Date | string | null
  revoked_at: Date | string | null
  created_by_email: string | null
}

// Single source of truth for the token list query, shared by the GET API
// route and the SSR settings page (DRY — they must not drift). Active
// tokens first, then revoked, newest within each group.
export async function listApiTokens(): Promise<ApiTokenListRow[]> {
  const [rows] = (await db.execute(sql`
    SELECT t.id, t.name, t.token_prefix, t.role, t.scopes, t.created_at,
           t.last_used_at, t.expires_at, t.revoked_at,
           u.email AS created_by_email
    FROM api_tokens t
    LEFT JOIN users u ON u.id = t.created_by
    ORDER BY (t.revoked_at IS NOT NULL), t.created_at DESC, t.id DESC
  `)) as unknown as [ApiTokenListRow[]]
  return rows
}
