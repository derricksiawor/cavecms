import 'server-only'
import { headers } from 'next/headers'

// ─── In-process route passthrough ───────────────────────────────────
// For the long tail of resource CRUD (posts, projects, nav, media, settings,
// page lifecycle) the MCP tools call the EXISTING route handlers directly,
// in-process, instead of re-implementing each one. This is sound because the
// route handler's auth chain (requireRole → _loadAuthState) reads the AMBIENT
// request via next/headers(), which — verified — is the live MCP request inside
// a tool callback (AsyncLocalStorage propagates through the transport). So the
// SAME requireRole + requireScope + requireCsrf (bearer-exempt) + per-token rate
// limiting runs, with zero logic duplication and zero drift between the HTTP API
// and the MCP surface. Middleware is bypassed, but every gate it would apply for
// a bearer caller is re-applied inside the handler.
//
// We synthesise a minimal Request: method + internal URL (+ query) + a JSON body
// (for mutations) + the request-scoped headers a handler reads off `req`
// directly (ip via x-real-ip, user-agent, x-request-id). Authorization is also
// copied for completeness, though requireRole reads it from the ambient store.

export interface PassthroughResult {
  status: number
  data: unknown
}

export interface CallRouteOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Absolute app path, e.g. '/api/cms/posts' or '/api/cms/posts/12'. */
  path: string
  query?: Record<string, string | number | boolean | undefined>
  /** JSON body for mutations (ignored for GET/DELETE-without-body). */
  body?: unknown
  /** Multipart body (e.g. media upload). Takes precedence over `body`; the
   *  Request infers the multipart content-type + boundary, so we don't set it. */
  formData?: FormData
  /** Dynamic route params, e.g. { id: '12' }. */
  params?: Record<string, string>
}

export async function callRoute<
  P extends Record<string, string> = Record<string, string>,
>(
  handler: (
    req: Request,
    ctx: { params: Promise<P> },
  ) => Promise<Response>,
  opts: CallRouteOptions,
): Promise<PassthroughResult> {
  const ambient = await headers()
  const url = new URL(`http://internal${opts.path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  const reqHeaders = new Headers()
  // For multipart, let the Request derive content-type + boundary; otherwise JSON.
  if (!opts.formData) reqHeaders.set('content-type', 'application/json')
  for (const name of [
    'authorization',
    'x-real-ip',
    'user-agent',
    'x-request-id',
  ]) {
    const v = ambient.get(name)
    if (v) reqHeaders.set(name, v)
  }
  const init: RequestInit = { method: opts.method, headers: reqHeaders }
  if (opts.formData) {
    init.body = opts.formData
  } else if (opts.body !== undefined && opts.method !== 'GET') {
    init.body = JSON.stringify(opts.body)
  }
  const req = new Request(url.toString(), init)
  const res = await handler(req, {
    params: Promise.resolve((opts.params ?? {}) as P),
  })
  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return { status: res.status, data }
}
