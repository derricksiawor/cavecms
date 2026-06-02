import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole } from '@/lib/auth/requireRole'
import { checkReadRate } from '@/lib/auth/cmsRateLimit'
import { compileRules, matchRedirect, rowToRule, type RedirectFeedRow } from '@/lib/cms/redirects'

const Body = z.object({ url: z.string().min(1).max(2048) }).strict()

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
    LIMIT 5000
  `)) as unknown as [RedirectFeedRow[]]
  const compiled = compileRules(rows.map(rowToRule))
  const hit = matchRedirect(compiled, pathname, search)
  return new Response(JSON.stringify({ result: hit }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
