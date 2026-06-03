import 'server-only'
import { randomUUID } from 'node:crypto'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { authenticateBearer } from '@/lib/auth/apiTokenContext'
import type { McpAuthContext } from '@/lib/auth/apiTokenContext'
import { buildServer } from '@/lib/mcp/server'
import { mcpCtxStore, type McpRequestContext } from '@/lib/mcp/requestContext'
import { clientIpFromRequest } from '@/lib/security/ipMatch'

// The CaveCMS MCP server — Streamable HTTP transport (single in-process endpoint
// an agent connects to with an `Authorization: Bearer cave_…` token). Reuses the
// SAME CMS service layer the HTTP routes call (in-process, no loopback), the SAME
// scope predicate (tokenAllowsScope), and the SAME audit attribution (token_id).
//
//   • runtime=nodejs — the transport + crypto + mysql2 need Node, not Edge.
//   • dynamic=force-dynamic — never cache; every call is an authenticated RPC.
//
// SINGLE-INSTANCE deploy model (PM2 fork / systemd, instances:1): the sessions
// map below is per-process in-memory. A multi-instance cluster would need sticky
// sessions or the transport's stateless mode; CaveCMS ships single-instance.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Session {
  transport: WebStandardStreamableHTTPServerTransport
  // Sessions are pinned to the token that opened them — another token may not
  // ride an existing session id even if it leaks.
  tokenId: number
  lastSeen: number
}

// Module-scoped session registry. Bounded by an idle TTL + a hard cap so a
// client that never sends the (optional) DELETE can't leak a transport for the
// worker's lifetime. Swept lazily on each request.
const sessions = new Map<string, Session>()
const SESSION_IDLE_MS = 30 * 60 * 1000 // evict sessions idle > 30 min
const MAX_SESSIONS = 1000 // hard cap; evict oldest on overflow

function destroySession(sid: string): void {
  const s = sessions.get(sid)
  if (!s) return
  sessions.delete(sid)
  // Tear down the SSE streams + McpServer. Fire-and-forget; close() never
  // rejects in a way we can act on here.
  void Promise.resolve()
    .then(() => s.transport.close())
    .catch(() => {})
}

// Lazy sweep: evict idle sessions, then enforce the hard cap (oldest-first).
function sweepSessions(now: number): void {
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_IDLE_MS) destroySession(sid)
  }
  if (sessions.size > MAX_SESSIONS) {
    // Map preserves insertion order; the earliest entries are the oldest.
    const overflow = sessions.size - MAX_SESSIONS
    let i = 0
    for (const sid of sessions.keys()) {
      if (i++ >= overflow) break
      destroySession(sid)
    }
  }
}

function rpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

function requestMeta(req: Request, auth: McpAuthContext): McpRequestContext {
  return {
    ...auth,
    viaApiToken: true,
    ip: clientIpFromRequest(req),
    userAgent: req.headers.get('user-agent'),
    requestId: randomUUID(),
  }
}

async function handle(req: Request): Promise<Response> {
  const now = Date.now()
  sweepSessions(now)

  // Authenticate on EVERY request — a revoked/expired/demoted token loses
  // access on its next call, not just at session open. Generic 401 (no path /
  // mechanism disclosure), matching the security standard for admin surfaces.
  const auth = await authenticateBearer(req.headers.get('authorization'))
  if (!auth) return rpcError(401, -32001, 'Authentication required')

  const sessionId = req.headers.get('mcp-session-id') ?? undefined

  // Existing session: route to its transport inside an ALS scope carrying THIS
  // request's freshly-authenticated context (so concurrent same-session calls
  // never clobber each other's audit attribution, and a revoke/narrowing takes
  // effect on this very call).
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return rpcError(404, -32001, 'Session not found')
    if (session.tokenId !== auth.tokenId) {
      return rpcError(403, -32001, 'Forbidden')
    }
    session.lastSeen = now
    const ctx = requestMeta(req, auth)
    return mcpCtxStore.run(ctx, () => session.transport.handleRequest(req))
  }

  // No session id. Only a POST carrying an `initialize` request may open one.
  if (req.method !== 'POST') {
    return rpcError(400, -32000, 'Missing or invalid session id')
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return rpcError(400, -32700, 'Parse error')
  }
  if (!isInitializeRequest(body)) {
    return rpcError(400, -32000, 'Missing or invalid session id')
  }

  // Open a new session bound to this token. buildServer registers only the
  // tools the token's scopes permit (progressive disclosure); tool execution
  // reads the live per-request context from the ALS store.
  const ctx = requestMeta(req, auth)
  const server = buildServer(ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, tokenId: auth.tokenId, lastSeen: now })
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid)
    },
  })
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId)
  }
  try {
    await server.connect(transport)
    return await mcpCtxStore.run(ctx, () =>
      transport.handleRequest(req, { parsedBody: body }),
    )
  } catch (e) {
    // Initialize failed after wiring — never leave a half-registered session.
    if (transport.sessionId) destroySession(transport.sessionId)
    else void transport.close().catch(() => {})
    // Generic message — never leak internals (security standard).
    void e
    return rpcError(500, -32603, 'Internal error')
  }
}

export const GET = handle
export const POST = handle
export const DELETE = handle
