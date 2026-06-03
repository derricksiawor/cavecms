import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpAuthContext } from '@/lib/auth/apiTokenContext'

// The acting context for ONE MCP request. Carried via AsyncLocalStorage so each
// concurrent request on the SAME session resolves ITS OWN context inside the
// tool callback — never a sibling request's. (The MCP SDK does not serialize
// concurrent tools/call POSTs per session; a single mutable per-session ref
// would let request A's handler read request B's ip/userAgent/requestId and
// mis-attribute the audit row. ALS propagates through the transport's await
// chain — the same property the passthrough relies on for next/headers().)
//
// `viaApiToken` is always true here (the MCP surface is bearer-token-only) and
// lets the CMS rate-limiter key on the per-token bucket exactly like the HTTP
// bearer path.
export interface McpRequestContext extends McpAuthContext {
  viaApiToken: true
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export const mcpCtxStore = new AsyncLocalStorage<McpRequestContext>()

// The live request context inside a tool callback. Throws if called outside a
// request scope (a programming error — every tool runs inside mcpCtxStore.run).
export function currentCtx(): McpRequestContext {
  const c = mcpCtxStore.getStore()
  if (!c) throw new Error('mcp_context_unavailable')
  return c
}
