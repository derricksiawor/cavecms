import { cookies } from 'next/headers'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { withError } from '@/lib/api/withError'
import { readJsonBody } from '@/lib/api/jsonBody'
import { requireAuth, HttpError } from '@/lib/auth/requireRole'
import { requireCsrf } from '@/lib/auth/requireCsrf'
import { hashPassword, verifyPassword, getDummyScryptHash } from '@/lib/auth/scrypt'
import { signSessionJwt } from '@/lib/auth/sign-session-jwt'
import { issueCsrf } from '@/lib/auth/csrf'
import { invalidateUser } from '@/lib/auth/userCache'
import { rateLimit } from '@/lib/auth/rateLimit'
import { clientIpFromHeaders } from '@/lib/http/clientIp'
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  JTI_COOKIE,
  cookieFlags,
  csrfCookieFlags,
  jtiCookieFlags,
  isSecureRequest,
} from '@/lib/auth/cookies'
import { getSetting } from '@/lib/cms/getSettings'

// Self-service "change my own password" — the standing, voluntary flow any
// logged-in user (admin / editor / viewer) uses to change THEIR OWN password.
// Distinct from:
//   - /api/auth/rotate  — FORCED rotation, only for pwp (must-rotate) sessions.
//   - /api/admin/users/[id] PATCH — an ADMIN setting ANOTHER user's password
//     (blocks self with cannot_modify_self).
// This route fills the gap those two leave: a normal user changing their own
// password without admin involvement and without being in the forced-rotation
// state.
//
// Auth model — verify-current-password IS the gate:
//   - requireAuth(): must carry a valid session cookie (logged in).
//   - The body's `currentPassword` is verified against the stored hash. This
//     is the per-action proof of identity (equivalent to the step-up reauth
//     used elsewhere), so no separate reauth cookie is required — which also
//     sidesteps the cookie-scoping quirks some hosts impose.
//   - CSRF double-submit is enforced.
//   - Two rate-limit buckets cap brute-force on the current-password check.
//   - API-token (Bearer) requests are refused — a non-interactive token must
//     never change a human's password.

const Body = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(12, 'min_12_chars').max(200, 'max_200_chars'),
  })
  .strict()

const changeRateByUser = rateLimit('auth:change-password:user', { limit: 5, windowSec: 300 })
const changeRateByIp = rateLimit('auth:change-password:ip', { limit: 10, windowSec: 300 })

export const POST = withError(async (req: Request) => {
  const ctx = await requireAuth()

  // A Bearer API token must never change a human's password.
  if (ctx.viaApiToken) throw new HttpError(403, 'forbidden')

  await requireCsrf(req, { jti: ctx.jti, userId: ctx.userId })

  const headerObj: Record<string, string | undefined> = {}
  req.headers.forEach((v, k) => {
    headerObj[k] = v
  })
  const ip = clientIpFromHeaders(headerObj, '127.0.0.1') ?? '0.0.0.0'
  if (!changeRateByUser(String(ctx.userId))) throw new HttpError(429, 'rate_limited')
  if (!changeRateByIp(ip)) throw new HttpError(429, 'rate_limited')

  const parsed = Body.safeParse(await readJsonBody(req))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message
    throw new HttpError(400, issue === 'min_12_chars' ? 'password_too_short' : 'invalid_body')
  }
  const { currentPassword, newPassword } = parsed.data

  // Verify the current password against the stored hash. Constant-time
  // dummy-hash path if the row vanished mid-session (matches login/reauth so
  // timing never reveals "deleted user").
  const [rows] = (await db.execute(
    sql`SELECT password_hash FROM users WHERE id = ${ctx.userId} LIMIT 1`,
  )) as unknown as [Array<{ password_hash: string }>]
  const storedHash = rows[0]?.password_hash ?? (await getDummyScryptHash())
  const currentOk = await verifyPassword(currentPassword, storedHash)
  // Also compute new-vs-current to refuse a no-op change; do it BEFORE the
  // existence branch so both code paths take comparable time.
  const sameAsCurrent = await verifyPassword(newPassword, storedHash)
  if (!rows[0] || !currentOk) throw new HttpError(401, 'invalid_current_password')
  if (sameAsCurrent) throw new HttpError(400, 'same_password')

  const newHash = await hashPassword(newPassword)

  // Set the new password AND revoke every token issued at-or-before now (so a
  // stolen/older session on another device is logged out). -2s buffer matches
  // the JWT clockTolerance so the FRESH token signed just below (iat = now) is
  // not caught by the tokens_valid_after revocation check.
  const tva = new Date(Date.now() - 2000)
  await db.execute(sql`
    UPDATE users
    SET password_hash = ${newHash},
        must_rotate_password = ${false},
        tokens_valid_after = ${tva}
    WHERE id = ${ctx.userId}
  `)
  invalidateUser(ctx.userId)

  // Re-issue THIS session in the same response so the user stays logged in on
  // this device while every other session is invalidated.
  const { token, jti, iat, exp } = await signSessionJwt(String(ctx.userId), { pwp: false })
  const csrfToken = await issueCsrf({ jti, sub: String(ctx.userId) })
  const secure = isSecureRequest(req)
  const c = await cookies()
  c.set(SESSION_COOKIE, token, cookieFlags(exp - iat, secure))
  const csrfCookieTtl = (await getSetting('session_config')).csrfTtlSec
  c.set(CSRF_COOKIE, csrfToken, csrfCookieFlags(csrfCookieTtl, secure))
  c.set(JTI_COOKIE, jti, jtiCookieFlags(exp - iat, secure))

  return new Response(JSON.stringify({ ok: true, csrf: csrfToken }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
})
