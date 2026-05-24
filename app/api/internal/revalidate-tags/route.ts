import { timingSafeEqual } from 'node:crypto'
import { revalidateTag } from 'next/cache'
import { z } from 'zod'
import { env } from '@/lib/env'

// Internal cache-invalidation proxy. Mounted at `/api/internal/revalidate-tags`.
//
// Why this exists: `revalidateTag` from `next/cache` requires Next's
// `workAsyncStorage` to be populated, which only happens inside a server-
// component / route-handler / server-action request lifecycle. Calling it
// from a plain Node CLI process (e.g. `tsx scripts/cron-purge.ts`)
// invariant-throws (`static generation store missing in revalidateTag …`).
// `scripts/cron-purge.ts` POSTs each batch of tags here over loopback so
// the call lands inside a real Next request and the work store is live.
//
// Auth model:
//   - Bearer token via `Authorization: Bearer ${INTERNAL_REVALIDATE_SECRET}`.
//     The secret is a >=32-char printable-ASCII value distinct from
//     JWT/CSRF/PREVIEW/BROCHURE per project standards Security Standards
//     "separate secrets per concern". `instrumentation.ts` refuses boot
//     if any duplicate the others.
//   - Bearer regex constrained to RFC 6750 `b64token` charset so
//     malformed or exotic header values short-circuit cleanly.
//   - Constant-time-padded length comparison defends the per-request
//     work pattern against length-probing side channels (a remote
//     attacker who can issue arbitrary requests would otherwise see a
//     wrong-length token return faster than a wrong-value-right-length
//     token; the pad-then-compare path runs identical work for both).
//   - No CSRF (bearer-authed, not cookie/session-authed). The project's
//     CSRF gate is per-handler — this route simply doesn't call
//     requireCsrf.
//   - No middleware auth interference: `middleware.ts:authGate` only
//     fires on `/admin`, `/api/cms/*`, `/api/admin/*`, and
//     `/api/auth/logout`. `/api/internal/*` passes through cleanly.
//   - robots.txt emits `Disallow: /api/` (covers `/api/internal/*`).
//
// Defence in depth: nginx `location ^~ /api/internal/ { allow 127.0.0.1;
// allow ::1; deny all; }` (see `scripts/nginx/bwc.conf.template`) drops
// external traffic at the edge so the bearer-token gate is the
// SECONDARY layer, not the only one. A leaked secret OR an auth
// regression in this handler does NOT become a remote cache-flush
// primitive — an attacker must already be on the loopback interface
// (i.e., have shell on the box) for the bearer check to be reachable.
//
// Payload shape: `{ tags: string[] }`. We cap at 500 tags per request to
// bound the worst-case work performed by a single fetch; the cron's own
// backpressure already chunks at 50, so this is a generous ceiling. Each
// tag is constrained to 1–200 chars (the longest tag the project emits
// today is `page-slug-resolver:<slug>` with a 120-char slug → 140 chars).

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  tags: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(500),
})

// RFC 6750 §2.1 b64token charset: ALPHA / DIGIT / "-" / "." / "_" / "~"
// / "+" / "/" / "=". Anything outside this set is non-compliant and
// short-circuits before reaching `timingSafeEqual`.
const BEARER_RE = /^Bearer ([A-Za-z0-9+/=._~-]+)$/

// Loopback-host defence in depth — mirrors the sibling
// `/api/internal/security-config` check. nginx upstream blocks already
// restrict this route to loopback, but a future infra change (block
// removed, CDN added) plus a leaked INTERNAL_REVALIDATE_SECRET would
// otherwise turn a bearer-only auth into a remote primitive for
// cache-eviction DoS. Tested against `host` because nginx + Node both
// fold HTTP/2 :authority into that header.
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?$/

function authorized(req: Request): boolean {
  // Hostname check FIRST — short-circuits before crypto work for the
  // dominant rejected case.
  const host = (req.headers.get('host') ?? '').toLowerCase()
  if (!LOOPBACK_HOST_RE.test(host)) return false

  const auth = req.headers.get('authorization') ?? ''
  const m = BEARER_RE.exec(auth)
  const expected = Buffer.from(env.INTERNAL_REVALIDATE_SECRET, 'utf8')
  // Constant-time-padded comparison: regardless of whether the regex
  // matched and regardless of presented length, we always do the same
  // amount of work — pad the candidate to `expected.length`, then
  // timingSafeEqual against `expected`, then AND the result with a
  // boolean recording whether the original length matched. A remote
  // observer cannot distinguish wrong-length from wrong-value timing.
  const raw = m && m[1] ? m[1] : ''
  const presented = Buffer.from(raw, 'utf8')
  const padded = Buffer.alloc(expected.length)
  presented.copy(padded, 0, 0, Math.min(presented.length, expected.length))
  const eq = timingSafeEqual(padded, expected)
  const sameLen = presented.length === expected.length
  return sameLen && eq
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
}

function logEvent(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra: Record<string, unknown> = {},
): void {
  const out = JSON.stringify({
    level,
    route: 'api/internal/revalidate-tags',
    msg,
    ...extra,
  })
  if (level === 'error') console.error(out)
  else console.log(out)
}

export async function POST(req: Request): Promise<Response> {
  // `x-forwarded-for` is set by nginx when the upstream is proxied.
  // Loopback POSTs from the cron arrive WITHOUT this header (the cron
  // bypasses nginx). Logging it lets an operator distinguish
  // "internal call" (no XFF) from "external call that nginx routed
  // for some misconfigured reason" (XFF set) — a useful tripwire if
  // the nginx allow/deny block ever drifts.
  const fwd = req.headers.get('x-forwarded-for')

  if (!authorized(req)) {
    logEvent('warn', 'unauthorized', { xForwardedFor: fwd ?? null })
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    logEvent('warn', 'invalid_json', { xForwardedFor: fwd ?? null })
    return jsonResponse({ error: 'invalid_json' }, 400)
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    logEvent('warn', 'invalid_payload', { xForwardedFor: fwd ?? null })
    return jsonResponse({ error: 'invalid_payload' }, 400)
  }

  let failed = 0
  const failedTags: string[] = []
  for (const t of parsed.data.tags) {
    try {
      revalidateTag(t)
    } catch (err) {
      failed += 1
      failedTags.push(t)
      logEvent('error', 'internal_revalidate_tag_failed', {
        tag: t,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logEvent('info', 'completed', {
    total: parsed.data.tags.length,
    failed,
    xForwardedFor: fwd ?? null,
  })

  return jsonResponse(
    {
      ok: failed === 0,
      total: parsed.data.tags.length,
      failed,
      // Surface the failed tags so the cron can log them in a single
      // structured line rather than scraping stderr. Capped at the same
      // 500 ceiling as the input.
      ...(failed > 0 ? { failedTags } : {}),
    },
    failed === 0 ? 200 : 207,
  )
}
