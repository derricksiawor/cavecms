import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { compileRules, matchRedirect, type RedirectRule } from '@/lib/cms/redirects'

const Body = z.object({ url: z.string().min(1).max(2048) }).strict()

interface Row {
  id: number
  source: string
  match_type: RedirectRule['matchType']
  action: RedirectRule['action']
  target: string | null
  status_code: number | null
  query_handling: RedirectRule['queryHandling']
  case_insensitive: number
}

export const POST = withError(async (req) => {
  const ctx = await requireRole(['admin'])
  checkReadRate(ctx.userId)
  const { url } = Body.parse(await readJsonBody(req))
  // Accept a full URL or a bare path.
  let pathname = url
  let search = ''
  try {
    const u = new URL(url, 'http://x')
    pathname = u.pathname
    search = u.search
  } catch {
    const qi = url.indexOf('?')
    if (qi >= 0) {
      pathname = url.slice(0, qi)
      search = url.slice(qi)
    }
  }
  const [rows] = (await db.execute(sql`
    SELECT id, source, match_type, action, target, status_code, query_handling, case_insensitive
    FROM redirects WHERE enabled = 1 ORDER BY position ASC, id ASC
  `)) as unknown as [Row[]]
  const compiled = compileRules(
    rows.map((r) => ({
      id: r.id,
      source: r.source,
      matchType: r.match_type,
      action: r.action,
      target: r.target,
      statusCode: r.status_code,
      queryHandling: r.query_handling,
      caseInsensitive: r.case_insensitive === 1,
    })),
  )
  const hit = matchRedirect(compiled, pathname, search)
  return new Response(JSON.stringify({ result: hit }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
