import 'server-only'
import { verifyApiToken } from '@/lib/auth/apiToken'
import { getUser } from '@/lib/auth/userCache'
import { makeApiTokenJti } from '@/lib/auth/apiTokenScope'
import type { Role } from '@/lib/auth/types'

// The MCP route receives an `Authorization: Bearer cave_…` header DIRECTLY and
// must authenticate WITHOUT the ambient next/headers + cookie coupling that
// _loadAuthState (getSession.ts) uses. This wrapper reproduces the token-auth
// branch of _loadAuthState (verifyApiToken → getUser → active → role-clamp) and
// returns a flat context the MCP tools + in-process write services consume.
//
// It is the single auth chokepoint for the MCP server, mirroring how
// _loadAuthState is the chokepoint for cookie + token HTTP requests. Fail-closed
// throughout: any failure returns null and the route 401s.

export interface McpAuthContext {
  /** The minting user — the FK target for content_blocks.updated_by + audit. */
  userId: number
  /** Effective role: the LOWER of the token's role and the creator's CURRENT
   *  role, so demoting the minting user strips an over-privileged token. */
  role: Role
  /** Per-resource grants, or null = unrestricted within role. Drives the
   *  MCP server's progressive tool disclosure + per-tool scope checks. */
  scopes: string[] | null
  /** The acting token id — stamped into audit rows for per-token attribution. */
  tokenId: number
  /** Synthetic `apitoken:<id>` jti (parity with the HTTP token path). */
  jti: string
  email: string
}

// Same RANK as getSession.ts's role clamp.
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 }

export async function authenticateBearer(
  authHeader: string | null | undefined,
): Promise<McpAuthContext | null> {
  if (!authHeader) return null
  // verifyApiToken: fail-closed, never throws; validates hash + revocation +
  // expiry + role ∈ {admin,editor,viewer} and returns scopes (Plan A).
  const tok = await verifyApiToken(authHeader)
  if (!tok) return null
  // Clamp to the creator's CURRENT role + require they're still active —
  // identical to _loadAuthState (getSession.ts). A now-deactivated or
  // now-viewer creator can't wield a write token.
  const user = await getUser(tok.userId)
  if (!user || !user.active) return null
  const effectiveRole: Role =
    RANK[user.role] < RANK[tok.role] ? user.role : tok.role
  return {
    userId: tok.userId,
    role: effectiveRole,
    scopes: tok.scopes,
    tokenId: tok.tokenId,
    jti: makeApiTokenJti(tok.tokenId),
    email: user.email,
  }
}
