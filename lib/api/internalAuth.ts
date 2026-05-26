import { timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

// Loopback + bearer auth for /api/internal/* routes. Extracted so the
// security-hardened comparison logic lives in ONE place instead of being
// copy-pasted into every new internal endpoint. The pattern is the same
// as the inline `authorized()` in:
//   - app/api/internal/revalidate-tags/route.ts
//   - app/api/internal/security-config/route.ts
// Those routes keep their inline copies to avoid churn; new internal
// endpoints (updates trigger-check / maintenance / audit-terminal) use
// this shared helper.
//
// Auth model:
//   - Bearer token via `Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}`.
//   - The secret is a >=32-char printable-ASCII value distinct from
//     JWT_SECRET / CSRF_SECRET / PREVIEW_SECRET / BROCHURE_SECRET per
//     project Security Standards. `instrumentation.ts` refuses boot if
//     any duplicate the others.
//   - Bearer regex constrained to RFC 6750 §2.1 b64token charset.
//   - Constant-time-padded length comparison: regardless of whether the
//     regex matched and regardless of presented length, we always do
//     the same amount of work. A remote observer cannot distinguish
//     wrong-length from wrong-value timing.
//   - Loopback Host check FIRST — short-circuits before any crypto work
//     for the dominant rejected case. Tested against `host` because
//     Node's HTTP server folds HTTP/2 `:authority` into that header.
//
// Defence in depth: nginx `location ^~ /api/internal/ { allow 127.0.0.1;
// allow ::1; deny all; }` (see scripts/nginx/cavecms.conf.template) drops
// external traffic at the edge so the bearer-token gate is the SECONDARY
// layer, not the only one. A leaked secret OR an auth regression here
// does NOT become a remote primitive — an attacker must already be on
// the loopback interface (i.e., have shell on the box).
//
// RUNTIME ASSUMPTION: if this helper ever moves to a different runtime
// (Edge, Workers) that exposes `:authority` separately from `host`,
// ALSO check that pseudo-header before trusting the request as loopback.

const BEARER_RE = /^Bearer ([A-Za-z0-9+/=._~-]+)$/
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?$/

export function isLoopbackInternalRequest(req: Request): boolean {
  const host = (req.headers.get('host') ?? '').toLowerCase()
  if (!LOOPBACK_HOST_RE.test(host)) return false

  const auth = req.headers.get('authorization') ?? ''
  const m = BEARER_RE.exec(auth)
  const expected = Buffer.from(env.INTERNAL_REVALIDATE_SECRET, 'utf8')
  const raw = m && m[1] ? m[1] : ''
  const presented = Buffer.from(raw, 'utf8')
  const padded = Buffer.alloc(expected.length)
  presented.copy(padded, 0, 0, Math.min(presented.length, expected.length))
  const eq = timingSafeEqual(padded, expected)
  return presented.length === expected.length && eq
}

export function jsonInternal(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
}
