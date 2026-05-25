import { cookies, headers } from 'next/headers'
import { withError } from '@/lib/api/withError'
import { requireAuth } from '@/lib/auth/requireRole'
import { issueCsrf } from '@/lib/auth/csrf'
import { rateLimit } from '@/lib/auth/rateLimit'
import { CSRF_COOKIE, csrfCookieFlags } from '@/lib/auth/cookies'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import { getSetting } from '@/lib/cms/getSettings'

// Gold-Standard rule (project standards "Security Standards"): "Rate limit the
// CSRF endpoint itself (30 req/min per IP)." Two buckets so a stolen
// session cookie (userId-bucket pull) AND a single bad IP (IP-bucket
// pull) both hit a 30/min ceiling. Either trip → 429.
const ipLimit = rateLimit('csrf:ip', { limit: 30, windowSec: 60 })
const userLimit = rateLimit('csrf:user', { limit: 30, windowSec: 60 })

export const GET = withError(async () => {
  const ctx = await requireAuth()
  const h = await headers()
  const headerObj: Record<string, string | undefined> = {}
  h.forEach((v, k) => { headerObj[k] = v })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!ipLimit(ip) || !userLimit(String(ctx.userId))) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 })
  }
  const csrf = await issueCsrf({ jti: ctx.jti, sub: String(ctx.userId) })
  const c = await cookies()
  const sessCfg = await getSetting('session_config')
  c.set(CSRF_COOKIE, csrf, csrfCookieFlags(sessCfg.csrfTtlSec))
  return new Response(JSON.stringify({ csrf }), {
    status: 200,
    headers: { 'cache-control': 'private, no-store' },
  })
})
