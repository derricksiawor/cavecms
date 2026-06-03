import { timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import { db } from '@/db/client'

// Loopback hit-counter. The Edge middleware fires a non-blocking POST here
// (via event.waitUntil) when a redirect matches. Same loopback + bearer
// guard as the other /api/internal/* endpoints.

export const dynamic = 'force-dynamic'

const BEARER_RE = /^Bearer ([A-Za-z0-9+/=._~-]+)$/
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?::\d+)?$/

function authorized(req: Request): boolean {
  const host = (req.headers.get('host') ?? '').toLowerCase()
  if (!LOOPBACK_HOST_RE.test(host)) return false
  const m = BEARER_RE.exec(req.headers.get('authorization') ?? '')
  const expected = Buffer.from(env.INTERNAL_REVALIDATE_SECRET, 'utf8')
  const presented = Buffer.from(m && m[1] ? m[1] : '', 'utf8')
  const padded = Buffer.alloc(expected.length)
  presented.copy(padded, 0, 0, Math.min(presented.length, expected.length))
  return presented.length === expected.length && timingSafeEqual(padded, expected)
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 401 })
  let id = 0
  try {
    const body = (await req.json()) as { id?: unknown }
    id = typeof body.id === 'number' && Number.isInteger(body.id) ? body.id : 0
  } catch {
    id = 0
  }
  if (id > 0) {
    try {
      // `updated_at = updated_at` explicitly preserves the column so the
      // ON UPDATE CURRENT_TIMESTAMP auto-bump does NOT fire — otherwise
      // every hit would advance the feed etag (max(updated_at)) and defeat
      // the middleware's compiled-ruleset reuse. Hit counting is best-effort
      // telemetry, so a failed bump is swallowed (always return 204).
      await db.execute(sql`
        UPDATE redirects
        SET hit_count = hit_count + 1, last_hit_at = NOW(3), updated_at = updated_at
        WHERE id = ${id}
      `)
    } catch {
      // best-effort — never surface a 500 that spams logs on every hit
    }
  }
  return new Response(null, { status: 204 })
}
