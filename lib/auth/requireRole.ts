import 'server-only'
import { _loadAuthState } from '@/lib/auth/getSession'
import type { Role } from '@/lib/auth/types'
import {
  tokenAllowsScope,
  type ScopeResource,
  type ScopeAction,
} from '@/lib/auth/apiTokenScope'

// Re-export so the existing convention `import type { Role } from
// '@/lib/auth/requireRole'` keeps working — no need to mass-update
// callers.
export type { Role }

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code)
  }
}

export interface AuthContext {
  userId: number
  role: Role
  email: string
  jti: string
  oat: number
  iat: number
  /** When true, the session is valid but the user MUST rotate their password
   *  before being granted access to admin surfaces. Callers decide how to
   *  respond — AdminLayout redirects to /auth/rotate, while logout/csrf
   *  endpoints accept the session as-is. requireAuth no longer throws on
   *  this state because it leaks the rotation-required code as a generic API
   *  error to anything wrapped by withError. */
  pwp: boolean
  /** True when this request authenticated via an API token (Bearer) rather
   *  than the session cookie. Consumed by the /api/admin/settings PATCH
   *  handler to enforce the per-key content/branding write allowlist (a
   *  token must not write session/security/integration/operational keys).
   *  Complements the structural caps: the token path-allowlist in
   *  middleware + _loadAuthState, and requireFreshReauth refusing token jtis
   *  outright on reauth-gated surfaces. */
  viaApiToken: boolean
  /** The API token id when viaApiToken is true, else null. Stamped onto
   *  content-mutation audit rows so writes attribute to the acting token. */
  tokenId: number | null
  /** The token's per-resource grants, or null = unrestricted within role
   *  (the back-compat default + every cookie session). Consumed by
   *  requireScope. */
  scopes: string[] | null
}

// Both adapters consume the shared pipeline in getSession.ts. The
// pipeline is React.cache-wrapped, so root-layout / AdminBar /
// API-handler call sites all share a single verify + user lookup per
// request.
export async function requireAuth(): Promise<AuthContext> {
  const s = await _loadAuthState()
  if (!s) throw new HttpError(401, 'unauthenticated')
  return {
    userId: s.user.id,
    role: s.user.role,
    email: s.user.email,
    jti: s.payload.jti,
    oat: s.payload.oat,
    iat: s.payload.iat,
    pwp: s.payload.pwp,
    viaApiToken: !!s.apiTokenId,
    tokenId: s.apiTokenId ?? null,
    scopes: s.apiTokenScopes ?? null,
  }
}

export async function requireRole(allowed: Role[]): Promise<AuthContext> {
  const ctx = await requireAuth()
  if (!allowed.includes(ctx.role)) throw new HttpError(403, 'forbidden')
  return ctx
}

// Per-resource scope gate, layered AFTER requireRole at each mutation route.
// A no-op for cookie sessions (full operator access) and for tokens with
// null scopes (unrestricted within role). Throws 403 forbidden_scope when a
// scoped token lacks the required resource:action grant.
export function requireScope(
  ctx: AuthContext,
  resource: ScopeResource,
  action: ScopeAction,
): void {
  if (!ctx.viaApiToken) return
  if (!tokenAllowsScope(ctx.scopes, resource, action)) {
    throw new HttpError(403, 'forbidden_scope')
  }
}
