import { timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { env } from '@/lib/env'
import { db } from '@/db/client'
import { rulesetEtag, type RedirectRule } from '@/lib/cms/redirects'

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

interface Row {
  id: number
  source: string
  match_type: RedirectRule['matchType']
  action: RedirectRule['action']
  target: string | null
  status_code: number | null
  query_handling: RedirectRule['queryHandling']
  case_insensitive: number
  updated_at: string | Date
}

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    })
  }
  const [rows] = (await db.execute(sql`
    SELECT id, source, match_type, action, target, status_code,
           query_handling, case_insensitive, updated_at
    FROM redirects
    WHERE enabled = 1
    ORDER BY position ASC, id ASC
  `)) as unknown as [Row[]]

  let maxUpdated = 0
  const rules: RedirectRule[] = rows.map((r) => {
    const t = new Date(r.updated_at).getTime()
    if (t > maxUpdated) maxUpdated = t
    return {
      id: r.id,
      source: r.source,
      matchType: r.match_type,
      action: r.action,
      target: r.target,
      statusCode: r.status_code,
      queryHandling: r.query_handling,
      caseInsensitive: r.case_insensitive === 1,
    }
  })

  return new Response(
    JSON.stringify({ etag: rulesetEtag(rules.length, maxUpdated), rules }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    },
  )
}
