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
  return (
    pathname.startsWith('/api/cms/') ||
    pathname === '/api/admin/settings' ||
    // Backup operations live under /api/admin/backups/* (take / restore / list /
    // configure destinations + schedule + encryption). A scoped bearer token
    // reaches them so the operator's AI can run backups from the terminal; the
    // per-route requireScope('backups', …) gate narrows what a given token can
    // do. The /api/internal/backups/* loopback routes (scheduler tick, engine
    // audit callback) are deliberately NOT included — they stay loopback-only.
    pathname.startsWith('/api/admin/backups/')
  )
}

// ── Per-resource scope model ────────────────────────────────────────────
// A token's `scopes` column is either NULL (unrestricted within its role —
// the back-compat default for every token minted before this feature) or a
// JSON array of `"<resource>:<action>"` grants. Action rank is cumulative
// per resource: a `write` grant implies `read`; a `delete` grant implies
// `write` + `read`. Role (admin|editor|viewer) is the ceiling, enforced
// separately by requireRole; scopes only NARROW within the role.

export const SCOPE_RESOURCES = [
  'pages',
  'posts',
  'projects',
  'blocks',
  'media',
  'nav',
  'settings',
  // local↔remote content sync: read = list/inspect targets + hashes;
  // write = configure a target, pull a remote into this install, push this
  // install to a target (push is additionally gated destructive at the MCP tier).
  'sync',
  // cloud backups: read = list/status; write = take a backup + configure
  // destinations/schedule/encryption + start an OAuth device-flow connect;
  // delete = trash a local archive AND restore (restore overwrites live content).
  'backups',
] as const
export type ScopeResource = (typeof SCOPE_RESOURCES)[number]

export const SCOPE_ACTIONS = ['read', 'write', 'delete'] as const
export type ScopeAction = (typeof SCOPE_ACTIONS)[number]

const ACTION_RANK: Record<ScopeAction, number> = {
  read: 0,
  write: 1,
  delete: 2,
}

const RESOURCE_SET = new Set<string>(SCOPE_RESOURCES)
const SCOPE_RE = /^([a-z]+):(read|write|delete)$/

// Validates + normalises whatever is stored/sent into a clean grant array,
// or null. Unknown resources/actions are dropped (defense-in-depth — a
// corrupt row or a hand-crafted body can never widen reach). A non-array,
// unparseable, or NULL input returns null = "unrestricted within role".
export function parseScopes(raw: unknown): string[] | null {
  let arr: unknown = raw
  // Literal NULL/undefined = "unrestricted within role" (legacy/back-compat).
  // This is the ONLY input that fails OPEN, and it is the intended one.
  if (raw === null || raw === undefined) return null
  // A PRESENT-but-corrupt value (unparseable string, or a non-array like {})
  // is a damaged restrictive grant — fail CLOSED to deny-all ([]), never
  // widen a once-scoped token to unrestricted. (DDL-validated JSON makes this
  // unreachable in normal operation; this is defense-in-depth at the read
  // boundary, symmetric with the mint path which also normalises garbage → [].)
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  const out: string[] = []
  for (const v of arr) {
    if (typeof v !== 'string') continue
    const m = SCOPE_RE.exec(v)
    if (!m || !RESOURCE_SET.has(m[1]!)) continue
    if (!out.includes(v)) out.push(v)
  }
  return out
}

// The single scope decision. null grants = unrestricted (returns true).
// Otherwise the request's (resource, action) is allowed iff the token holds
// a grant for that resource whose action rank is >= the required rank.
export function tokenAllowsScope(
  scopes: string[] | null,
  resource: ScopeResource,
  action: ScopeAction,
): boolean {
  if (scopes === null) return true
  const need = ACTION_RANK[action]
  let best = -1
  for (const g of scopes) {
    const m = SCOPE_RE.exec(g)
    if (!m || m[1] !== resource) continue
    const rank = ACTION_RANK[m[2] as ScopeAction]
    if (rank > best) best = rank
  }
  return best >= need
}
