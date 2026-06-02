import { timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import { db } from '@/db/client'
import { rulesetEtag, rowToRule, type RedirectFeedRow, type RedirectRule } from '@/lib/cms/redirects'

// Internal middleware-feeding endpoint. The Edge middleware can't call
// Drizzle directly, so it pulls the enabled redirect ruleset over loopback
// (cached module-level ~30s). Auth + loopback model identical to
// /api/internal/security-config.

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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
}

interface FeedRow extends RedirectFeedRow {
  updated_at: string | Date
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return jsonResponse({ error: 'unauthorized' }, 401)

  let rows: FeedRow[]
  try {
    // Defensive LIMIT: operator rule counts are small (tens–hundreds); the
    // cap stops a runaway table from ever shipping a giant payload + an
    // unbounded per-request matcher loop.
    const [r] = (await db.execute(sql`
      SELECT id, source, match_type, action, target, status_code,
             query_handling, case_insensitive, updated_at
      FROM redirects
      WHERE enabled = 1
      ORDER BY position ASC, id ASC
      LIMIT 5000
    `)) as unknown as [FeedRow[]]
    rows = r
  } catch {
    // DB hiccup → 503 so the middleware keeps its last-known-good ruleset
    // (it treats any non-2xx as "reuse cache"). Never throw a framework 500
    // that spams logs every 30s during an outage.
    return jsonResponse({ error: 'unavailable' }, 503)
  }

  let maxUpdated = 0
  const rules: RedirectRule[] = rows.map((r) => {
    const t = new Date(r.updated_at).getTime()
    if (t > maxUpdated) maxUpdated = t
    return rowToRule(r)
  })

  return jsonResponse({ etag: rulesetEtag(rules.length, maxUpdated), rules }, 200)
}
