import 'server-only'
import { _loadAuthState } from '@/lib/auth/getSession'
import type { Role } from '@/lib/auth/types'

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
  }
}

export async function requireRole(allowed: Role[]): Promise<AuthContext> {
  const ctx = await requireAuth()
  if (!allowed.includes(ctx.role)) throw new HttpError(403, 'forbidden')
  return ctx
}
