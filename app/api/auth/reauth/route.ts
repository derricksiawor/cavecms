import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireRole, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { verifyPassword, getDummyScryptHash } from '@/lib/auth/scrypt'
import { rateLimit } from '@/lib/auth/rateLimit'
import { setFreshReauth } from '@/lib/auth/reauth'
import { clientIpFromHeaders } from '@/lib/http/clientIp'

// Step-up reauth endpoint. Admin re-types their password to unlock
// the next 5 minutes of admin-only mutations (users, settings).
//
// Two-layer rate-limiting:
//   - per-user (5/min): a stolen session cookie lets an attacker hit
//     this endpoint to brute-force the password; scrypt's ~150ms cost
//     alone allows ~400/min uncapped.
//   - per-IP (10/min): a hostile IP rotating session cookies (e.g. an
//     attacker who's compromised multiple sessions from the same
//     browser farm) can't burn through one bucket per user.
// Both must pass. Per-user uses ctx.userId; per-IP reads from the
// forwarded-for chain via the project's clientIpFromHeaders helper.
const reauthRateByUser = rateLimit('auth:reauth:user', {
  limit: 5,
  windowSec: 60,
})
const reauthRateByIp = rateLimit('auth:reauth:ip', {
  limit: 10,
  windowSec: 60,
})

// Password length cap (200) mirrors lib/auth/login: rejects payloads
// large enough to cause scrypt OOM without making the input field
// feel cramped.
const Body = z.object({ password: z.string().min(1).max(200) }).strict()

export const POST = withError(async (req: Request) => {
  const ctx = await requireRole(['admin'])
  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  // Fall back to '0.0.0.0' for bucketing when no trusted IP was
  // recovered — same convention the rest of the project uses, and
  // matches the audit_log fallback so the buckets line up with
  // forensic queries.
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!reauthRateByUser(String(ctx.userId))) {
    throw new HttpError(429, 'rate_limited')
  }
  if (!reauthRateByIp(ip)) {
    throw new HttpError(429, 'rate_limited')
  }

  const { password } = Body.parse(await readJsonBody(req))

  const [rows] = (await db.execute(
    sql`SELECT password_hash FROM users WHERE id = ${ctx.userId} LIMIT 1`,
  )) as unknown as [Array<{ password_hash: string }>]
  // Constant-time path even when the row vanished mid-session — uses
  // the same dummy hash machinery as login so timing doesn't reveal
  // "deleted user" vs "wrong password".
  const hash = rows[0]?.password_hash ?? (await getDummyScryptHash())
  const ok = await verifyPassword(password, hash)
  // Important: both branches must take comparable time. verifyPassword
  // already runs scrypt before timing-safe compare; the dummy hash
  // path runs the same scrypt cost.
  if (!rows[0] || !ok) throw new HttpError(401, 'invalid_password')

  await setFreshReauth(ctx.jti)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  })
})
